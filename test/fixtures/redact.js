// A database password planted in everything a line can carry: the message, an error's message and
// stack, a field, a nested field, through the logger and through the bridged console, and in the
// warning Node prints for a legacy parse of a multi-host connection string.
import { parse } from "node:url";
import { getLogger } from "../../src/index.js";

const url =
  "mongodb://senalysis:PLANTED-SECRET@ac-1.example.net:27017,ac-2.example.net:27017/db";

getLogger().info(
  { uri: url, nested: { connection: { uri: url } } },
  `connecting to ${url}`,
);
console.error(`could not connect to ${url}`, new Error(`failed on ${url}`));
parse(url);
