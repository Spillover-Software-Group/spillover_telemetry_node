import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { recordingServer, runFixture } from "./helpers/process.js";

let collector;
let target;
let spans;
let withSentry;

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

  await runFixture("requests.js", {
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
    OTEL_SERVICE_NAME: "senalysis-api",
    TRACES_IGNORED_PATHS: "/api/health,/socket.io/",
    FIXTURE_TARGET: target.url,
  });

  spans = exportedSpans(collector.requests);

  // The same with errors on as well, as every application on the platform runs.
  const both = await recordingServer();
  const sentry = await recordingServer();
  await runFixture("requests.js", {
    OTEL_EXPORTER_OTLP_ENDPOINT: both.url,
    OTEL_SERVICE_NAME: "senalysis-api",
    TRACES_IGNORED_PATHS: "/api/health,/socket.io/",
    FIXTURE_TARGET: target.url,
    SENTRY_DSN: `${sentry.url.replace("http://", "http://publickey@")}/1`,
  });
  withSentry = exportedSpans(both.requests);
  await both.close();
  await sentry.close();
});

after(async () => {
  await collector.close();
  await target.close();
});

function attribute(span, key) {
  return span.attributes.find((a) => a.key === key)?.value;
}

function incoming(path) {
  return spans.filter(
    (span) =>
      span.kind === SPAN_KIND_SERVER &&
      attribute(span, "url.path")?.stringValue === path,
  );
}

function action(name) {
  return spans.find((span) => span.name === name);
}

// OTLP's numbering of span kinds and statuses.
const SPAN_KIND_SERVER = 2;
const STATUS_ERROR = 2;

test("a request for an ignored path starts no trace", () => {
  assert.equal(incoming("/api/health").length, 0);
});

test("an ignored entry ending in a slash covers every path under it", () => {
  assert.equal(incoming("/socket.io/").length, 0);
});

test("a request for any other path is traced", () => {
  assert.equal(incoming("/api/things").length, 1);
});

test("a unit of work started with startRequest is a SERVER span", () => {
  assert.equal(action("socket POSTS_GET")?.kind, SPAN_KIND_SERVER);
});

test("its annotations are attributes and X-Ray annotations", () => {
  const span = action("socket POSTS_GET");

  assert.deepEqual(
    {
      action: attribute(span, "action")?.stringValue,
      annotations: attribute(
        span,
        "aws.xray.annotations",
      )?.arrayValue?.values?.map((value) => value.stringValue),
    },
    { action: "POSTS_GET", annotations: ["action"] },
  );
});

test("an annotation key X-Ray would refuse is left out", () => {
  assert.equal(attribute(action("socket POSTS_GET"), "not a key"), undefined);
});

test("a call made inside its run is a span of its trace", () => {
  const call = spans.find((span) =>
    attribute(span, "url.full")?.stringValue?.endsWith("/inside-an-action"),
  );

  assert.equal(call?.traceId, action("socket POSTS_GET").traceId);
});

test("a unit ended with an error is a failed span", () => {
  assert.equal(action("socket POSTS_ADD")?.status?.code, STATUS_ERROR);
});

test("with errors on too, an ignored path still starts no trace", () => {
  assert.equal(
    withSentry.filter(
      (span) => attribute(span, "url.path")?.stringValue === "/api/health",
    ).length,
    0,
  );
});

test("with errors on too, a request is one SERVER span, not one from each SDK", () => {
  assert.equal(
    withSentry.filter(
      (span) =>
        span.kind === SPAN_KIND_SERVER &&
        attribute(span, "url.path")?.stringValue === "/api/things",
    ).length,
    1,
  );
});
