// Loopback gateway between DSH's llm-pi-ai layer and Factory's inference
// routes.
//
// llm-pi-ai talks plain OpenAI chat/completions and Anthropic Messages to
// `http://127.0.0.1:<dsh-port><prefix>/…`; this gateway attaches the Factory
// credential (the selected API key or FACTORY_API_KEY), applies the per-route
// header/body rules observed from the official CLI, forwards to the inference
// host (prem.factory.ai — where whoami's premBaseHostV2 points), and streams
// the reply back untouched — including SSE. Client attribution headers are
// never forwarded.
//
// Guards: loopback callers only (the gateway consumes subscription quota, and
// dsh web may bind 0.0.0.0 for LAN access). An upstream 401 triggers exactly
// one forced refresh + retry before the failure surfaces to the caller.

import { randomUUID, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { ROUTES } from "./catalog.js";
import { journal } from "./journal.js";
import { createSessionIdMap, sessionKeyParts } from "./session.js";
import {
  sanitizeAnthropicPayload,
  normalizeGenericPayload,
  normalizeResponsesPayload,
  filterAnthropicBeta,
  DROID_SYSTEM_LINE,
} from "./sanitize.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15 * 60_000;
const ANTHROPIC_VERSION = "2023-06-01";
const FAST_MODE_BETA = "fast-mode-2026-02-01";
const FAST_MODE_IDS = new Set(
  ROUTES.anthropic.models.filter((m) => m.anthropicFastMode).map((m) => m.id),
);
const GENERIC_PROVIDER_BY_MODEL = Object.fromEntries(
  ROUTES.generic.models.map((m) => [m.id, m.apiProvider ?? "fireworks"]),
);
const OPENAI_PROVIDER_BY_MODEL = Object.fromEntries(
  ROUTES.openai.models.map((m) => [m.id, m.apiProvider ?? "azure_openai"]),
);
// The openai-platform header droid carries on the azure_openai/responses path.
// A build-time constant in the droid binary (not per-account state — whoami,
// feature-flags and the session endpoints never hand it out).
const OPENAI_PLATFORM = "org-bHuLtG1fGmYk5YaOihAAXFBw";
// The inference host droid's whoami hands out (premBaseHostV2).
const DEFAULT_API_BASE = "https://prem.factory.ai";
// Plugin version, surfaced on /status so the running host's module generation
// is checkable without log access.
const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function isLoopback(req) {
  const addr = req.socket?.remoteAddress;
  if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") return false;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  let url;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
}

function writeJson(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  // A top-level `message` is what pi-ai's error formatter surfaces
  // (`${status} ${msg}`); without one every failure degrades to "401
  // unauthorized" and the real cause is lost.
  if (value?.error?.message !== undefined && value.message === undefined) {
    value.message = value.error.message;
  }
  res.end(JSON.stringify(value));
}

function shapeOf(parsed) {
  const isResponses = Array.isArray(parsed?.input);
  const messages = isResponses
    ? parsed.input
    : Array.isArray(parsed?.messages)
      ? parsed.messages
      : [];
  const hasImage = messages.some((m) =>
    Array.isArray(m?.content)
      ? m.content.some((b) => b?.type === "image" || b?.type === "input_image" || b?.source?.type === "base64")
      : false,
  );
  return {
    model: typeof parsed?.model === "string" ? parsed.model : undefined,
    messages: messages.length,
    hasImage,
    tools: Array.isArray(parsed?.tools) ? parsed.tools.length : 0,
    thinking: parsed?.thinking === undefined ? undefined : parsed.thinking.type ?? true,
    effort: parsed?.output_config?.effort ?? parsed?.reasoning_effort ?? parsed?.reasoning?.effort,
    maxTokens: parsed?.max_tokens ?? parsed?.max_output_tokens,
    stream: parsed?.stream === true,
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function clientHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function createGateway({
  resolver,
  enabledRoutes = ["anthropic", "generic"],
  gatewayPrefix,
  apiBaseURL = DEFAULT_API_BASE,
  cliVersion = "0.231.0",
  fetchImpl = fetch,
  logger,
  pluginState,
} = {}) {
  let upstreamMessages = `${apiBaseURL.replace(/\/+$/, "")}/api/llm/a/v1/messages`;
  let upstreamCompletions = `${apiBaseURL.replace(/\/+$/, "")}/api/llm/o/v1/chat/completions`;
  let upstreamResponses = `${apiBaseURL.replace(/\/+$/, "")}/api/llm/o/v1/responses`;
  let activeRoutes = [...enabledRoutes];
  let version = cliVersion;
  // One stable session id per conversation (account × model × system × first
  // user message), mirroring the official CLI's session-scoped id — a random
  // per-request id destroys Factory's session affinity and prompt-cache
  // locality. See lib/session.js.
  const sessions = createSessionIdMap();
  const routeEnabled = (route) => activeRoutes.includes(route);

  // Header set mirroring the official CLI's own requests (the edge's gate is
  // picky about the request looking like droid). openai-platform is only sent
  // on the azure/responses path — a static CLI constant, not per-account. The
  // stainless package version differs per route (OpenAI SDK 6.25.0 vs Anthropic
  // SDK 0.70.1), exactly as in the captured CLI traffic.
  function authHeaders(token, orgId, packageVersion) {
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "user-agent": `factory-cli/${version}`,
      "x-client-version": version,
      "x-factory-client": "cli",
      "x-stainless-arch": process.arch,
      "x-stainless-lang": "js",
      "x-stainless-os": "MacOS",
      "x-stainless-package-version": packageVersion,
      "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": process.version,
      "x-provider-routing-source": "configured_order",
      traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
    };
    if (orgId) headers["X-Factory-Org-Id"] = orgId;
    return headers;
  }

  // SDK versions the official CLI presents per route (from captured traffic).
  const OPENAI_SDK_VERSION = "6.25.0";
  const ANTHROPIC_SDK_VERSION = "0.70.1";

  /** One forwarded attempt. */
  async function send(route, token, orgId, req, parsed, clientSignal) {
    const { system, firstUser } = sessionKeyParts(route, parsed);
    const headers = {
      ...authHeaders(
        token,
        orgId,
        route === "anthropic" ? ANTHROPIC_SDK_VERSION : OPENAI_SDK_VERSION,
      ),
      "content-type": "application/json",
      "x-session-id": sessions.derive({ orgId, model: parsed?.model, system, firstUser }),
    };
    // The timeout bounds a slow upstream; the client signal bounds a caller
    // that already went away. Either one must reach fetch.
    const signal =
      clientSignal === undefined
        ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        : AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), clientSignal]);
    if (route === "anthropic") {
      // Captured from the official CLI's own a-route requests.
      headers["x-api-provider"] = "bedrock_anthropic";
      headers["x-api-key"] = "placeholder";
      headers["x-stainless-timeout"] = "600";
      headers["x-assistant-message-id"] = randomUUID();
      headers["anthropic-version"] = clientHeader(req, "anthropic-version") ?? ANTHROPIC_VERSION;
      let beta = filterAnthropicBeta(clientHeader(req, "anthropic-beta"), parsed);
      if (typeof parsed?.model === "string" && FAST_MODE_IDS.has(parsed.model)) {
        if (!parsed.speed) parsed.speed = "fast";
        if (!beta.split(",").includes(FAST_MODE_BETA)) {
          beta = beta ? `${beta},${FAST_MODE_BETA}` : FAST_MODE_BETA;
        }
      }
      if (beta) headers["anthropic-beta"] = beta;
      return fetchImpl(upstreamMessages, { method: "POST", headers, body: JSON.stringify(parsed), signal });
    }
    if (route === "openai") {
      // Captured from the official CLI's own /responses requests (GPT family).
      headers["x-api-provider"] = OPENAI_PROVIDER_BY_MODEL[parsed?.model] ?? "azure_openai";
      headers["openai-platform"] = OPENAI_PLATFORM;
      headers["x-assistant-message-id"] = randomUUID();
      return fetchImpl(upstreamResponses, { method: "POST", headers, body: JSON.stringify(parsed), signal });
    }
    headers["x-api-provider"] = GENERIC_PROVIDER_BY_MODEL[parsed?.model] ?? "fireworks";
    return fetchImpl(upstreamCompletions, { method: "POST", headers, body: JSON.stringify(parsed), signal });
  }

  /** Shared POST pipeline: guard → token → sanitize → forward (401: one forced
   * refresh + retry) → stream the upstream reply back. */
  async function forwardInner(route, req, res) {
    if (!isLoopback(req)) {
      writeJson(res, 403, { error: { type: "forbidden", message: "factory gateway: loopback callers only" } });
      return;
    }
    if (!routeEnabled(route)) {
      writeJson(res, 404, { error: { type: "not_found", message: `factory gateway: route "${route}" is disabled` } });
      return;
    }
    // Watch the response, not the request: the request body has already been
    // read, so req "close" says nothing about whether the caller is still
    // there. Registered before the upstream call so a cancel during the wait
    // for response headers aborts it too.
    const clientAbort = new AbortController();
    const onClientGone = () => {
      if (!res.writableFinished) clientAbort.abort();
    };
    res.on("close", onClientGone);

    const bodyText = await readBody(req);
    if (bodyText === undefined) {
      writeJson(res, 413, { error: { type: "invalid_request_error", message: "factory gateway: request body too large" } });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      writeJson(res, 400, { error: { type: "invalid_request_error", message: "factory gateway: body must be JSON" } });
      return;
    }
    if (route === "anthropic") sanitizeAnthropicPayload(parsed);
    else if (route === "openai") normalizeResponsesPayload(parsed);
    else normalizeGenericPayload(parsed);

    let credential = await resolver.resolve();
    if (credential?.token === undefined) {
      journal({ route, event: "no-credential", shape: shapeOf(parsed) });
      writeJson(res, 401, {
        error: {
          type: "authentication_error",
          message:
            credential?.source === "disabled"
              ? "dsh-factory-provider: credential serving is off — the API key in use was deleted. Pick or paste a key in Settings → Factory (Droid), or set FACTORY_API_KEY."
              : "dsh-factory-provider: no Factory API key. Paste one in Settings → Factory (Droid), or set FACTORY_API_KEY.",
        },
      });
      return;
    }
    const startedAt = Date.now();
    let upstream = await send(route, credential.token, credential.orgId, req, parsed, clientAbort.signal);
    if (upstream.status === 401) {
      const refreshed = await resolver.forceRefresh();
      if (refreshed?.token !== undefined) {
        // The first reply is not going to be used; release it instead of
        // leaving its body open.
        try {
          await upstream.body?.cancel();
        } catch {
          /* already gone */
        }
        upstream = await send(route, refreshed.token, refreshed.orgId, req, parsed, clientAbort.signal);
      }
    }
    journal({
      route,
      event: "forward",
      shape: shapeOf(parsed),
      ms: Date.now() - startedAt,
      upstreamStatus: upstream.status,
    });
    if (upstream.status >= 400) {
      // Capture request/response detail for an unexplained or bodyless
      // upstream failure. Bodies are head-truncated; tokens never journaled.
      try {
        const respText = (await upstream.clone().text()).slice(0, 800);
        const parts = sessionKeyParts(route, parsed);
        journal({
          route,
          event: "upstream-error",
          upstreamStatus: upstream.status,
          request: {
            systemHead: String(parts.system).slice(0, 300),
            firstUserHead: String(parts.firstUser).slice(0, 200),
          },
          responseBody: respText,
        });
      } catch {
        /* best-effort diagnostics */
      }
    }
    if (upstream.status === 402) {
      logger?.warn?.(
        "dsh-factory-provider: upstream 402 — Factory standard usage quota is exhausted (rolling 5h/7d/30d windows); requests fall back to Droid Core or Extra Usage",
      );
    }

    res.statusCode = upstream.status;
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);
    const requestId = upstream.headers.get("request-id") ?? upstream.headers.get("x-request-id");
    if (requestId) res.setHeader("x-request-id", requestId);

    // Stream the reply through untouched (SSE included); a client abort tears
    // down the upstream request instead of leaking it.
    if (upstream.body === null) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", (error) => {
      // A cancelled upstream is the expected outcome of a client disconnect.
      if (clientAbort.signal.aborted) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      logger?.warn?.(`dsh-factory-provider: upstream stream error: ${error.message}`);
      if (!res.headersSent) writeJson(res, 502, { error: { type: "api_error", message: error.message } });
      else res.destroy();
    });
    // Tearing the readable down cancels the underlying web stream, which is
    // what stops Factory from generating (and billing) for a caller that left.
    clientAbort.signal.addEventListener("abort", () => stream.destroy(new Error("client disconnected")), { once: true });
    res.on("close", () => {
      if (!res.writableFinished) stream.destroy(new Error("client disconnected"));
    });
    stream.pipe(res);
  }

  /** Public entry for every route handler: one guard around the whole pipeline
   * so a failure that happens before Factory ever answers — credential read,
   * outbound fetch, request-body read — is journaled and surfaced as a message
   * instead of vanishing into the webserver's bodiless 400. Such a failure
   * writes no forward record, which used to make it indistinguishable from
   * "the request never reached the gateway at all". */
  async function forward(route, req, res) {
    try {
      await forwardInner(route, req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause = error?.cause;
      journal({
        route,
        event: "handler-error",
        error: message,
        cause:
          cause instanceof Error
            ? cause.message
            : cause === undefined
              ? undefined
              : String(cause),
      });
      logger?.warn?.(`dsh-factory-provider: request failed before the upstream call: ${message}`);
      if (!res.headersSent) {
        writeJson(res, 502, {
          error: {
            type: "api_error",
            message: `dsh-factory-provider: request failed before reaching Factory — ${message}`,
          },
        });
      } else {
        res.destroy();
      }
    }
  }

  function modelsHandler(route) {
    return async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { error: { type: "forbidden", message: "factory gateway: loopback callers only" } });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(res, 405, { error: { type: "method_not_allowed", message: "factory gateway: models listing is GET" } });
        return;
      }
      if (!routeEnabled(route)) {
        writeJson(res, 404, { error: { type: "not_found", message: `factory gateway: route "${route}" is disabled` } });
        return;
      }
      writeJson(res, 200, {
        object: "list",
        // The same filter the provider entries use: a region-gated id is listed
        // by the edge but answers 400 here, so advertising it would hand a
        // caller a model it cannot use.
        data: ROUTES[route].models
          .filter((m) => m.regionGated !== true)
          .map((m) => ({
            id: m.id,
            object: "model",
            created: 0,
            owned_by: "factory",
          })),
      });
    };
  }

  async function statusHandler(req, res) {
    if (!isLoopback(req)) {
      writeJson(res, 403, { error: { type: "forbidden", message: "factory gateway: loopback callers only" } });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeJson(res, 405, { error: { type: "method_not_allowed", message: "factory gateway: status is GET" } });
      return;
    }
    const credential = resolver.state();
    const state = credential.source === "unknown" ? await resolver.resolve() : credential;
    // A credential that is missing (nothing saved, nothing selected) or
    // switched off is what the card turns into "paste a key" guidance.
    const missing =
      state?.source === "none" || state?.source === "error" || state?.source === "unknown";
    writeJson(res, 200, {
      ok: true,
      // Which module generation the host is running: a host older than the
      // last source edit reports the old version here.
      version: PLUGIN_VERSION,
      credential: {
        source: state?.source ?? "unknown",
        expiresAt: state?.expiresAt ?? null,
        orgId: state?.orgId ?? null,
        // A key never expires, so there is no expiry or keyring to report; a
        // missing credential is simply "no key saved or selected".
        hint: missing ? "add-api-key" : undefined,
      },
      plugin: pluginState === undefined ? undefined : pluginState(),
      upstream: apiBaseURL,
      gatewayPrefix,
      routes: Object.fromEntries(
        Object.keys(ROUTES).map((route) => [
          route,
          {
            enabled: routeEnabled(route),
            providerKey: ROUTES[route].key,
            models: ROUTES[route].models.length,
          },
        ]),
      ),
    });
  }

  const routes = [
    {
      kind: "exact",
      path: `${gatewayPrefix}/status`,
      handler: statusHandler,
    },
  ];
  for (const route of ["anthropic", "generic", "openai"]) {
    // Every route is registered even when it is switched off, so a caller gets
    // this plugin's explicit "route is disabled" 404 instead of falling through
    // to the host's generic 401 — and so a route switched off at runtime (which
    // cannot unregister anything) behaves exactly like one switched off at
    // startup.
    const sub = route === "anthropic" ? "a" : route === "generic" ? "o" : "openai";
    for (const tail of route === "anthropic"
      ? ["messages"]
      : route === "generic"
        ? ["chat/completions"]
        : ["responses"]) {
      routes.push({
        kind: "exact",
        path: `${gatewayPrefix}/${sub}/v1/${tail}`,
        handler: (req, res) => forward(route, req, res),
      });
    }
    routes.push({
      kind: "exact",
      path: `${gatewayPrefix}/${sub}/v1/models`,
      handler: modelsHandler(route),
    });
  }
  /** Live reconfiguration from the settings card: routes, inference host,
   *  and the CLI version presented to Factory's edge. */
  function configure(next) {
    if (Array.isArray(next?.routes)) activeRoutes = [...next.routes];
    if (typeof next?.apiBaseURL === "string" && next.apiBaseURL.length > 0) {
      const root = next.apiBaseURL.replace(/\/+$/, "");
      upstreamMessages = `${root}/api/llm/a/v1/messages`;
      upstreamCompletions = `${root}/api/llm/o/v1/chat/completions`;
      upstreamResponses = `${root}/api/llm/o/v1/responses`;
    }
    if (typeof next?.cliVersion === "string" && next.cliVersion.length > 0) version = next.cliVersion;
  }

  /** End-to-end self-test for the settings card: drives the real forward
   *  pipeline (guard → credential → sanitize → upstream → stream back) with
   *  mock req/res and a tiny prompt. Never bills a real conversation. */
  async function probe(route, model) {
    const target = ROUTES[route] === undefined ? "anthropic" : route;
    // The test button bills the subscription too, so it obeys the same switch
    // as the forwarding handlers.
    if (!routeEnabled(target)) {
      return { ok: false, status: 0, route: target, model: model ?? "", body: `route "${target}" is disabled` };
    }
    const modelId =
      typeof model === "string" && model.length > 0
        ? model
        : target === "anthropic"
          ? "claude-haiku-4-5-20251001"
          : target === "openai"
            ? "gpt-6-luna"
            : "glm-5.3-flash";
    // gpt-6-luna is the deliberate probe default on the openai route: the
    // cheapest model in the catalog (0.04x), since every probe bills the
    // subscription. Same reasoning picks glm-5.3-flash (0.06x) on generic.
    const payload =
      target === "openai"
        ? {
            model: modelId,
            instructions: DROID_SYSTEM_LINE,
            input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: PONG" }] }],
            max_output_tokens: 16,
            stream: false,
            store: false,
          }
        : {
            model: modelId,
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with exactly: PONG" }],
          };
    const req = {
      method: "POST",
      headers: { "content-type": "application/json", host: "127.0.0.1:1" },
      socket: { remoteAddress: "127.0.0.1" },
      on() {},
      off() {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(payload));
      },
    };
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const res = {
      statusCode: 200,
      headers: {},
      body: "",
      writableEnded: false,
      setHeader(key, value) {
        this.headers[key] = value;
      },
      writeHead(code, extra) {
        this.statusCode = code;
        if (extra) Object.assign(this.headers, extra);
      },
      write(chunk) {
        this.body += String(chunk);
        return true;
      },
      end(chunk) {
        if (chunk) this.body += String(chunk);
        this.writableEnded = true;
        resolveDone({
          ok: this.statusCode >= 200 && this.statusCode < 300,
          status: this.statusCode,
          model: modelId,
          route: target,
          body: this.body.slice(0, 400),
        });
      },
      on() {},
      once() {},
      emit() {},
      pipe() {},
      destroy() {},
      removeListener() {},
    };
    const timer = setTimeout(
      () => resolveDone({ ok: false, status: 0, route: target, model: modelId, body: "probe timed out" }),
      60_000,
    );
    try {
      await forward(target, req, res);
    } catch (error) {
      resolveDone({
        ok: false,
        status: -1,
        route: target,
        model: modelId,
        body: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
    const result = await done;
    clearTimeout(timer);
    journal({ route: target, event: "probe", shape: { model: modelId }, upstreamStatus: result.status });
    return result;
  }

  return { routes, configure, probe, isLoopback };
}
