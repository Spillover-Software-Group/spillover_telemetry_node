import { createLogger } from "./logger.js";
import { readSettings } from "./settings.js";
import { state } from "./state.js";

export {
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
  };

  return tracer.startActiveSpan(
    `${queue} ${name}`,
    { kind: api.SpanKind.CONSUMER, attributes },
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
// batch processor has not exported yet.
export async function flushTelemetry(timeoutMs = 2000) {
  await Promise.allSettled([
    state.Sentry?.flush(timeoutMs),
    state.sdk?.shutdown(),
  ]);
}
