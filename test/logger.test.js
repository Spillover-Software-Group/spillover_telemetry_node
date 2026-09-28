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

async function redactedRun() {
  const { stdout, stderr } = await runFixture("redact.js", ENV);
  return {
    output: stdout + stderr,
    lines: stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test("a password in a URL appears nowhere a process writes", async () => {
  const { output } = await redactedRun();

  assert.equal(output.includes("PLANTED-SECRET"), false);
});

test("a URL's scheme, user and host stay in the line", async () => {
  const { lines } = await redactedRun();

  assert.equal(
    lines[0].msg,
    "connecting to mongodb://senalysis:***@ac-1.example.net:27017,ac-2.example.net:27017/db",
  );
});

test("a field and a nested field are redacted", async () => {
  const { lines } = await redactedRun();

  assert.deepEqual(
    [lines[0].uri, lines[0].nested.connection.uri],
    [
      "mongodb://senalysis:***@ac-1.example.net:27017,ac-2.example.net:27017/db",
      "mongodb://senalysis:***@ac-1.example.net:27017,ac-2.example.net:27017/db",
    ],
  );
});

test("an error's message and stack are redacted", async () => {
  const { lines } = await redactedRun();
  const { err } = lines[1];

  assert.deepEqual(
    [
      err.message.includes("senalysis:***@"),
      err.stack.includes("senalysis:***@"),
    ],
    [true, true],
  );
});

test("Node's warning for a legacy parse of the URL is redacted", async () => {
  const { lines } = await redactedRun();

  assert.equal(
    lines.some(
      (line) =>
        line.msg?.includes("DEP0170") && line.msg.includes("senalysis:***@"),
    ),
    true,
  );
});
