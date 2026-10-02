# @spillover/telemetry

How a Spillover Node application reports on itself: **JSON logs** and **runtime metrics** on
stdout, **errors** to Sentry, **traces** to an OTLP endpoint, all stamped with the one environment
they agree on. The Node side of the Rails gem `spillover_telemetry`, with the same variables and the
same metric document.

Each signal is off until the deploy sets its variable, and off costs nothing: its SDK is never
loaded.

## Installing it

```json
"@spillover/telemetry": "github:Spillover-Software-Group/spillover_telemetry_node#v0.1.6"
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

**A password in a URL is never written.** Every line, however it was made, has its URLs'
credentials replaced: `scheme://user:secret@host` becomes `scheme://user:***@host`, in the message,
an error's message and stack, and every field. So has every event sent to Sentry, breadcrumbs
included, since Sentry records each console call as one. A connection string reaches a log by
paths nobody chose, such as Node's warning when a library parses a multi-host URL with `url.parse`.
`redactCredentials(text)` is the same function, for an application's own use.

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
| `pulseCollector({ pulse })` | `JobsWaiting` (due, enabled, unlocked, of a name the process defines) | Count |
| | `OldestReadyJobAge`, how long ago the oldest of those fell due | Seconds |
| | `JobsFailed` (every failed run: Pulse marks no final failure), since the last document | Count |

A value with nothing to measure yet is left out rather than sent as zero. An application collector
is `{ units, values() }`, where `values` may be async and every name has a unit.

Pulse keeps its jobs in a Mongo collection, so `JobsWaiting` and `OldestReadyJobAge` are the same
from every process that reports them and are read as a Maximum; `JobsFailed` is each process's own
and is read as a Sum. A job of a name nothing defines is never run, so it is not waiting; a job a
process has locked and holds until a slot frees is not either. `OldestReadyJobAge` has the Rails
gem's name and meaning.

**Errors.** Sentry, errors only (no sample rate, `sendDefaultPii: false`), with the
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
- `runJob({ queue, name, id, system }, fn)` runs a job in a scope tagged `queue`, `job` and `job_id`,
  and in a trace of its own. `system` is the library that runs the job (`messaging.system` on its
  span), `bullmq` unless given.
- `startRequest(name, annotations)` is a unit of work the SDK does not see as a request, such as a
  Socket.IO action: `run(fn)` runs `fn` in a scope and a trace of its own, and `end(error)` ends the
  trace's span, as failed where an error is given, whenever the unit is answered, which may be long
  after `run` returned. `identifyUser` inside `run` names that unit's user alone.
- `captureError(error, { tags, context })` reports an error the application has decided is a defect,
  with searchable tags and a `details` context. Sentry sends an Error object once however often it
  is captured, so an error logged where it was caught and reported again by the failure it caused is
  one event.
- `captureJobFailure(fields, error)`, for a final failure that is a defect, reports a failed job with `queue`, `job`, `job_id`,
  `account_id`, `error_class` and `wrapped_by` as tags, and the rest of `fields` as the `job`
  context. Where the error wraps another (`cause`), the wrapped one is reported, so failures group
  by what went wrong. `isFinalFailure(job, error)` says whether BullMQ will try the job again.

**Traces.** OpenTelemetry's Node SDK, exporting OTLP over HTTP to the endpoint, with the http,
undici (fetch), Express, Koa, MongoDB, ioredis and node-redis (`redis` v4 and v5) instrumentations,
and no metrics or logs pipeline. A call to Redis, Mongo or another service is traced only inside a
request or a job, so a worker's own polling is not a trace a second; a call span with nothing above
it, such as node-redis's connect, which its instrumentation cannot be told to skip, is left out of
the export. A node-redis command's span records the command's name and none of its arguments, which
are the keys and values themselves. A request for one of `TRACES_IGNORED_PATHS` (by
default `/health`) is not traced: a health check, or a transport's own polling. The sampler is the SDK's, so
`OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` work as documented.

What X-Ray makes of them, which the collector's `awsxray` exporter decides:

- **A job's span is SERVER kind, on purpose.** The semantic conventions would say CONSUMER, but the
  exporter names a root segment after the service only for a SERVER span, and after the span
  otherwise. As CONSUMER, every task was a service of its own and a search by the application's name
  found none of them. Do not "correct" it.
- **So is a unit started with `startRequest`**, and its annotations become X-Ray annotations the same
  way (keys X-Ray would refuse are left out).
- **A job is searchable by its task.** Its span carries `job_queue`, `job_name` and `job_id`, and
  lists them in `aws.xray.annotations`, which the exporter indexes as annotations with no change to
  the collector: `annotation.job_name = "messages.fetch"`. The names use underscores because X-Ray
  filters only annotation keys made of letters, digits and underscores.
- **A call names its dependency.** A client span gets a `peer.service`: `mongodb` or `redis` from the
  database system, or the host of an outbound HTTP call. The exporter names the downstream node by
  it, so the service map shows each dependency once rather than a node per query, command or method.

Sentry records no spans. Its sample rate is left unset rather than set to 0: Sentry counts any rate
as spans on and then instruments HTTP, Koa and the databases itself, and those spans reached the
exporter too, a second SERVER span per request that ignored `TRACES_IGNORED_PATHS`.

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
| `TRACES_IGNORED_PATHS` | Comma-separated paths whose incoming requests start no trace; an entry ending in `/` covers every path under it. Default `/health` |
| `KAMAL_DESTINATION` | The environment every signal reports. Outside a container, `NODE_ENV` |
| `KAMAL_VERSION` | The release errors are filed under |

A variable set to nothing counts as not set.

## Working on it

```shell
mise install
npm install
npm run check   # Biome, read-only
npm test        # node:test, against local servers standing in for Sentry and the collector
node bin/check-xray-names.js   # the spans through the real awsxray exporter, in Docker
```

Node 20.19 or newer on the 20 line, 22.12 or newer, and 24: from those versions an application
written in CommonJS can `require` this package, which is an ES module. The suite runs on the
`mise.toml` Node; run it under each line's Node too when a change could differ between them. There
is no CI: the gate is `npm run check && npm test`, by exit code.
