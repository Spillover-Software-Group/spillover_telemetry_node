// A connection string with a password, printed as a warning and then carried by an error: both reach
// Sentry, the first as a breadcrumb of the second.
import * as Sentry from "@sentry/node";
import { flushTelemetry } from "../../src/index.js";

const url = "mongodb://senalysis:PLANTED-SECRET@ac-1.example.net:27017/db";

console.warn(`The URL ${url} is invalid.`);
Sentry.captureException(new Error(`connect ECONNREFUSED ${url}`));

await flushTelemetry();
