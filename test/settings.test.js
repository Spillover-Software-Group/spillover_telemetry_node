import assert from "node:assert/strict";
import { test } from "node:test";

import { readSettings } from "../src/settings.js";

test("every signal is off when nothing is set", () => {
  const settings = readSettings({});

  assert.deepEqual(
    [settings.metrics, settings.errors, settings.traces],
    [false, false, false],
  );
});

test("a variable set to nothing counts as not set", () => {
  const settings = readSettings({
    SENTRY_DSN: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    CLOUDWATCH_METRICS_NAMESPACE: "",
  });

  assert.deepEqual(
    [settings.metrics, settings.errors, settings.traces],
    [false, false, false],
  );
});

test("each signal's variable turns it on", () => {
  const settings = readSettings({
    SENTRY_DSN: "https://key@sentry.example/1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    CLOUDWATCH_METRICS_NAMESPACE: "Spillover/Runtime",
    CLOUDWATCH_METRICS_APP: "an-app",
    CLOUDWATCH_METRICS_ROLE: "worker",
  });

  assert.deepEqual(
    [settings.metrics, settings.errors, settings.traces],
    [true, true, true],
  );
});

test("a namespace without an application refuses to start, naming what is missing", () => {
  assert.throws(
    () =>
      readSettings({
        CLOUDWATCH_METRICS_NAMESPACE: "Spillover/Runtime",
        CLOUDWATCH_METRICS_ROLE: "worker",
      }),
    {
      message:
        "CLOUDWATCH_METRICS_APP is required where CLOUDWATCH_METRICS_NAMESPACE is set",
    },
  );
});

test("a namespace without a role refuses to start, naming what is missing", () => {
  assert.throws(
    () =>
      readSettings({
        CLOUDWATCH_METRICS_NAMESPACE: "Spillover/Runtime",
        CLOUDWATCH_METRICS_APP: "an-app",
      }),
    {
      message:
        "CLOUDWATCH_METRICS_ROLE is required where CLOUDWATCH_METRICS_NAMESPACE is set",
    },
  );
});

test("the environment is the destination over NODE_ENV", () => {
  const settings = readSettings({
    KAMAL_DESTINATION: "staging",
    NODE_ENV: "production",
  });

  assert.equal(settings.environment(), "staging");
});

test("the environment is NODE_ENV outside a container", () => {
  assert.equal(
    readSettings({ NODE_ENV: "production" }).environment(),
    "production",
  );
});

test("a signal's own environment is what the deploy named for it", () => {
  const settings = readSettings({
    SENTRY_ENVIRONMENT: "production-eu",
    KAMAL_DESTINATION: "production",
  });

  assert.equal(
    settings.environment(settings.sentryEnvironment),
    "production-eu",
  );
});

test("the release is the version Kamal deployed", () => {
  assert.equal(readSettings({ KAMAL_VERSION: "abc123" }).release, "abc123");
});
