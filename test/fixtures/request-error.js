// An error inside an HTTP request, sent by a client with everything a request can carry.
import { once } from "node:events";
import { createServer } from "node:http";
import * as Sentry from "@sentry/node";
import { flushTelemetry } from "../../src/index.js";

const server = createServer((_request, response) => {
  Sentry.captureException(new Error("failed inside a request"));
  response.end("ok");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

await fetch(
  `http://127.0.0.1:${server.address().port}/reports/7?token=secret-query`,
  {
    method: "POST",
    headers: {
      "User-Agent": "reports-client/1.0",
      Cookie: "session=secret-cookie",
      Authorization: "Bearer secret-token",
      Referer: "https://example.com/?code=secret-referer",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: "secret-body" }),
  },
).then((response) => response.text());

server.close();
await flushTelemetry();
