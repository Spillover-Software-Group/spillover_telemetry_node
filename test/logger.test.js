import assert from "node:assert/strict";
import { test } from "node:test";

import { runFixture } from "./helpers/process.js";

async function linesOf(env) {
  const { stdout } = await runFixture("log.js", env);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const ENV = {
  KAMAL_DESTINATION: "staging",
  OTEL_SERVICE_NAME: "senalysis-data-exchange",
};

test("a logger line is JSON stamped with the application and the environment", async () => {
  const [line] = await linesOf(ENV);

  assert.deepEqual(
    {
      level: line.level,
      app: line.app,
      environment: line.environment,
      msg: line.msg,
      queue: line.queue,
    },
    {
      level: "info",
      app: "senalysis-data-exchange",
      environment: "staging",
      msg: "through the logger",
      queue: "google",
    },
  );
});

test("a logger line carries an ISO time", async () => {
  const [line] = await linesOf(ENV);

  assert.equal(new Date(line.time).toISOString(), line.time);
});

test("a console.error lands as the same JSON, its object as fields", async () => {
  const [, line] = await linesOf(ENV);

  assert.deepEqual(
    {
      level: line.level,
      msg: line.msg,
      jobId: line.jobId,
      failedReason: line.failedReason,
    },
    {
      level: "error",
      msg: "[Worker google] Job failed",
      jobId: "9",
      failedReason: "boom",
    },
  );
});

test("a console.error names its error by class and message", async () => {
  const [, line] = await linesOf(ENV);

  assert.deepEqual(
    { type: line.err.type, message: line.err.message },
    { type: "TypeError", message: "wrapped" },
  );
});
