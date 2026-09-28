import assert from "node:assert/strict";
import { test } from "node:test";

import { runFixture } from "./helpers/process.js";

// The collector unreachable (nothing listens on port 1), with the batch processor's delay and the
// exporter's timeout short enough for a test.
async function linesWhen(mode) {
  const { stdout } = await runFixture("export-fails.js", {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
    OTEL_SERVICE_NAME: "senalysis-data-exchange",
    OTEL_BSP_SCHEDULE_DELAY: "100",
    OTEL_EXPORTER_OTLP_TIMEOUT: "300",
    FIXTURE_MODE: mode,
    FIXTURE_RUN_MS: "1500",
  });

  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.component === "opentelemetry");
}

test("a scheduled export that fails is an error line naming OpenTelemetry and the cause", async () => {
  const [line] = await linesWhen("scheduled");

  assert.deepEqual(
    { level: line?.level, msg: line?.msg, cause: line?.err?.message },
    {
      level: "error",
      msg: "OpenTelemetry could not export or process spans",
      cause: "connect ECONNREFUSED 127.0.0.1:1",
    },
  );
});

test("an export at exit that fails is a warning line naming what was lost", async () => {
  const [line] = await linesWhen("exit");

  assert.deepEqual(
    { level: line?.level, msg: line?.msg },
    {
      level: "warn",
      msg: "OpenTelemetry could not send its buffered spans before exit",
    },
  );
});

test("an OpenTelemetry warning is a JSON line of its own", async () => {
  const [line] = await linesWhen("diag");

  assert.deepEqual(
    { level: line?.level, msg: line?.msg },
    { level: "warn", msg: "an OpenTelemetry warning" },
  );
});
