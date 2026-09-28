#!/usr/bin/env node
// Sends this package's spans through the real X-Ray exporter, the AWS collector image in Docker, and
// checks the segments it would send to X-Ray: a job's segment named after the service and carrying
// its annotations, and its Mongo and Redis calls named as those dependencies. `npm test` checks the
// spans this package exports; this checks what X-Ray's own translation makes of them. It needs
// Docker, and exits non-zero on any difference.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { runFixture } from "../test/helpers/process.js";

const IMAGE =
  process.env.COLLECTOR_IMAGE ??
  "public.ecr.aws/aws-observability/aws-otel-collector:latest";
const SERVICE = "senalysis-data-exchange";

const EXPECTED = {
  root: SERVICE,
  annotations: {
    job_id: "1",
    job_name: "messages.fetch",
    job_queue: "facebook",
  },
  children: ["classify sentiment", "mongodb", "redis"],
};

// Resolves once `ready()` is true, trying every 200 ms for ten seconds at most.
async function waitFor(ready, attempts = 50) {
  if ((await ready()) || attempts === 0) return;
  await delay(200);
  await waitFor(ready, attempts - 1);
}

// X-Ray's PutTraceSegments, stood in for: records the segment documents and accepts them all.
async function startXray(segments) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    for (const document of body.TraceSegmentDocuments ?? []) {
      segments.push(JSON.parse(document));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ UnprocessedTraceSegments: [] }));
  });
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  return server;
}

// The collector as the hosts run it, with its X-Ray exporter sent to the stand-in instead of AWS.
function startCollector(xrayPort) {
  const config = join(
    mkdtempSync(join(tmpdir(), "xray-names-")),
    "collector.yaml",
  );
  writeFileSync(
    config,
    `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  awsxray:
    region: us-east-2
    endpoint: http://host.docker.internal:${xrayPort}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [awsxray]
`,
  );

  const container = execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "-p",
    "127.0.0.1::4318",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    "AWS_ACCESS_KEY_ID=check",
    "-e",
    "AWS_SECRET_ACCESS_KEY=check",
    "-v",
    `${config}:/etc/collector.yaml:ro`,
    IMAGE,
    "--config",
    "/etc/collector.yaml",
  ])
    .toString()
    .trim();
  const port = execFileSync("docker", ["port", container, "4318/tcp"])
    .toString()
    .trim()
    .split(":")
    .at(-1);

  return { container, endpoint: `http://127.0.0.1:${port}` };
}

async function check(segments, collector) {
  // The collector takes a moment to listen.
  await waitFor(() =>
    fetch(`${collector}/v1/traces`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }).then(
      () => true,
      () => false,
    ),
  );

  await runFixture("dependencies.js", {
    OTEL_EXPORTER_OTLP_ENDPOINT: collector,
    OTEL_SERVICE_NAME: SERVICE,
  });
  await waitFor(() => segments.length >= EXPECTED.children.length + 1);

  const root = segments.find((segment) => !segment.parent_id);
  const actual = {
    root: root?.name,
    annotations: root?.annotations,
    children: segments
      .filter((segment) => segment.parent_id)
      .map((segment) => segment.name)
      .sort(),
  };

  console.log(JSON.stringify(actual));
  return isDeepStrictEqual(actual, EXPECTED);
}

const recorded = [];
const xray = await startXray(recorded);
const { container, endpoint } = startCollector(xray.address().port);

let named = false;
try {
  named = await check(recorded, endpoint);
} finally {
  execFileSync("docker", ["rm", "-f", container]);
  xray.close();
}

console.log(
  named
    ? "X-Ray's exporter names the segments as intended."
    : `X-Ray's exporter names them otherwise; expected ${JSON.stringify(EXPECTED)}`,
);
process.exit(named ? 0 : 1);
