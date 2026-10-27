// An outbound call outside any job, then one inside a job, then a job of another library, then a
// flush.
import { flushTelemetry, runJob } from "../../src/index.js";

const target = process.env.FIXTURE_TARGET;

await fetch(`${target}/outside-a-job`).then((response) => response.text());
await runJob({ queue: "google", name: "reviews.fetch", id: "9" }, () =>
  fetch(`${target}/inside-a-job`).then((response) => response.text()),
);
await runJob(
  { system: "pulse", queue: "pulse", name: "items.unsnooze", id: "6512" },
  () => Promise.resolve(),
);

await flushTelemetry();
