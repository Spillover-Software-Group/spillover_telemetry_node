// Traces go to the OTLP endpoint, which on the platform is the host's collector, forwarding to
// X-Ray. Nothing OpenTelemetry is imported until this runs, so a process with no endpoint loads none
// of it.
// OpenTelemetry says what goes wrong only through its diag logger and its global error handler, and
// both are silent until set: an export that fails, every minute, for good, writes nothing. These
// route both into the application's JSON log, as lines of their own.
function reportThrough(logger, api, setGlobalErrorHandler) {
  const fields = { component: "opentelemetry" };

  setGlobalErrorHandler((error) => {
    logger.error(
      {
        ...fields,
        err: error instanceof Error ? error : new Error(String(error)),
      },
      "OpenTelemetry could not export or process spans",
    );
  });

  // Where the deploy names OTEL_LOG_LEVEL, the SDK sets its own logger at that level instead.
  if (process.env.OTEL_LOG_LEVEL) return;

  api.diag.setLogger(
    {
      error: (message, ...args) => logger.error({ ...fields, args }, message),
      warn: (message, ...args) => logger.warn({ ...fields, args }, message),
      info: (message, ...args) => logger.info({ ...fields, args }, message),
      debug: (message, ...args) => logger.debug({ ...fields, args }, message),
      verbose: (message, ...args) => logger.trace({ ...fields, args }, message),
    },
    api.DiagLogLevel.WARN,
  );
}

// X-Ray's exporter names a call's downstream node after its `peer.service`, and without one after the
// operation, so every Mongo query, Redis command and HTTP method became a service of its own on the
// map. This names the dependency instead: the database system for Mongo and Redis, the host for an
// outbound HTTP call. It runs as the span starts, where the instrumentations put those attributes.
function dependencyNamer(api) {
  return {
    onStart(span) {
      if (span.kind !== api.SpanKind.CLIENT) return;
      if (span.attributes["peer.service"] !== undefined) return;

      const dependency =
        span.attributes["db.system.name"] ??
        span.attributes["db.system"] ??
        span.attributes["server.address"];
      if (dependency !== undefined)
        span.setAttribute("peer.service", String(dependency));
    },
    onEnd: () => undefined,
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

// Whether an incoming request's path is one that starts no trace (settings' tracesIgnoredPaths).
export function isIgnoredPath(url, ignoredPaths) {
  const path = (url ?? "").split("?")[0];
  return ignoredPaths.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );
}

export async function installTraces({
  contextManager,
  logger,
  ignoredPaths = ["/health"],
} = {}) {
  const { register } = await import("node:module");
  // The applications are ES modules, whose imports the instrumentations see only through
  // import-in-the-middle's loader hook, registered before the application's first import.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [
    api,
    { setGlobalErrorHandler },
    { NodeSDK, tracing },
    { OTLPTraceExporter },
    { HttpInstrumentation },
    { UndiciInstrumentation },
    { ExpressInstrumentation },
    { KoaInstrumentation },
    { MongoDBInstrumentation },
    { IORedisInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/core"),
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/instrumentation-express"),
    import("@opentelemetry/instrumentation-koa"),
    import("@opentelemetry/instrumentation-mongodb"),
    import("@opentelemetry/instrumentation-ioredis"),
  ]);

  if (logger) reportThrough(logger, api, setGlobalErrorHandler);

  const sdk = new NodeSDK({
    // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT and sends to its /v1/traces, in batches the
    // processor sizes from the OTEL_BSP_* variables. The service name is the SDK's own
    // OTEL_SERVICE_NAME, never a string here.
    spanProcessors: [
      dependencyNamer(api),
      new tracing.BatchSpanProcessor(new OTLPTraceExporter()),
    ],
    // Traces only: CloudWatch has the metrics (embedded in the log) and the logs.
    metricReaders: [],
    logRecordProcessors: [],
    contextManager,
    // A worker talks to Redis and Mongo all the time on its own account: BullMQ's blocking reads,
    // lock renewals, stalled checks, a dispatcher's polls. None of that starts a trace. A call is
    // traced only inside something already traced, a request or a job (runJob), so a trace is a
    // unit of work and not a heartbeat. The health check is the proxy and the load balancer asking
    // every few seconds, and answers nothing a trace could add to; so is a transport's own polling.
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) =>
          isIgnoredPath(request.url, ignoredPaths),
        requireParentforOutgoingSpans: true,
      }),
      new UndiciInstrumentation({ requireParentforSpans: true }),
      new ExpressInstrumentation(),
      new KoaInstrumentation(),
      new MongoDBInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });

  sdk.start();

  return { sdk, api, tracer: api.trace.getTracer("@spillover/telemetry") };
}
