import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const REGISTER = fileURLToPath(
  new URL("../../src/register.js", import.meta.url),
);

// Every variable the package reads, removed, so a child process starts from exactly what a test
// names and never from the environment the suite happens to run in.
const PACKAGE_VARIABLES = [
  "CLOUDWATCH_METRICS_NAMESPACE",
  "CLOUDWATCH_METRICS_APP",
  "CLOUDWATCH_METRICS_ROLE",
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
  "KAMAL_VERSION",
  "KAMAL_DESTINATION",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SERVICE_NAME",
  "TRACES_IGNORED_PATHS",
];

// Runs a fixture the way an application runs: `node --import @spillover/telemetry/register`. Resolves
// with its exit code and output.
export function runFixture(name, env = {}) {
  const base = { ...process.env, NODE_ENV: "production" };
  for (const variable of PACKAGE_VARIABLES) delete base[variable];

  return promisify(execFile)(
    process.execPath,
    [
      "--import",
      REGISTER,
      fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
    ],
    { env: { ...base, ...env } },
  ).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    ({ code, stdout, stderr }) => ({ code, stdout, stderr }),
  );
}

// A local HTTP server that records every request it is sent and answers 200: the network boundary
// Sentry and the OTLP exporter send to.
export async function recordingServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);

    requests.push({
      method: request.method,
      path: request.url,
      body: body.toString(),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The events in the envelopes Sentry sent: each envelope is newline-separated JSON, a header, then
// an item header and its payload for each item.
export function sentryEvents(requests) {
  return requests
    .filter(({ path }) => path.includes("/envelope/"))
    .flatMap(({ body }) => {
      const lines = body
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const events = [];
      for (let i = 1; i < lines.length; i += 2) {
        if (lines[i].type === "event") events.push(lines[i + 1]);
      }
      return events;
    });
}
