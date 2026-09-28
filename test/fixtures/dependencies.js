// One job whose work calls Mongo and Redis, as the instrumentations start those spans, and does one
// piece of internal work that calls nothing.
import { SpanKind, trace } from "@opentelemetry/api";
import { flushTelemetry, runJob } from "../../src/index.js";

const tracer = trace.getTracer("fixture");

await runJob({ queue: "facebook", name: "messages.fetch", id: "1" }, () => {
  tracer
    .startSpan("find social_media_accounts", {
      kind: SpanKind.CLIENT,
      attributes: { "db.system.name": "mongodb", "db.namespace": "senalysis" },
    })
    .end();
  tracer
    .startSpan("evalsha", {
      kind: SpanKind.CLIENT,
      attributes: { "db.system.name": "redis" },
    })
    .end();
  tracer
    .startSpan("classify sentiment", {
      kind: SpanKind.INTERNAL,
      attributes: { "db.system.name": "mongodb" },
    })
    .end();
  return Promise.resolve();
});

await flushTelemetry();
