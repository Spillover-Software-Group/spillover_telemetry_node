import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  recordingServer,
  runFixture,
  sentryEvents,
} from "./helpers/process.js";

let sentry;
let requestEvent;
let jobEvents;

before(async () => {
  sentry = await recordingServer();
  const env = {
    SENTRY_DSN: `${sentry.url.replace("http://", "http://publickey@")}/1`,
    KAMAL_DESTINATION: "staging",
    KAMAL_VERSION: "abc123",
  };

  await runFixture("request-error.js", env);
  [requestEvent] = sentryEvents(sentry.requests);
  sentry.requests.length = 0;

  await runFixture("jobs.js", env);
  jobEvents = sentryEvents(sentry.requests);
});

after(() => sentry.close());

test("an error names the destination as its environment", () => {
  assert.equal(requestEvent.environment, "staging");
});

test("an error is filed under the release Kamal deployed", () => {
  assert.equal(requestEvent.release, "abc123");
});

test("of the request an error keeps the method, the URL without its query and the user agent", () => {
  assert.deepEqual(requestEvent.request, {
    method: "POST",
    url: requestEvent.request.url.split("?")[0],
    headers: { "User-Agent": "reports-client/1.0" },
  });
});

test("an error's request carries no query", () => {
  assert.equal(requestEvent.request.url.includes("?"), false);
});

// The event without the source lines Sentry shows around each stack frame: the fixture's own code
// names the secrets it sends, and that is the program's text, not the request's data.
function withoutSourceContext(event) {
  return JSON.stringify(event, (key, value) =>
    ["pre_context", "context_line", "post_context"].includes(key)
      ? undefined
      : value,
  );
}

test("an error carries none of the request's secrets anywhere", () => {
  const serialized = withoutSourceContext(requestEvent);

  for (const secret of [
    "secret-query",
    "secret-cookie",
    "secret-token",
    "secret-referer",
    "secret-body",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

function eventFrom(message) {
  return jobEvents.find(
    (event) => event.exception?.values?.at(-1)?.value === message,
  );
}

test("an error raised in a job names that job", () => {
  assert.deepEqual(
    ["queue", "job", "job_id"].map(
      (tag) => eventFrom("raised in messages.fetch").tags[tag],
    ),
    ["facebook", "messages.fetch", "1"],
  );
});

test("two jobs running at once each keep their own tags", () => {
  assert.equal(eventFrom("raised in posts.fetch").tags.job, "posts.fetch");
});

test("a failed job is reported as the error it wrapped", () => {
  const event = eventFrom("(#230) Requires pages_messaging permission");

  assert.equal(event.exception.values.at(-1).type, "PlatformError");
});

test("a failed job's event carries the fields its log line does", () => {
  const event = eventFrom("(#230) Requires pages_messaging permission");

  assert.deepEqual(
    {
      queue: event.tags.queue,
      job: event.tags.job,
      job_id: event.tags.job_id,
      account_id: event.tags.account_id,
      error_class: event.tags.error_class,
      wrapped_by: event.tags.wrapped_by,
      failedReason: event.contexts.job.failedReason,
    },
    {
      queue: "facebook",
      job: "messages.fetch",
      job_id: "3",
      account_id: "507f1f77bcf86cd799439011",
      error_class: "PlatformError",
      wrapped_by: "UnrecoverableError",
      failedReason: "Unrecoverable error. See job logs.",
    },
  );
});

test("with no DSN and no endpoint, neither Sentry nor OpenTelemetry is loaded", async () => {
  const { stdout } = await runFixture("loaded.js", {});
  const line = stdout
    .split("\n")
    .filter(Boolean)
    .find((l) => l.includes('"sentry"'));

  assert.deepEqual(JSON.parse(line), { sentry: false, otel: false });
});
