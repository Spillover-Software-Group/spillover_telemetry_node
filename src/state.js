// What `@spillover/telemetry/register` started, for the rest of the package. A process started
// without it has none of this, and every function the package exports is then a no-op.
export const state = {
  settings: undefined,
  // The @sentry/node module, where errors are on.
  Sentry: undefined,
  // The OpenTelemetry SDK, a tracer and the API, where traces are on.
  sdk: undefined,
  tracer: undefined,
  api: undefined,
  logger: undefined,
};
