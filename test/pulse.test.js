import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { Pulse } from "@pulsecron/pulse";
import { MongoMemoryServer } from "mongodb-memory-server";

import { pulseCollector, startMetrics } from "../src/metrics.js";
import { readSettings } from "../src/settings.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const minutesBefore = (minutes) => new Date(NOW.getTime() - minutes * 60_000);

let mongo;
const pulses = [];

before(async () => {
  mongo = await MongoMemoryServer.create();
});

after(async () => {
  await Promise.all(pulses.map((pulse) => pulse.close({ force: true })));
  await mongo.stop();
});

// A Pulse of its own, on a collection of its own, defining `names`. It is not started, so nothing it
// is given runs and every job stays as the test left it.
async function pulseDefining(names) {
  const pulse = new Pulse({
    db: { address: mongo.getUri("pulse"), collection: `jobs_${pulses.length}` },
  });
  pulses.push(pulse);
  await once(pulse, "ready");
  for (const name of names) pulse.define(name, () => undefined);

  return pulse;
}

async function saveJob(pulse, name, nextRunAt, change = (attrs) => attrs) {
  const job = pulse.create(name, {});
  job.attrs.nextRunAt = nextRunAt;
  change(job.attrs);
  await job.save();
}

async function valuesOf(pulse) {
  return await pulseCollector({ pulse, now: () => NOW }).values();
}

test("a job that is due and that no process holds is waiting", async () => {
  const pulse = await pulseDefining(["reports.send"]);
  await saveJob(pulse, "reports.send", minutesBefore(2));

  assert.equal((await valuesOf(pulse)).JobsWaiting, 1);
});

test("a job that is not due yet is not waiting", async () => {
  const pulse = await pulseDefining(["reports.send"]);
  await saveJob(pulse, "reports.send", minutesBefore(-5));

  assert.equal((await valuesOf(pulse)).JobsWaiting, 0);
});

test("a job a process has locked is not waiting", async () => {
  const pulse = await pulseDefining(["reports.send"]);
  await saveJob(pulse, "reports.send", minutesBefore(2), (attrs) => {
    attrs.lockedAt = minutesBefore(1);
  });

  assert.equal((await valuesOf(pulse)).JobsWaiting, 0);
});

test("a disabled job is not waiting", async () => {
  const pulse = await pulseDefining(["reports.send"]);
  await saveJob(pulse, "reports.send", minutesBefore(2), (attrs) => {
    attrs.disabled = true;
  });

  assert.equal((await valuesOf(pulse)).JobsWaiting, 0);
});

// Pulse never runs a job whose name nothing defines, so it would hold the count and the age up
// for good.
test("a job of a name this process does not define is not waiting", async () => {
  const pulse = await pulseDefining(["reports.send"]);
  await saveJob(pulse, "reports.retired", minutesBefore(600));

  assert.equal((await valuesOf(pulse)).JobsWaiting, 0);
});

test("the oldest waiting job's age is how long ago it fell due, in seconds", async () => {
  const pulse = await pulseDefining(["reports.send", "items.unsnooze"]);
  await saveJob(pulse, "reports.send", minutesBefore(2));
  await saveJob(pulse, "items.unsnooze", minutesBefore(7));

  assert.equal((await valuesOf(pulse)).OldestReadyJobAge, 420);
});

test("with nothing waiting there is no age to report", async () => {
  const pulse = await pulseDefining(["reports.send"]);

  assert.equal((await valuesOf(pulse)).OldestReadyJobAge, undefined);
});

// A started Pulse running a job that throws, and the collector over it.
async function failingRun() {
  const pulse = await pulseDefining([]);
  pulse.define("reports.broken", () => {
    throw new Error("No account");
  });
  const collector = pulseCollector({ pulse, now: () => NOW });

  const failed = once(pulse, "fail");
  await pulse.start();
  await pulse.now("reports.broken");
  await failed;
  await pulse.stop();

  return { pulse, collector };
}

test("a run that fails in this process is counted in the next document", async () => {
  const { collector } = await failingRun();

  assert.equal((await collector.values()).JobsFailed, 1);
});

test("a failed run is counted in one document only", async () => {
  const { collector } = await failingRun();
  await collector.values();

  assert.equal((await collector.values()).JobsFailed, 0);
});

test("a failed run is kept for the next document when the query fails", async () => {
  const { pulse, collector } = await failingRun();
  const { collectionName } = pulse._collection;
  await pulse.close();
  await assert.rejects(collector.values());

  const reconnected = once(pulse, "ready");
  await pulse.database(mongo.getUri("pulse"), collectionName);
  await reconnected;

  assert.equal((await collector.values()).JobsFailed, 1);
});

test("the three are written in the runtime's document, with their units", async () => {
  const pulse = await pulseDefining(["reports.send"]);
  await saveJob(pulse, "reports.send", minutesBefore(2));
  const lines = [];
  const metrics = startMetrics({
    settings: readSettings({
      CLOUDWATCH_METRICS_NAMESPACE: "Spillover/Runtime",
      CLOUDWATCH_METRICS_APP: "online-ordering-api",
      CLOUDWATCH_METRICS_ROLE: "web",
      KAMAL_DESTINATION: "staging",
    }),
    collectors: [pulseCollector({ pulse, now: () => NOW })],
    write: (line) => lines.push(line),
    now: () => NOW,
  });
  await metrics.publish();
  metrics.stop();

  const document = JSON.parse(lines[0]);
  const declared = Object.fromEntries(
    document._aws.CloudWatchMetrics[0].Metrics.map(({ Name, Unit }) => [
      Name,
      Unit,
    ]),
  );
  assert.deepEqual(
    {
      JobsWaiting: [document.JobsWaiting, declared.JobsWaiting],
      OldestReadyJobAge: [
        document.OldestReadyJobAge,
        declared.OldestReadyJobAge,
      ],
      JobsFailed: [document.JobsFailed, declared.JobsFailed],
    },
    {
      JobsWaiting: [1, "Count"],
      OldestReadyJobAge: [120, "Seconds"],
      JobsFailed: [0, "Count"],
    },
  );
});
