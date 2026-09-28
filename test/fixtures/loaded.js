// Says whether Sentry or an OpenTelemetry SDK is loaded in this process.
const otel = Object.getOwnPropertySymbols(globalThis).some((symbol) =>
  String(symbol).includes("opentelemetry"),
);
process.stdout.write(
  `${JSON.stringify({ sentry: globalThis.__SENTRY__ !== undefined, otel })}\n`,
);
