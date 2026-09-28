import { monitorEventLoopDelay } from "node:perf_hooks";

import { isFinalFailure } from "./errors.js";
import { state } from "./state.js";

// One CloudWatch Embedded Metric Format document a minute, as one whole line on stdout. The log
// driver ships stdout and CloudWatch reads the fields under `_aws` as metrics: no agent, no SDK, no
// network call. It is written to the stream itself rather than through the logger, which would bury
// it inside a message field.
export const INTERVAL_MS = 60_000;

// The document in the shape spillover_telemetry (the Rails gem) writes, so one alarm and one
// dashboard read a Node application and a Rails one alike. `units` declares each value; a value
// with no unit is refused rather than graphed as a bare number.
export function emfDocument({
  namespace,
  app,
  environment,
  role,
  values,
  units,
  now,
}) {
  const measured = Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );

  const declared = Object.keys(measured).map((name) => {
    const unit = units[name];
    if (!unit) throw new Error(`No unit declared for the metric ${name}`);
    return { Name: name, Unit: unit };
  });

  return JSON.stringify({
    _aws: {
      Timestamp: now.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [["App", "Environment", "Role"]],
          Metrics: declared,
        },
      ],
    },
    App: app,
    Environment: environment,
    Role: role,
    ...measured,
  });
}

const MB = 1024 * 1024;

// What every Node process reports: how late the event loop ran (its saturation signal), memory, how
// much it holds open, and a heartbeat whose absence is the alarm that the process stopped reporting.
export function runtimeCollector() {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();

  return {
    units: {
      EventLoopDelayP99Ms: "Milliseconds",
      HeapUsedMB: "Megabytes",
      RssMB: "Megabytes",
      ActiveHandles: "Count",
      Heartbeat: "Count",
    },
    values() {
      const p99 = delay.count > 0 ? delay.percentile(99) / 1e6 : undefined;
      delay.reset();
      const memory = process.memoryUsage();

      return {
        EventLoopDelayP99Ms: p99,
        HeapUsedMB: memory.heapUsed / MB,
        RssMB: memory.rss / MB,
        ActiveHandles: process.getActiveResourcesInfo().length,
        Heartbeat: 1,
      };
    },
    stop() {
      delay.disable();
    },
  };
}

// BullMQ's queues: what is waiting, delayed and running across every queue this process registered,
// and how many jobs completed and finally failed since the last document. Completions and failures
// are counted from this process's workers' own events, since the counts Redis keeps shrink as
// removeOnComplete and removeOnFail trim them.
export function bullmqCollector({ queues, workers }) {
  let completed = 0;
  let failed = 0;

  for (const worker of workers) {
    worker.on("completed", () => {
      completed += 1;
    });
    worker.on("failed", (job, error) => {
      if (isFinalFailure(job, error)) failed += 1;
    });
  }

  return {
    units: {
      JobsWaiting: "Count",
      JobsDelayed: "Count",
      JobsActive: "Count",
      JobsCompleted: "Count",
      JobsFailed: "Count",
    },
    async values() {
      const counts = await Promise.all(
        queues.map((queue) =>
          queue.getJobCounts("waiting", "prioritized", "delayed", "active"),
        ),
      );
      const sum = (name) =>
        counts.reduce((total, count) => total + (count[name] ?? 0), 0);

      const values = {
        JobsWaiting: sum("waiting") + sum("prioritized"),
        JobsDelayed: sum("delayed"),
        JobsActive: sum("active"),
        JobsCompleted: completed,
        JobsFailed: failed,
      };
      completed = 0;
      failed = 0;

      return values;
    },
  };
}

const OFF = Object.freeze({
  publish: () => Promise.resolve(),
  stop: () => undefined,
});

// Starts publishing, where the environment names a namespace, and returns what stops it. Only a
// process that decides to call this reports: the worker's entry point does, a one-off script does
// not, however its environment is set. The environment decides what; the process decides whether.
export function startMetrics({
  collectors = [],
  settings = state.settings,
  interval = INTERVAL_MS,
  write = (line) => process.stdout.write(`${line}\n`),
  now = () => new Date(),
  logger = state.logger ?? console,
} = {}) {
  // Nothing to do, and nothing to stop.
  if (!settings?.metrics) return OFF;

  const all = [runtimeCollector(), ...collectors];
  const units = Object.assign({}, ...all.map((collector) => collector.units));
  let lastFailure;

  async function publish() {
    try {
      const values = Object.assign(
        {},
        ...(await Promise.all(all.map((collector) => collector.values()))),
      );

      write(
        emfDocument({
          namespace: settings.metricsNamespace,
          app: settings.metricsApp,
          environment: settings.environment(),
          role: settings.metricsRole,
          values,
          units,
          now: now(),
        }),
      );
      lastFailure = undefined;
    } catch (error) {
      // A minute is often enough that a lasting failure would drown the log, so the same one is
      // said once, and again only when it changes.
      const failure = `${error.constructor.name}: ${error.message}`;
      if (failure === lastFailure) return;

      lastFailure = failure;
      logger.warn(`Runtime metrics are not being reported: ${failure}`);
    }
  }

  const timer = setInterval(publish, interval);
  // Metrics never keep a process alive that is otherwise done.
  timer.unref();

  return {
    publish,
    stop() {
      clearInterval(timer);
      for (const collector of all) collector.stop?.();
    },
  };
}
