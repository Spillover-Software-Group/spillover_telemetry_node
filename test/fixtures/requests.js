// A server under the package, asked for a health check, a transport's poll and a real path; then two
// units of work started with startRequest, one answered and one failed, the first making a call.
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { flushTelemetry, startRequest } from "../../src/index.js";

const target = process.env.FIXTURE_TARGET;

const server = createServer((_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1");
await once(server, "listening");

// Over a plain socket, as a request from outside arrives: no SDK in this process gets to add its
// trace headers on the way out.
function get(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.address().port, "127.0.0.1", () =>
      socket.end(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.on("data", () => undefined);
    socket.on("end", resolve);
    socket.on("error", reject);
  });
}

await Promise.all(
  ["/api/health", "/socket.io/?EIO=4&transport=polling", "/api/things"].map(
    get,
  ),
);

const answered = startRequest("socket POSTS_GET", {
  action: "POSTS_GET",
  "not a key": "left out",
});
await answered.run(() =>
  fetch(`${target}/inside-an-action`).then((response) => response.text()),
);
answered.end();

const failed = startRequest("socket POSTS_ADD", { action: "POSTS_ADD" });
failed.run(() => undefined);
failed.end(new Error("No account"));

server.close();
await flushTelemetry();
