import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { recordingServer, runFixture } from "./helpers/process.js";

let collector;
let target;
let spans;

before(async () => {
  collector = await recordingServer();
  target = await recordingServer();

  await runFixture("traces.js", {
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
    OTEL_SERVICE_NAME: "senalysis-data-exchange",
    FIXTURE_TARGET: target.url,
  });

  spans = collector.requests
    .filter(({ path }) => path === "/v1/traces")
    .flatMap(({ body }) => JSON.parse(body).resourceSpans)
    .flatMap(({ scopeSpans }) => scopeSpans)
    .flatMap(({ spans: batch }) => batch);
});

after(async () => {
  await collector.close();
  await target.close();
});

function attribute(span, key) {
  return span.attributes.find((a) => a.key === key)?.value?.stringValue;
}

test("a job is a trace of its own", () => {
  assert.equal(
    spans.some(({ name }) => name === "google reviews.fetch"),
    true,
  );
});

test("a call made inside a job is a span of the job's trace", () => {
  const job = spans.find(({ name }) => name === "google reviews.fetch");
  const call = spans.find((span) =>
    attribute(span, "url.full")?.endsWith("/inside-a-job"),
  );

  assert.equal(call?.traceId, job.traceId);
});

test("a call made outside any job starts no trace", () => {
  assert.equal(
    spans.some((span) =>
      attribute(span, "url.full")?.endsWith("/outside-a-job"),
    ),
    false,
  );
});

test("only traces are sent: no metrics, no logs", () => {
  assert.deepEqual(
    [...new Set(collector.requests.map(({ path }) => path))],
    ["/v1/traces"],
  );
});
