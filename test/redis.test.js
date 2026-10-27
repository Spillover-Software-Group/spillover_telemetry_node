import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { recordingServer, runFixture } from "./helpers/process.js";

let collector;
let spans;
let sentToRedis;

before(async () => {
  collector = await recordingServer();
  const { stderr } = await runFixture("redis.js", {
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
    OTEL_SERVICE_NAME: "online-ordering-api",
  });

  spans = collector.requests
    .filter(({ path }) => path === "/v1/traces")
    .flatMap(({ body }) => JSON.parse(body).resourceSpans)
    .flatMap(({ scopeSpans }) => scopeSpans)
    .flatMap(({ spans: batch }) => batch);
  sentToRedis = JSON.parse(stderr.trim().split("\n").at(-1));
});

after(() => collector.close());

function attribute(span, key) {
  return span.attributes.find((a) => a.key === key)?.value?.stringValue;
}

const redisSpans = () =>
  spans.filter((span) => attribute(span, "db.system.name") === "redis");
const jobSpan = () => spans.find(({ name }) => name === "orders orders.create");

test("a node-redis command inside a job is a span of the job's trace", () => {
  const set = redisSpans().find(
    (span) => attribute(span, "db.operation.name") === "SET",
  );

  assert.equal(set?.traceId, jobSpan().traceId);
});

test("a node-redis command names redis as the dependency", () => {
  const get = redisSpans().find(
    (span) => attribute(span, "db.operation.name") === "GET",
  );

  assert.equal(attribute(get, "peer.service"), "redis");
});

test("a node-redis command's span records its name as the statement", () => {
  const statements = redisSpans().map((span) =>
    attribute(span, "db.query.text"),
  );

  assert.deepEqual(statements.sort(), ["GET", "SET"]);
});

// The stand-in was sent the key and the value, so their absence from the spans is the serializer's.
test("a node-redis command's keys and values reach no span", () => {
  const sentKeyAndValue = sentToRedis.some(
    (command) =>
      command.includes("order:lock:idem-key-123") &&
      command.includes("secret-value-456"),
  );
  const exported = JSON.stringify(spans);

  assert.deepEqual(
    {
      sentKeyAndValue,
      inSpans: [
        "order:lock:idem-key-123",
        "secret-value-456",
        "poshub:handoff:token-789",
      ].filter((secret) => exported.includes(secret)),
    },
    { sentKeyAndValue: true, inSpans: [] },
  );
});

test("a node-redis command outside a request or a job starts no trace", () => {
  assert.equal(redisSpans().length, 2);
});

// node-redis's instrumentation traces every connect as a span with nothing above it, whatever it is
// told; the export leaves those out.
test("connecting to Redis outside a request or a job sends no span", () => {
  assert.equal(
    spans.some(({ name }) => name === "redis-connect"),
    false,
  );
});
