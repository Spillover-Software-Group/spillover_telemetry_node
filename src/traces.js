// Traces go to the OTLP endpoint, which on the platform is the host's collector, forwarding to
// X-Ray. Nothing OpenTelemetry is imported until this runs, so a process with no endpoint loads none
// of it.
export async function installTraces({ contextManager } = {}) {
  const { register } = await import("node:module");
  // The applications are ES modules, whose imports the instrumentations see only through
  // import-in-the-middle's loader hook, registered before the application's first import.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [
    api,
    { NodeSDK },
    { OTLPTraceExporter },
    { HttpInstrumentation },
    { UndiciInstrumentation },
    { ExpressInstrumentation },
    { KoaInstrumentation },
    { MongoDBInstrumentation },
    { IORedisInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/instrumentation-express"),
    import("@opentelemetry/instrumentation-koa"),
    import("@opentelemetry/instrumentation-mongodb"),
    import("@opentelemetry/instrumentation-ioredis"),
  ]);

  const sdk = new NodeSDK({
    // Reads OTEL_EXPORTER_OTLP_ENDPOINT and sends to its /v1/traces. The service name is the SDK's
    // own OTEL_SERVICE_NAME, never a string here.
    traceExporter: new OTLPTraceExporter(),
    // Traces only: CloudWatch has the metrics (embedded in the log) and the logs.
    metricReaders: [],
    logRecordProcessors: [],
    contextManager,
    // A worker talks to Redis and Mongo all the time on its own account: BullMQ's blocking reads,
    // lock renewals, stalled checks, a dispatcher's polls. None of that starts a trace. A call is
    // traced only inside something already traced, a request or a job (runJob), so a trace is a
    // unit of work and not a heartbeat. The health check is the proxy and the load balancer asking
    // every few seconds, and answers nothing a trace could add to.
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) =>
          request.url === "/health" || request.url?.startsWith("/health?"),
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
