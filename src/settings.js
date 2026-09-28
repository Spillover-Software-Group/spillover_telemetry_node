// Every variable the signals read, taken from the environment once, when a process starts. A
// variable that is absent or empty reads as undefined, and undefined is what turns its signal off.

function present(value) {
  return value === undefined || value === "" ? undefined : value;
}

// The paths whose incoming requests start no trace: a load balancer's and a proxy's health checks,
// asking every few seconds, and a transport's own requests. An entry is one path, or, ending in "/",
// every path under it.
function pathList(value) {
  return (present(value) ?? "/health")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
}

// A namespace on its own is not a configuration: a document with no application and no role is a
// series nobody can find, so a deploy that sets one of the three says so at start.
function required(env, name) {
  const value = present(env[name]);
  if (value === undefined) {
    throw new Error(
      `${name} is required where CLOUDWATCH_METRICS_NAMESPACE is set`,
    );
  }
  return value;
}

export function readSettings(env = process.env) {
  const metricsNamespace = present(env.CLOUDWATCH_METRICS_NAMESPACE);
  const destination = present(env.KAMAL_DESTINATION);
  const nodeEnv = present(env.NODE_ENV) ?? "development";

  return Object.freeze({
    metricsNamespace,
    metricsApp: metricsNamespace && required(env, "CLOUDWATCH_METRICS_APP"),
    metricsRole: metricsNamespace && required(env, "CLOUDWATCH_METRICS_ROLE"),
    sentryDsn: present(env.SENTRY_DSN),
    sentryEnvironment: present(env.SENTRY_ENVIRONMENT),
    // Kamal names the running version after the commit.
    release: present(env.KAMAL_VERSION),
    otlpEndpoint: present(env.OTEL_EXPORTER_OTLP_ENDPOINT),
    tracesIgnoredPaths: pathList(env.TRACES_IGNORED_PATHS),
    // Every destination runs with NODE_ENV=production, so NODE_ENV cannot tell staging from
    // production; the destination Kamal deployed to can, and Kamal sets it in every container.
    destination,
    nodeEnv,
    // What the log calls the application: the metrics' App where there is one, else the traces'
    // service name.
    app: present(env.CLOUDWATCH_METRICS_APP) ?? present(env.OTEL_SERVICE_NAME),

    // What a signal reports as its environment: what the deploy named for that signal, else the
    // destination, else NODE_ENV for a process outside a container.
    environment(named) {
      return named ?? destination ?? nodeEnv;
    },

    get metrics() {
      return metricsNamespace !== undefined;
    },
    get errors() {
      return this.sentryDsn !== undefined;
    },
    get traces() {
      return this.otlpEndpoint !== undefined;
    },
    get development() {
      return destination === undefined && nodeEnv === "development";
    },
  });
}
