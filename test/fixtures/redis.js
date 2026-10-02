// node-redis against a stand-in that speaks enough of Redis's protocol to answer it: a connect and a
// command outside any job, then a SET and a GET inside one, then a flush. The stand-in prints every
// command it was sent, as JSON on stderr, so a test can see the arguments really went over the wire.
import { once } from "node:events";
import { createServer } from "node:net";
import { createClient } from "redis";
import { flushTelemetry, runJob } from "../../src/index.js";

// Splits RESP arrays of bulk strings (`*2\r\n$3\r\nGET\r\n$1\r\nk\r\n`) off the front of `buffer`.
function takeCommands(buffer) {
  const commands = [];
  let rest = buffer;

  for (;;) {
    const text = rest.toString("latin1");
    const header = /^\*(\d+)\r\n/.exec(text);
    if (!header) break;

    let offset = header[0].length;
    const args = [];
    for (let index = 0; index < Number(header[1]); index += 1) {
      const length = /^\$(\d+)\r\n/.exec(text.slice(offset));
      if (!length) break;
      const start = offset + length[0].length;
      const end = start + Number(length[1]);
      if (text.length < end + 2) break;
      args.push(text.slice(start, end));
      offset = end + 2;
    }
    if (args.length < Number(header[1])) break;

    commands.push(args);
    rest = rest.subarray(offset);
  }

  return { commands, rest };
}

function reply([name]) {
  const command = name.toUpperCase();
  if (command === "GET") return "$-1\r\n";
  if (command === "PING") return "+PONG\r\n";
  return "+OK\r\n";
}

const received = [];
const standIn = createServer((socket) => {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    const { commands, rest } = takeCommands(Buffer.concat([pending, chunk]));
    pending = rest;
    for (const command of commands) {
      received.push(command);
      socket.write(reply(command));
    }
  });
});
standIn.listen(0, "127.0.0.1");
await once(standIn, "listening");

const client = createClient({
  url: `redis://127.0.0.1:${standIn.address().port}`,
});
await client.connect();
await client.set("outside:a-job", "1");

await runJob({ queue: "orders", name: "orders.create", id: "7" }, async () => {
  await client.set("order:lock:idem-key-123", "secret-value-456", {
    NX: true,
    EX: 120,
  });
  await client.get("poshub:handoff:token-789");
});

await client.disconnect();
standIn.close();
await flushTelemetry();
process.stderr.write(`${JSON.stringify(received)}\n`);
