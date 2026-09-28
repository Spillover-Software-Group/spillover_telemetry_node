import { redactCredentials } from "./redact.js";
import { state } from "./state.js";

// Of the request an error happened in, Sentry is told the method, the URL without its query and the
// User-Agent's value, which tells a browser from another service calling. No cookie, no body, no
// other header: a Referer can carry another page's query, and an Authorization header is a token.
// Every string in an event, however deep: an exception's message, a breadcrumb (Sentry records each
// console call as one, so a warning printed earlier rides along on the next error), a context.
function redactDeep(value) {
  if (typeof value === "string") return redactCredentials(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = redactDeep(value[key]);
  }
  return value;
}

export function scrubEvent(event) {
  redactDeep(event);

  const { request } = event;
  if (!request) return event;

  const userAgent = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "user-agent",
  )?.[1];

  event.request = {
    method: request.method,
    url: request.url?.split("?")[0],
    ...(userAgent === undefined
      ? {}
      : { headers: { "User-Agent": userAgent } }),
  };

  return event;
}

export async function installErrors(settings, overrides = {}) {
  const Sentry = await import("@sentry/node");

  Sentry.init({
    dsn: settings.sentryDsn,
    environment: settings.environment(settings.sentryEnvironment),
    release: settings.release,
    sendDefaultPii: false,
    // Errors only. Traces are OpenTelemetry's, to X-Ray, so Sentry leaves the OpenTelemetry setup,
    // and the ESM loader hook it would register for its own instrumentation, to this package. The
    // sample rate stays unset, not 0: Sentry counts any rate as spans on and then registers its own
    // HTTP, Koa and database instrumentation, whose spans reach this package's exporter beside the
    // SDK's own, twice per request and blind to TRACES_IGNORED_PATHS.
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
    beforeSend: scrubEvent,
    ...overrides,
  });

  return Sentry;
}

function withoutEmpty(object) {
  return Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  );
}

// Names the user every error in the current request or job reports. The id and email come from
// where the application authenticates; the address from clientAddress().
export function identifyUser({ id, email, ipAddress } = {}) {
  const { Sentry } = state;
  if (!Sentry) return;

  const scope = Sentry.getIsolationScope();
  scope.setUser({
    ...scope.getUser(),
    ...withoutEmpty({
      id: id === undefined ? undefined : String(id),
      email,
      ip_address: ipAddress,
    }),
  });
}

// Koa middleware: each request gets a scope of its own, named by the client's address. `ctx.ip` is
// the client's only where the application trusts its proxies (`app.proxy = true`), since behind the
// load balancer and kamal-proxy the socket's address is a proxy's.
export function clientAddress() {
  return async (ctx, next) => {
    const { Sentry } = state;
    if (!Sentry) return await next();

    return await Sentry.withIsolationScope(async () => {
      identifyUser({ ipAddress: ctx.ip });
      await next();
    });
  };
}

// Reports an error that is a defect: the application decides which errors are its own to fix and
// calls this for those. `tags` are searchable, `context` is shown beside the event. Sentry sends an
// Error object once however often it is captured, so an error that is caught, logged and then
// carried on by the failure it caused is one event, not two.
export function captureError(error, { tags = {}, context } = {}) {
  const { Sentry } = state;
  if (!Sentry || !(error instanceof Error)) return;

  Sentry.withScope((scope) => {
    scope.setTags(withoutEmpty(tags));
    if (context) scope.setContext("details", withoutEmpty(context));
    Sentry.captureException(error);
  });
}

// Whether a job has failed for the last time: out of attempts, or failed by an error BullMQ does
// not retry. BullMQ emits `failed` after every attempt, retries included.
export function isFinalFailure(job, error) {
  if (error?.name === "UnrecoverableError") return true;
  if (!job) return true;

  return job.attemptsMade >= (job.opts?.attempts ?? 1);
}

// Reports a failed job to Sentry with the fields its log line carries. Where the thrown error wraps
// another (an UnrecoverableError standing for the platform error behind it), the wrapped one is what
// is reported, so that failures group by what went wrong rather than all under the wrapper.
export function captureJobFailure(fields, error) {
  const { Sentry } = state;
  if (!Sentry) return;

  const reported = error?.cause instanceof Error ? error.cause : error;

  Sentry.withScope((scope) => {
    scope.setTags(
      withoutEmpty({
        queue: fields.queue,
        job: fields.job,
        job_id: fields.jobId === undefined ? undefined : String(fields.jobId),
        account_id:
          fields.accountId === undefined ? undefined : String(fields.accountId),
        error_class: reported?.constructor?.name,
        wrapped_by: reported === error ? undefined : error?.constructor?.name,
      }),
    );
    scope.setContext("job", withoutEmpty({ ...fields, logs: undefined }));
    Sentry.captureException(reported);
  });
}
