// Two units of work started with startRequest at once, each naming its user and raising an error
// after the other has started; then errors reported with captureError, one of them twice with
// another between.
import { setTimeout as delay } from "node:timers/promises";
import * as Sentry from "@sentry/node";
import {
  captureError,
  flushTelemetry,
  identifyUser,
  startRequest,
} from "../../src/index.js";

async function action(type, userId, waitMs) {
  const request = startRequest(`socket ${type}`, { action: type });
  await request.run(async () => {
    identifyUser({ id: userId, email: `${userId}@example.com` });
    await delay(waitMs);
    Sentry.captureException(new Error(`raised in ${type}`));
  });
  request.end();
}

await Promise.all([
  action("POSTS_GET", "user-1", 30),
  action("REVIEWS_GET", "user-2", 10),
]);

const defect = new TypeError(
  "Cannot read properties of undefined (reading 'type')",
);
captureError(defect, {
  tags: { action: "BUSINESS_TYPES_GET" },
  context: { socket: "abc", empty: "" },
});
// Another error in between, so the repeat is not the event just before it, which Sentry's own
// deduplication would drop anyway.
captureError(new RangeError("Invalid time value"));
captureError(defect, { tags: { action: "BUSINESS_TYPES_GET" } });
captureError("not an error");

await flushTelemetry();
