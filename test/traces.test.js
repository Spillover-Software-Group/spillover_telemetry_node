import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { recordingServer, runFixture } from "./helpers/process.js";

let collector;
let target;
let spans;
let output;
let dependencySpans;

// The spans a fixture's process exported, read from the OTLP requests the collector stand-in got.
function exportedSpans(requests) {
  return requests
    .filter(({ path }) => path === "/v1/traces")
    .flatMap(({ body }) => JSON.parse(body).resourceSpans)
    .flatMap(({ scopeSpans }) => scopeSpans)
    .flatMap(({ spans: batch }) => batch);
}

before(async () => {
  collector = await recordingServer();
  target = await recordingServer();

  ({ stdout: output } = await runFixture("traces.js", {
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
    OTEL_SERVICE_NAME: "senalysis-data-exchange",
    FIXTURE_TARGET: target.url,
  }));

  spans = exportedSpans(collector.requests);

  const dependencies = await recordingServer();
  await runFixture("dependencies.js", {
    OTEL_EXPORTER_OTLP_ENDPOINT: dependencies.url,
    OTEL_SERVICE_NAME: "senalysis-data-exchange",
  });
  dependencySpans = exportedSpans(dependencies.requests);
  await dependencies.close();
});

after(async () => {
  await collector.close();
  await target.close();
});

function attribute(span, key) {
  return span.attributes.find((a) => a.key === key)?.value?.stringValue;
}

function jobSpan() {
  return spans.find(({ name }) => name === "google reviews.fetch");
}

// OTLP's numbering of span kinds.
const SPAN_KIND_SERVER = 2;

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

test("a process whose exports succeed writes no OpenTelemetry line", () => {
  const lines = output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.deepEqual(
    lines.filter((line) => line.component === "opentelemetry"),
    [],
  );
});

// X-Ray's exporter names a root segment after the service only for a SERVER span; any other kind is
// named after the span, which files every task as a service of its own.
test("a job's span is SERVER kind, so X-Ray files it under the service", () => {
  assert.equal(jobSpan().kind, SPAN_KIND_SERVER);
});

test("a job's span carries its queue, task and id under annotation-safe names", () => {
  const job = jobSpan();

  assert.deepEqual(
    ["job_queue", "job_name", "job_id"].map((key) => attribute(job, key)),
    ["google", "reviews.fetch", "9"],
  );
});

test("a job's span asks X-Ray's exporter to index those three as annotations", () => {
  const listed = jobSpan()
    .attributes.find((a) => a.key === "aws.xray.annotations")
    ?.value?.arrayValue?.values?.map((value) => value.stringValue);

  assert.deepEqual(listed, ["job_queue", "job_name", "job_id"]);
});

test("a job is a BullMQ job unless it names its library", () => {
  assert.equal(attribute(jobSpan(), "messaging.system"), "bullmq");
});

test("a job that names its library carries that name", () => {
  const pulseJob = spans.find(({ name }) => name === "pulse items.unsnooze");

  assert.equal(attribute(pulseJob, "messaging.system"), "pulse");
});

test("an outbound call inside a job names its host as the dependency", () => {
  const call = spans.find((span) =>
    attribute(span, "url.full")?.endsWith("/inside-a-job"),
  );

  assert.equal(attribute(call, "peer.service"), "127.0.0.1");
});

function dependencyOf(name) {
  const span = dependencySpans.find((candidate) => candidate.name === name);
  return attribute(span, "peer.service");
}

test("a Mongo call names mongodb as the dependency", () => {
  assert.equal(dependencyOf("find social_media_accounts"), "mongodb");
});

test("a Redis command names redis as the dependency", () => {
  assert.equal(dependencyOf("evalsha"), "redis");
});

test("a span that calls nothing outside names no dependency", () => {
  assert.equal(dependencyOf("classify sentiment"), undefined);
});
