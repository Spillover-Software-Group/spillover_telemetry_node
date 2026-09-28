// One job's span, with the collector unreachable, in one of three ways:
// - "scheduled": the process runs on while the batch processor's own export fails;
// - "exit": the process flushes at exit and that export fails;
// - "diag": OpenTelemetry's diag logger is handed a warning directly.
import { setTimeout as delay } from "node:timers/promises";
import { diag } from "@opentelemetry/api";
import { flushTelemetry, runJob } from "../../src/index.js";

const mode = process.env.FIXTURE_MODE;

if (mode === "diag") {
  diag.warn("an OpenTelemetry warning");
} else {
  await runJob({ queue: "google", name: "reviews.fetch", id: "9" }, () =>
    Promise.resolve(),
  );
}

if (mode === "scheduled") {
  // Long enough for the scheduled export (OTEL_BSP_SCHEDULE_DELAY) to be attempted and to give up
  // (OTEL_EXPORTER_OTLP_TIMEOUT); the test sets both short.
  await delay(Number(process.env.FIXTURE_RUN_MS));
  process.exit(0);
}

await flushTelemetry();
