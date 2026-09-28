import assert from "node:assert/strict";
import { test } from "node:test";

import { emfDocument, startMetrics } from "../src/metrics.js";
import { readSettings } from "../src/settings.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");

test("a document is the gem's Embedded Metric Format shape", () => {
  const document = JSON.parse(
    emfDocument({
      namespace: "Spillover/Runtime",
      app: "senalysis-data-exchange",
      environment: "production",
      role: "worker",
      values: { JobsWaiting: 4, RssMB: 312.5 },
      units: { JobsWaiting: "Count", RssMB: "Megabytes" },
      now: NOW,
    }),
  );

  assert.deepEqual(document, {
    _aws: {
      Timestamp: NOW.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: "Spillover/Runtime",
          Dimensions: [["App", "Environment", "Role"]],
          Metrics: [
            { Name: "JobsWaiting", Unit: "Count" },
            { Name: "RssMB", Unit: "Megabytes" },
          ],
        },
      ],
    },
    App: "senalysis-data-exchange",
    Environment: "production",
    Role: "worker",
    JobsWaiting: 4,
    RssMB: 312.5,
  });
});

test("a value with nothing to measure is left out rather than reported as zero", () => {
  const document = JSON.parse(
    emfDocument({
      namespace: "N",
      app: "a",
      environment: "e",
      role: "r",
      values: { EventLoopDelayP99Ms: undefined, Heartbeat: 1 },
      units: { EventLoopDelayP99Ms: "Milliseconds", Heartbeat: "Count" },
      now: NOW,
    }),
  );

  assert.equal("EventLoopDelayP99Ms" in document, false);
});

test("a value with no declared unit is refused", () => {
  assert.throws(
    () =>
      emfDocument({
        namespace: "N",
        app: "a",
        environment: "e",
        role: "r",
        values: { Mystery: 1 },
        units: {},
        now: NOW,
      }),
    { message: "No unit declared for the metric Mystery" },
  );
});

const METRICS_ENV = {
  CLOUDWATCH_METRICS_NAMESPACE: "Spillover/Runtime",
  CLOUDWATCH_METRICS_APP: "senalysis-data-exchange",
  CLOUDWATCH_METRICS_ROLE: "worker",
  KAMAL_DESTINATION: "staging",
};

async function publishOnce(env, collectors = []) {
  const lines = [];
  const metrics = startMetrics({
    settings: readSettings(env),
    collectors,
    write: (line) => lines.push(line),
    now: () => NOW,
  });
  await metrics.publish();
  metrics.stop();

  return lines;
}

// The event loop's delay is left out of a document published before the loop has been sampled, so
// it is not among these; the test above covers what an unmeasured value does.
test("every process that reports sends its memory, its handles and a heartbeat", async () => {
  const [line] = await publishOnce(METRICS_ENV);
  const names = JSON.parse(line)._aws.CloudWatchMetrics[0].Metrics.map(
    ({ Name }) => Name,
  );

  assert.deepEqual(
    names.filter((name) => name !== "EventLoopDelayP99Ms").sort(),
    ["ActiveHandles", "HeapUsedMB", "Heartbeat", "RssMB"],
  );
});

test("a document names the destination as its environment", async () => {
  const [line] = await publishOnce(METRICS_ENV);

  assert.equal(JSON.parse(line).Environment, "staging");
});

test("an application's collector adds its numbers to the same document", async () => {
  const collector = {
    units: { JobsWaiting: "Count" },
    values: () => Promise.resolve({ JobsWaiting: 7 }),
  };

  const [line] = await publishOnce(METRICS_ENV, [collector]);

  assert.equal(JSON.parse(line).JobsWaiting, 7);
});

test("with no namespace nothing is written", async () => {
  assert.deepEqual(await publishOnce({}), []);
});

test("a failing collector is reported once, not once a minute", async () => {
  const warnings = [];
  const failing = {
    units: {},
    values: () => Promise.reject(new Error("Redis is down")),
  };
  const metrics = startMetrics({
    settings: readSettings(METRICS_ENV),
    collectors: [failing],
    write: () => undefined,
    logger: { warn: (line) => warnings.push(line) },
  });

  await metrics.publish();
  await metrics.publish();
  metrics.stop();

  assert.deepEqual(warnings, [
    "Runtime metrics are not being reported: Error: Redis is down",
  ]);
});
