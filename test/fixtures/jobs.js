// Two jobs at once, each raising an error after the other has started, then a job failure reported
// the way a worker's `failed` handler reports it.
import { setTimeout as delay } from "node:timers/promises";
import * as Sentry from "@sentry/node";
import { captureJobFailure, flushTelemetry, runJob } from "../../src/index.js";

async function job(name, id, waitMs) {
  await runJob({ queue: "facebook", name, id }, async () => {
    await delay(waitMs);
    Sentry.captureException(new Error(`raised in ${name}`));
  });
}

await Promise.all([
  job("messages.fetch", "1", 30),
  job("posts.fetch", "2", 10),
]);

// Named as BullMQ's and this codebase's own are: Sentry reads an exception's type from its name.
class PlatformError extends Error {
  name = "PlatformError";
}
class UnrecoverableError extends Error {
  name = "UnrecoverableError";
}
const failure = new UnrecoverableError("Unrecoverable error. See job logs.");
failure.cause = new PlatformError("(#230) Requires pages_messaging permission");

captureJobFailure(
  {
    queue: "facebook",
    job: "messages.fetch",
    jobId: "3",
    accountId: "507f1f77bcf86cd799439011",
    failedReason: "Unrecoverable error. See job logs.",
    logs: ["Platform error: ..."],
  },
  failure,
);

await flushTelemetry();
