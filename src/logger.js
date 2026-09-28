import { format } from "node:util";
import pino from "pino";

// JSON lines on stdout, each stamped with the application and the environment the metrics and the
// errors beside it report, so a staging container's lines never read as production. The log driver
// ships stdout; nothing here talks to the network. Development gets the same lines made readable.
export function createLogger(settings, { destination } = {}) {
  const options = {
    base: { app: settings.app, environment: settings.environment() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };

  if (settings.development && !destination) {
    return pino({ ...options, transport: { target: "pino-pretty" } });
  }

  // Synchronous, so a line written just before the process exits is not lost.
  return pino(
    options,
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}

const LEVELS = {
  debug: "debug",
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
};

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// One console call as one line: the text arguments make the message, a plain object's keys become
// fields of the line, and an Error becomes `err`, with its class, message and stack.
function writeLine(logger, level, args) {
  const fields = {};
  const text = [];

  for (const arg of args) {
    if (arg instanceof Error) fields.err = arg;
    else if (isPlainObject(arg)) Object.assign(fields, arg);
    else text.push(arg);
  }

  logger[level](fields, format(...text));
}

// Sends every console call through the logger, so code that still calls console.* writes the same
// JSON line as code that logs through the logger. Returns a function that puts the console back.
export function bridgeConsole(logger, target = console) {
  const originals = {};

  for (const [method, level] of Object.entries(LEVELS)) {
    originals[method] = target[method];
    target[method] = (...args) => writeLine(logger, level, args);
  }

  return () => Object.assign(target, originals);
}
