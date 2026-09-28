# @spillover/telemetry

How a Spillover Node application reports on itself: **JSON logs** and **runtime metrics** on
stdout, **errors** to Sentry, **traces** to an OTLP endpoint, all stamped with the one environment
they agree on. The Node side of the Rails gem `spillover_telemetry`, with the same variables and the
same metric document.

Each signal is off until the deploy sets its variable, and off costs nothing: its SDK is never
loaded.

## Installing it

```json
"@spillover/telemetry": "github:Spillover-Software-Group/spillover_telemetry_node#v0.1.1"
```

Pinned to a tag. Then start the process through it, so it is set up before the application's first
import:

```shell
node --import @spillover/telemetry/register src/index.js
```

and set what the container reports, in `config/deploy.yml`:

```yaml
env:
  clear:
    CLOUDWATCH_METRICS_NAMESPACE: Spillover/Runtime
    CLOUDWATCH_METRICS_APP: senalysis-data-exchange
    CLOUDWATCH_METRICS_ROLE: worker
    OTEL_EXPORTER_OTLP_ENDPOINT: http://host.docker.internal:4318
    OTEL_SERVICE_NAME: senalysis-data-exchange
  secret:
    - SENTRY_DSN
```

## What it reports

**Logs.** `getLogger()` is a pino logger writing one JSON line per call, with `level`, an ISO
`time`, `app`, `environment` and `msg`. `register` routes `console.*` through it: a plain object
argument becomes fields of the line, and an Error becomes `err` with its class, message and stack.
In development (no destination, `NODE_ENV=development`) lines are pretty-printed.

**Metrics.** One CloudWatch Embedded Metric Format document a minute, a whole line on stdout, in
namespace `CLOUDWATCH_METRICS_NAMESPACE`, with the dimensions `App`, `Environment` and `Role`.
The shape is exactly the gem's. A process reports only if it calls `startMetrics()`: the
environment decides what, and the process decides whether, so a one-off script never prints a
document a minute.

| Collector | Reports | Unit |
|---|---|---|
| runtime (every process that reports) | `EventLoopDelayP99Ms` | Milliseconds |
| | `HeapUsedMB`, `RssMB` | Megabytes |
| | `ActiveHandles`, `Heartbeat` (always 1: alarm on missing data) | Count |
| `bullmqCollector({ queues, workers })` | `JobsWaiting` (waiting and prioritized), `JobsDelayed`, `JobsActive` | Count |
| | `JobsCompleted`, `JobsFailed` (final failures only), since the last document | Count |

A value with nothing to measure yet is left out rather than sent as zero. An application collector
is `{ units, values() }`, where `values` may be async and every name has a unit.

**Errors.** Sentry, errors only (`tracesSampleRate: 0`, `sendDefaultPii: false`), with the
environment and the release (`KAMAL_VERSION`). Of a request, an error keeps the method, the URL
without its query and the `User-Agent` value, and nothing else: no cookie, no body, no other header.

**Sentry is for defects, not for a platform saying no.** A job that fails because a platform
refused (the application's own classified error, retriable or not, auth or not) is counted in
`JobsFailed` and logged with its fields, and does not reach Sentry: the alarm and the log group are
for that. A job that fails on anything else (a `TypeError`, a database error, an unclassified
throw) reaches Sentry once, at its final failure, with the same fields as tags. The application
applies the rule where it calls `captureJobFailure`, because only it knows its classified error.

- `identifyUser({ id, email, ipAddress })` names the user for the current request or job.
- `clientAddress()` is Koa middleware that gives each request a scope of its own, named by `ctx.ip`,
  which is the client's only with `app.proxy = true` behind the load balancer and kamal-proxy.
- `runJob({ queue, name, id }, fn)` runs a job in a scope tagged `queue`, `job` and `job_id`, and in
  a trace of its own.
- `captureJobFailure(fields, error)`, for a final failure that is a defect, reports a failed job with `queue`, `job`, `job_id`,
  `account_id`, `error_class` and `wrapped_by` as tags, and the rest of `fields` as the `job`
  context. Where the error wraps another (`cause`), the wrapped one is reported, so failures group
  by what went wrong. `isFinalFailure(job, error)` says whether BullMQ will try the job again.

**Traces.** OpenTelemetry's Node SDK, exporting OTLP over HTTP to the endpoint, with the http,
undici (fetch), Express, Koa, MongoDB and ioredis instrumentations, and no metrics or logs
pipeline. A call to Redis, Mongo or another service is traced only inside a request or a job, so a
worker's own polling is not a trace a second. `/health` is not traced. The sampler is the SDK's, so
`OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` work as documented.

OpenTelemetry says what goes wrong only through its diag logger and its global error handler, and
both are silent until set. Here both write to the JSON log with `"component": "opentelemetry"`: an
export that fails is an error line naming the cause, and other warnings are warning lines. Setting
`OTEL_LOG_LEVEL` hands diag to the SDK at that level instead.

Before a process exits, `await flushTelemetry()` sends what is still buffered, and logs what it
could not send.

## The variables

| Variable | What it does |
|---|---|
| `CLOUDWATCH_METRICS_NAMESPACE` | The switch for metrics, and their namespace |
| `CLOUDWATCH_METRICS_APP`, `CLOUDWATCH_METRICS_ROLE` | The `App` and `Role` dimensions. Required where the namespace is set |
| `SENTRY_DSN` | The switch for errors, and where they go |
| `SENTRY_ENVIRONMENT` | The environment errors report, where it is not the destination |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The switch for traces, and where they go |
| `OTEL_SERVICE_NAME` | The service traces are attributed to |
| `KAMAL_DESTINATION` | The environment every signal reports. Outside a container, `NODE_ENV` |
| `KAMAL_VERSION` | The release errors are filed under |

A variable set to nothing counts as not set.

## Working on it

```shell
mise install
npm install
npm run check   # Biome, read-only
npm test        # node:test, against local servers standing in for Sentry and the collector
```

Node 22.12 or newer, and 24. There is no CI: the gate is `npm run check && npm test`, by exit code.
