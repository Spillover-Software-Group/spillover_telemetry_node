// `node --import @spillover/telemetry/register src/index.js`: everything a process reports, set up
// before the application's first import, from the environment alone. A signal whose variable is
// absent is not loaded.
import { installErrors } from "./errors.js";
import { bridgeConsole, createLogger } from "./logger.js";
import { readSettings } from "./settings.js";
import { state } from "./state.js";
import { installTraces } from "./traces.js";

state.settings = readSettings();
state.logger = createLogger(state.settings);
bridgeConsole(state.logger);

if (state.settings.errors) {
  state.Sentry = await installErrors(state.settings);
}

if (state.settings.traces) {
  // Sentry keeps each request's and each job's scope in OpenTelemetry's context, so where both are
  // on, the SDK carries Sentry's context manager.
  const contextManager = state.Sentry
    ? new state.Sentry.SentryContextManager()
    : undefined;
  Object.assign(
    state,
    await installTraces({
      contextManager,
      logger: state.logger,
      ignoredPaths: state.settings.tracesIgnoredPaths,
    }),
  );
} else if (state.Sentry) {
  // With no SDK to register one, Sentry's context manager is registered on its own, or every
  // request and job would share one scope.
  const { context } = await import("@opentelemetry/api");
  context.setGlobalContextManager(
    new state.Sentry.SentryContextManager().enable(),
  );
}
