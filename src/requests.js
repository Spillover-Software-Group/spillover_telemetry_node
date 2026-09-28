import { state } from "./state.js";

// X-Ray accepts only annotation keys made of letters, digits and underscores.
const ANNOTATION_KEY = /^[A-Za-z0-9_]+$/;

const NONE = Object.freeze({ run: (fn) => fn(), end: () => undefined });

/**
 * A unit of work the SDK does not see as a request, such as a Socket.IO action: a trace of its own
 * and a Sentry scope of its own, like an HTTP request's. Returns `{ run, end }`:
 *
 * - `run(fn)` runs `fn` inside both, so the calls it makes are spans of this trace and the user it
 *   names with `identifyUser` is this unit's alone. Work `fn` starts and leaves running stays inside.
 * - `end(error)` ends the span, as failed where an error is given. It may come long after `run` has
 *   returned: an action is answered by another action, later.
 *
 * The span is SERVER kind for the reason a job's is: X-Ray's exporter names a root segment after the
 * service only for a SERVER span. `annotations` become attributes and X-Ray annotations.
 */
export function startRequest(name, annotations = {}) {
  const { tracer, api, Sentry } = state;
  if (!tracer && !Sentry) return NONE;

  const keys = Object.keys(annotations).filter((key) =>
    ANNOTATION_KEY.test(key),
  );
  const span = tracer?.startSpan(name, {
    kind: api.SpanKind.SERVER,
    attributes: {
      ...Object.fromEntries(keys.map((key) => [key, String(annotations[key])])),
      "aws.xray.annotations": keys,
    },
  });

  const inSpan = (fn) =>
    span
      ? api.context.with(api.trace.setSpan(api.context.active(), span), fn)
      : fn();

  let ended = false;
  return {
    run(fn) {
      if (!Sentry) return inSpan(fn);
      return Sentry.withIsolationScope(() => inSpan(fn));
    },
    end(error) {
      if (!span || ended) return;
      ended = true;
      if (error) {
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: error.message ?? String(error),
        });
      }
      span.end();
    },
  };
}
