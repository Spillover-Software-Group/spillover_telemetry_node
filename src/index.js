import { createLogger } from "./logger.js";
import { readSettings } from "./settings.js";
import { state } from "./state.js";

export {
  captureError,
  captureJobFailure,
  clientAddress,
  identifyUser,
  isFinalFailure,
} from "./errors.js";
export { bridgeConsole, createLogger } from "./logger.js";
export {
  bullmqCollector,
  emfDocument,
  runtimeCollector,
  startMetrics,
} from "./metrics.js";
export { redactCredentials } from "./redact.js";
export { startRequest } from "./requests.js";
export { readSettings } from "./settings.js";

// The logger register set up, or, in a process started without it, one made from the environment.
export function getLogger() {
  state.logger ??= createLogger(state.settings ?? readSettings());
  return state.logger;
}

function traced({ queue, name, id }, fn) {
  const { tracer, api } = state;
  if (!tracer) return fn();

  const attributes = {
    "messaging.system": "bullmq",
    "messaging.destination.name": queue,
    "messaging.operation.type": "process",
    "messaging.message.id": String(id),
    // The same three under names X-Ray accepts as annotation keys (letters, digits, underscores),
    // and the list the exporter reads to index them, so `annotation.job_name = "messages.fetch"`
    // finds a task's traces without a change to the collector.
    job_queue: queue,
    job_name: name,
    job_id: String(id),
    "aws.xray.annotations": ["job_queue", "job_name", "job_id"],
  };

  // SERVER, not CONSUMER, which the semantic conventions would say: X-Ray's exporter names a root
  // segment after the service only for a SERVER span, and after the span otherwise, which filed
  // every task as a service of its own and hid all of them from a search by the application's name.
  return tracer.startActiveSpan(
    `${queue} ${name}`,
    { kind: api.SpanKind.SERVER, attributes },
    async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.recordException(error);
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: error.message,
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

// Runs one job as a unit of its own: a trace of its own, whose Redis, Mongo and HTTP calls are its
// spans, and a Sentry scope tagged with its queue, name and id, so an error raised inside names the
// job it happened in.
export async function runJob(job, fn) {
  const { Sentry } = state;
  if (!Sentry) return await traced(job, fn);

  return await Sentry.withIsolationScope(async (scope) => {
    scope.setTags({ queue: job.queue, job: job.name, job_id: String(job.id) });
    return await traced(job, fn);
  });
}

// Sends what is still buffered before the process exits: queued Sentry events, and the spans the
// batch processor has not exported yet. What cannot be sent is said, in the log, rather than lost
// without a word.
export async function flushTelemetry(timeoutMs = 2000) {
  const [errors, traces] = await Promise.allSettled([
    state.Sentry?.flush(timeoutMs),
    state.sdk?.shutdown(),
  ]);

  if (errors.status === "rejected" || errors.value === false) {
    getLogger().warn(
      { component: "sentry", err: errors.reason },
      "Sentry could not send its queued events before exit",
    );
  }
  if (traces.status === "rejected") {
    getLogger().warn(
      { component: "opentelemetry", err: traces.reason },
      "OpenTelemetry could not send its buffered spans before exit",
    );
  }
}
