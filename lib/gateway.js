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

import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { createProviderRouter, retryableProviderStatus, streamFailure, FACTORY_ATTEMPT_HEADER, FACTORY_PREVIOUS_FAILURE_HEADER } from './provider-routing.js';
import { ROUTES, servableModels } from "./catalog.js";
import { clampFactoryOutputTokens, factoryModelLimits } from "./model-limits.js";
import { DEFAULT_REQUEST_MAX_BYTES, requestSizeBreakdown } from "./request-size.js";
import { applyAnthropicCacheBreakpoints, fingerprintAnthropicPayload } from "./cache.js";
import { journal } from "./journal.js";
import { recordTokenUsage } from "./usage.js";
import { createSessionIdMap, sessionKeyParts } from "./session.js";
import { FACTORY_REQUEST_PURPOSE_HEADER, FACTORY_REQUEST_SESSION_HEADER } from "./request-purpose.js";
import { createToolClearBatches } from "./tool-clear.js";
import {
  sanitizeAnthropicPayload,
  normalizeGenericPayload,
  normalizeResponsesPayload,
  filterAnthropicBeta,
  DROID_SYSTEM_LINE,
} from "./sanitize.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const UPSTREAM_TIMEOUT_MS = 15 * 60_000;
const ANTHROPIC_VERSION = "2023-06-01";
const FAST_MODE_BETA = "fast-mode-2026-02-01";
const FAST_MODE_IDS = new Set(
  ROUTES.anthropic.models.filter((m) => m.anthropicFastMode).map((m) => m.id),
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
  let imageBlocks = 0;
  let imageBase64Bytes = 0;
  const inspect = blocks => {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type === "image" || block?.type === "input_image" || block?.type === "image_url") {
        imageBlocks++;
        if (block.source?.type === "base64" && typeof block.source.data === "string") {
          imageBase64Bytes += Buffer.byteLength(block.source.data);
        }
        const url = block.image_url?.url ?? block.image_url;
        if (typeof url === "string" && url.startsWith("data:") && url.includes(";base64,")) {
          imageBase64Bytes += Buffer.byteLength(url.slice(url.indexOf(";base64,") + 8));
        }
      } else if (block?.type === "tool_result") inspect(block.content);
    }
  };
  for (const message of messages) {
    inspect(message?.content);
    if (message?.type === "function_call_output") inspect(message.output);
  }
  return {
    model: typeof parsed?.model === "string" ? parsed.model : undefined,
    messages: messages.length,
    hasImage: imageBlocks > 0,
    imageBlocks,
    imageBase64Bytes,
    bodyBytes: Buffer.byteLength(JSON.stringify(parsed)),
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
  cacheMode = "auto",
  cacheTTL = "5m",
  toolClear = false,
  toolClearKeep = 3,
  toolClearTrigger = 20000,
  toolClearBatchTokens = 20000,
  requestMaxBytes = DEFAULT_REQUEST_MAX_BYTES,
  fetchImpl = fetch,
  routingFetch,
  routingConfig,
  preferAnthropic = false,
  routingHost = 'https://api.factory.ai',
  inferenceRegion = 'global',
  logger,
  pluginState,
} = {}) {
  let upstreamMessages = `${apiBaseURL.replace(/\/+$/, "")}/api/llm/a/v1/messages`;
  let upstreamCompletions = `${apiBaseURL.replace(/\/+$/, "")}/api/llm/o/v1/chat/completions`;
  let upstreamResponses = `${apiBaseURL.replace(/\/+$/, "")}/api/llm/o/v1/responses`;
  let activeRoutes = [...enabledRoutes];
  let version = cliVersion;
  let anthropicCacheMode = cacheMode;
  let anthropicCacheTTL = cacheTTL;
  let anthropicToolClear = toolClear;
  let anthropicToolClearKeep = toolClearKeep;
  let anthropicToolClearTrigger = toolClearTrigger;
  let anthropicToolClearBatchTokens = toolClearBatchTokens;
  const toolClearBatches = createToolClearBatches();
  let finalBodyBudget = Number.isInteger(requestMaxBytes) && requestMaxBytes >= 0 && requestMaxBytes <= MAX_BODY_BYTES
    ? requestMaxBytes : DEFAULT_REQUEST_MAX_BYTES;
  // One stable session id per conversation (account × model × system × first
  // user message), mirroring the official CLI's session-scoped id — a random
  // per-request id destroys Factory's session affinity and prompt-cache
  // locality. See lib/session.js.
  const sessions = createSessionIdMap();
  const providerRouter = createProviderRouter({ fetchConfig: routingFetch, config: routingConfig, preferAnthropic });
  providerRouter.configure({ host: routingHost });
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
      traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
    };
    if (orgId) headers["X-Factory-Org-Id"] = orgId;
    return headers;
  }

  // SDK versions the official CLI presents per route (from captured traffic).
  const OPENAI_SDK_VERSION = "6.25.0";
  const ANTHROPIC_SDK_VERSION = "0.70.1";

  /** Pull token accounting out of a response without keeping it. Anthropic
   *  reports usage across message_start / message_delta; the OpenAI shapes put
   *  it on the final chunk. Fields are merged with max(), so a cumulative value
   *  repeated in a later event is not counted twice. */
  function usageFromEvent(event, into) {
    const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    const bump = (key, value) => {
      if (value !== undefined) into[key] = Math.max(into[key] ?? 0, value);
    };
    // Backend edits explain cache-write spikes even when outgoing history is
    // append-only. Keep only counters, never cleared content or tool names.
    const applied = event?.context_management?.applied_edits ?? event?.message?.context_management?.applied_edits;
    if (Array.isArray(applied)) {
      const clears = applied.filter(edit => edit?.type === "clear_tool_uses_20250919");
      if (clears.length) {
        bump("clearedToolUses", clears.reduce((n, edit) => n + Math.max(0, num(edit.cleared_tool_uses) ?? 0), 0));
        bump("clearedInput", clears.reduce((n, edit) => n + Math.max(0, num(edit.cleared_input_tokens) ?? 0), 0));
      }
    }
    const u = event?.message?.usage ?? event?.usage ?? event?.response?.usage;
    if (u === null || typeof u !== "object") return into;
    bump("input", num(u.input_tokens) ?? num(u.prompt_tokens));
    bump("output", num(u.output_tokens) ?? num(u.completion_tokens));
    const cachedSubset = num(u.input_tokens_details?.cached_tokens) ?? num(u.prompt_tokens_details?.cached_tokens);
    bump("read", num(u.cache_read_input_tokens) ?? cachedSubset);
    if (cachedSubset !== undefined && u.cache_read_input_tokens === undefined) into.cachedSubset = true;
    bump("write", num(u.cache_creation_input_tokens));
    const detail = u.cache_creation;
    if (detail !== null && typeof detail === "object") {
      bump("write5m", num(detail.ephemeral_5m_input_tokens));
      bump("write1h", num(detail.ephemeral_1h_input_tokens));
    }
    return into;
  }

  /** A pass-through stream that records usage as the reply flows by. Parse
   *  failures are diagnostics-only: the client still gets every byte. */
  function usageObserver(onDone, onEvent) {
    const usage = {};
    const decoder = new StringDecoder('utf8');
    let buffer = "";
    let seen = false;
    const inspect = (text) => {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "") continue;
        if (payload === "[DONE]") { onEvent?.({ type: 'done' }); continue; }
        try {
          const event = JSON.parse(payload);
          onEvent?.(event);
          usageFromEvent(event, usage);
          seen = true;
        } catch {
          /* a partial or non-JSON frame is not fatal */
        }
      }
    };
    return new Transform({
      transform(chunk, _encoding, callback) {
        try {
          buffer += decoder.write(chunk);
          // Keep the tail: an event can straddle two chunks.
          const cut = buffer.lastIndexOf("\n");
          if (cut !== -1) {
            inspect(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 1);
          }
          if (buffer.length > 64_000) buffer = buffer.slice(-1024);
        } catch {
          /* never let diagnostics break the reply */
        }
        callback(null, chunk);
      },
      flush(callback) {
        try {
          inspect(buffer + decoder.end());
          onDone(seen ? usage : undefined);
        } catch {
          onDone(undefined);
        }
        callback();
      },
    });
  }

  /** Usage from a complete (non-streaming) body, without consuming it. */
  async function usageFromBody(response) {
    try {
      const text = await response.clone().text();
      const parsed = JSON.parse(text);
      const usage = usageFromEvent(parsed, {});
      return Object.keys(usage).length > 0 ? usage : undefined;
    } catch {
      return undefined;
    }
  }

  /** One forwarded attempt. */
  async function send(route, token, orgId, req, parsed, wireBody, clientSignal, decision, sessionId) {
    const headers = {
      ...authHeaders(
        token,
        orgId,
        route === "anthropic" ? ANTHROPIC_SDK_VERSION : OPENAI_SDK_VERSION,
      ),
      "content-type": "application/json",
      "x-session-id": sessionId,
      "x-api-provider": decision.provider,
      "x-provider-routing-source": decision.source,
    };
    // The timeout bounds a slow upstream; the client signal bounds a caller
    // that already went away. Either one must reach fetch.
    const signal =
      clientSignal === undefined
        ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        : AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), clientSignal]);
    if (route === "anthropic") {
      // Captured from the official CLI's own a-route requests.
      headers["x-api-key"] = "placeholder";
      headers["x-stainless-timeout"] = "600";
      headers["x-assistant-message-id"] = randomUUID();
      headers["anthropic-version"] = clientHeader(req, "anthropic-version") ?? ANTHROPIC_VERSION;
      let beta = filterAnthropicBeta(clientHeader(req, "anthropic-beta"), parsed);
      // Generate feature headers from the final body on EVERY attempt. The
      // prepared body is immutable here, including on an authentication retry.
      if (Array.isArray(parsed.context_management?.edits) && parsed.context_management.edits.some(edit =>
        ["clear_tool_uses_20250919", "clear_thinking_20251015"].includes(edit?.type)) &&
          !beta.split(",").includes(CONTEXT_MANAGEMENT_BETA)) {
        beta = beta ? `${beta},${CONTEXT_MANAGEMENT_BETA}` : CONTEXT_MANAGEMENT_BETA;
      }
      if (typeof parsed?.model === "string" && FAST_MODE_IDS.has(parsed.model)) {
        if (!beta.split(",").includes(FAST_MODE_BETA)) {
          beta = beta ? `${beta},${FAST_MODE_BETA}` : FAST_MODE_BETA;
        }
      }
      if (beta) headers["anthropic-beta"] = beta;
      return fetchImpl(upstreamMessages, { method: "POST", headers, body: wireBody, signal });
    }
    if (route === "openai") {
      // Captured from the official CLI's own /responses requests (GPT family).
      // Official Nse attaches this constant on both OpenAI and Azure OpenAI,
      // but never on Bedrock/Snowflake/Databricks Responses backends.
      if (['openai', 'azure_openai'].includes(decision.provider)) headers["openai-platform"] = OPENAI_PLATFORM;
      headers["x-assistant-message-id"] = randomUUID();
      return fetchImpl(upstreamResponses, { method: "POST", headers, body: wireBody, signal });
    }
    return fetchImpl(upstreamCompletions, { method: "POST", headers, body: wireBody, signal });
  }

  /** Shared POST pipeline: guard → token → sanitize → forward (401: one forced
   * refresh + retry) → stream the upstream reply back. */
  async function forwardInner(route, req, res, diagnostic) {
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
    // Shared by every record this request produces, so interleaved
    // conversations can be told apart when the journal is analysed.
    const { requestId } = diagnostic;
    journal({ route, event: 'request-start', requestId });
    const clientAbort = new AbortController();
    const onClientGone = () => {
      if (!res.writableFinished) {
        clientAbort.abort();
        journal({ route, event: 'request-aborted', requestId, phase: diagnostic.phase });
      }
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
    let automaticToolClear = false;
    let batchCacheTtlMs = 300000;
    const localSession = clientHeader(req, FACTORY_REQUEST_SESSION_HEADER);
    const batchEligible = route === 'anthropic' && anthropicCacheMode !== 'off' && /^[a-f0-9]{64}$/.test(localSession ?? '') && anthropicToolClearBatchTokens > 0 &&
      factoryModelLimits('factory-a', parsed?.model) !== undefined;
    if (route === "anthropic" && FAST_MODE_IDS.has(parsed?.model) && !parsed.speed) parsed.speed = "fast";
    if (route === "anthropic") {
      sanitizeAnthropicPayload(parsed);
      // All body changes precede the final byte check. Compaction must see
      // the retained facts, rather than having old tool results cleared again.
      // The internal purpose header is consumed here and never forwarded.
      if (anthropicToolClear && parsed.context_management === undefined &&
          clientHeader(req, FACTORY_REQUEST_PURPOSE_HEADER) !== "compaction") {
        automaticToolClear = true;
        parsed.context_management = { edits: [{
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: anthropicToolClearTrigger },
          keep: { type: "tool_uses", value: anthropicToolClearKeep },
          ...(batchEligible ? { clear_at_least: { type: 'input_tokens', value: anthropicToolClearBatchTokens } } : {}),
        }] };
      }
      // Breakpoints are chosen from the final bytes, after the identity line is
      // in place and the WAF softening has run.
      const cache = applyAnthropicCacheBreakpoints(parsed, {
        mode: anthropicCacheMode,
        ttl: anthropicCacheTTL,
      });
      const cacheTtls = Object.keys(cache.ttlSummary);
      batchCacheTtlMs = cacheTtls.length === 1 && cacheTtls[0] === '1h' ? 3600000 : 300000;
      // Content-free fingerprints locate outgoing prefix changes. Backend
      // context edits and cache expiry can also prevent reuse; these digests
      // alone cannot establish why a cache read missed.
      const parts = sessionKeyParts(route, parsed);
      const short = (value) => createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12);
      // The host exposes no trustworthy conversation id here, so this is a
      // derived key and is labelled as such: it is good enough to keep records
      // from two interleaved sessions from being compared as neighbours, and it
      // is not presented as proof that they are the same conversation. Note it
      // changes when the system text or the first user message changes, which
      // is exactly when a prefix legitimately breaks.
      const conversationKey = short(`${parsed?.model ?? ""}\u0000${parts.system}\u0000${parts.firstUser}`);
      journal({
        route,
        event: "cache-shape",
        // Bumped whenever the fingerprint algorithm changes; digests from a
        // different version must not be compared.
        schemaVersion: 2,
        model: parsed?.model,
        requestId,
        conversation: { key: conversationKey, confidence: "derived" },
        mode: anthropicCacheMode,
        source: cache.source,
        breakpoints: cache.breakpoints,
        markers: cache.markers,
        ttl: cache.ttlSummary,
        // Options that invalidate a cached prefix when they change. Values are
        // summarised, never the prompt or the tool bodies.
        options: {
          thinking: parsed?.thinking === undefined ? null : Object.keys(parsed.thinking).sort().join("+"),
          effort: parsed?.reasoning_effort ?? parsed?.output_config?.effort ?? null,
          toolChoice: typeof parsed?.tool_choice === "object" ? parsed.tool_choice?.type ?? "object" : parsed?.tool_choice ?? null,
          speed: parsed?.speed ?? null,
          temperature: parsed?.temperature ?? null,
        },
        coverage: {
          selectedMessageIndex: cache.selectedMessageIndex,
          selectedBlockType: cache.selectedBlockType,
          tailExcludedBlocks: cache.tailExcludedBlocks,
          fallbackToEarlierMessage: cache.fallbackToEarlierMessage,
        },
        warnings: cache.warnings.length > 0 ? cache.warnings : undefined,
        shape: fingerprintAnthropicPayload(parsed, (value) => createHash("sha256").update(value).digest("hex")),
      });
    } else if (route === "openai") normalizeResponsesPayload(parsed);
    else normalizeGenericPayload(parsed);
    clampFactoryOutputTokens(ROUTES[route].key, parsed);
    // Include every wire mutation (including fast mode) in the final budget.
    let wireBody = JSON.stringify(parsed);
    const requestSize = requestSizeBreakdown(parsed);
    const withinBudget = () => {
      requestSize.bodyBytes = Buffer.byteLength(wireBody);
      if (finalBodyBudget <= 0 || requestSize.bodyBytes <= finalBodyBudget) return true;
      journal({ route, event: "request-too-large", requestId, source: "local-budget", budgetBytes: finalBodyBudget,
        requestSize, shape: shapeOf(parsed) });
      writeJson(res, 413, { error: { code: "413", type: "invalid_request_error",
        message: `Request Entity Too Large: Factory plugin final request body is ${requestSize.bodyBytes} bytes; local budget is ${finalBodyBudget} bytes. Recover this session before retrying.` } });
      return false;
    };
    // Oversize requests still fail before acquiring credentials.
    if (!withinBudget()) return;

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
    const { system, firstUser } = sessionKeyParts(route, parsed);
    // Keys without an org id must still have separate affinity/routing state.
    const deriveSession = current => sessions.derive({
      orgId: createHash('sha256').update(`${current.token}\0${current.orgId ?? ''}`).digest('hex'), model: parsed?.model,
      system: /^[a-f0-9]{64}$/.test(localSession ?? '') ? localSession : system,
      firstUser: /^[a-f0-9]{64}$/.test(localSession ?? '') ? '' : firstUser });
    let sessionId = deriveSession(credential);
    diagnostic.phase = 'routing-config';
    const validTicket = name => { const value = clientHeader(req, name); return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value) ? value : undefined; };
    const routingRequest = { model: parsed.model, route, session: sessionId, host: upstreamMessages, region: inferenceRegion,
      attempt: validTicket(FACTORY_ATTEMPT_HEADER), previousFailure: validTicket(FACTORY_PREVIOUS_FAILURE_HEADER) };
    let decision = await providerRouter.select({ credential, ...routingRequest });
    clientAbort.signal.throwIfAborted();
    if (!decision) {
      writeJson(res, 400, { error: { type: 'invalid_request_error', message: 'Factory: no eligible upstream for this model, route and region.' } });
      return;
    }
    decision.prepare(parsed);
    wireBody = JSON.stringify(parsed);
    if (!withinBudget()) return;
    let clearingPlan;
    if (automaticToolClear && batchEligible) {
      clearingPlan = toolClearBatches.plan(parsed, { session: localSession,
        account: createHash('sha256').update(`${credential.token}\0${credential.orgId ?? ''}`).digest('hex'),
        keep: anthropicToolClearKeep, trigger: anthropicToolClearTrigger, batchTokens: anthropicToolClearBatchTokens,
        maxInputTokens: factoryModelLimits('factory-a', parsed.model).maxInputTokens, cacheTtlMs: batchCacheTtlMs });
      if (clearingPlan) {
        parsed.context_management.edits[0].keep.value = clearingPlan.keep;
        wireBody = JSON.stringify(parsed);
        // Even a larger keep integer is included in the FINAL checked bytes.
        if (!withinBudget()) return;
        journal({ route, event: 'tool-clear-batch', requestId, mode: clearingPlan.mode,
          keep: clearingPlan.keep, batchTokens: clearingPlan.minimum,
          addedEligibleTokensEstimate: clearingPlan.addedEligibleTokens,
          activeTokensEstimate: clearingPlan.estimatedActive });
      }
    }
    const startedAt = Date.now();
    const rotate = reason => {
      const next = decision.failure();
      journal({ route, event: 'provider-failure', requestId, model: parsed.model, provider: decision.provider, nextProvider: next, reason });
    };
    const attempt = async () => {
      diagnostic.phase = 'awaiting-upstream-headers';
      journal({ route, event: 'send-start', requestId, model: parsed.model, provider: decision.provider,
        routingSource: decision.source, configSource: decision.configSource, candidates: decision.order,
        preferenceApplied: decision.preferenceApplied, preferenceReason: decision.preferenceReason, bodyBytes: Buffer.byteLength(wireBody) });
      try { return await send(route, credential.token, credential.orgId, req, parsed, wireBody, clientAbort.signal, decision, sessionId); }
      catch (error) { if (!clientAbort.signal.aborted) rotate('transport'); throw error; }
    };
    let upstream = await attempt();
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
        if (refreshed.token !== credential.token || refreshed.orgId !== credential.orgId) clearingPlan = undefined;
        credential = refreshed;
        sessionId = deriveSession(credential);
        decision = await providerRouter.select({ credential, ...routingRequest, session: sessionId, previousFailure: undefined });
        if (!decision) { writeJson(res, 400, { error: { type: 'invalid_request_error', message: 'Factory: no eligible upstream after credential refresh.' } }); return; }
        upstream = await attempt();
      }
    }
    journal({
      route,
      event: "forward",
      requestId,
      shape: shapeOf(parsed),
      ms: Date.now() - startedAt,
      upstreamStatus: upstream.status,
      provider: decision.provider,
      routingSource: decision.source,
    });
    diagnostic.phase = 'upstream-body';
    if (retryableProviderStatus(upstream.status)) rotate(`http-${upstream.status}`);
    if (upstream.status >= 400) {
      // Content-free size evidence. Upstream error bodies can contain prompts
      // or provider internals, so keep the original body only in the response.
      try {
        journal({
          route,
          event: "upstream-error",
          requestId,
          upstreamStatus: upstream.status,
          requestSize,
          shape: shapeOf(parsed),
          source: "upstream",
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
    const upstreamRequestId = upstream.headers.get("request-id") ?? upstream.headers.get("x-request-id");
    if (upstreamRequestId) res.setHeader("x-request-id", upstreamRequestId);
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.setHeader('retry-after', retryAfter);

    // Stream the reply through untouched (SSE included); a client abort tears
    // down the upstream request instead of leaking it.
    if (upstream.body === null) {
      res.end();
      return;
    }
    // Clone BEFORE the response body is locked by Readable.fromWeb. Otherwise
    // non-streaming usage (and the confirmed clearing boundary) is lost.
    const bodyUsage = String(contentType ?? '').includes('text/event-stream') ? undefined : usageFromBody(upstream);
    const stream = Readable.fromWeb(upstream.body);
    let streamFailed = upstream.status >= 400, completed = false;
    const recordUsage = (usage) => {
      if (usage === undefined) return;
      if (upstream.status >= 200 && upstream.status < 300 && !streamFailed) toolClearBatches.commit(clearingPlan, usage);
      // OpenAI cached tokens are a subset of input/prompt_tokens. Anthropic
      // instead reports uncached input, reads and writes as separate counters.
      const input = usage.cachedSubset && usage.input !== undefined ? Math.max(0, usage.input - (usage.read ?? 0)) : usage.input;
      const total = (input ?? 0) + (usage.read ?? 0) + (usage.write ?? 0);
      const entry = {
        t: new Date().toISOString(),
        route,
        event: "usage",
        requestId,
        model: parsed?.model,
        input: input ?? null,
        read: usage.read ?? null,
        write: usage.write ?? null,
        write5m: usage.write5m ?? null,
        write1h: usage.write1h ?? null,
        output: usage.output ?? null,
        totalInput: total > 0 ? total : null,
        hitRatio: total > 0 && usage.read !== undefined ? Number((usage.read / total).toFixed(4)) : null,
        contextEditing: usage.clearedToolUses === undefined ? undefined : {
          clearedToolUses: usage.clearedToolUses, clearedInputTokens: usage.clearedInput,
        },
      };
      if (!recordTokenUsage(entry)) journal({ route, event: 'token-statistics-error', requestId, code: 'write_failed' });
      journal(entry);
    };
    const routingEvent = event => {
      const failure = streamFailure(event);
      if (failure && !streamFailed) { streamFailed = true; rotate(`stream-${failure}`); }
      if (event?.type === 'error' || event?.type === 'response.failed') streamFailed = true;
      if (['done', 'message_stop', 'response.completed'].includes(event?.type)) completed = true;
      if (event?.choices?.some(choice => choice.finish_reason !== null && choice.finish_reason !== undefined)) completed = true;
    };
    stream.on("error", (error) => {
      // A cancelled upstream is the expected outcome of a client disconnect.
      if (clientAbort.signal.aborted) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      if (!streamFailed) { streamFailed = true; rotate('stream-transport'); }
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
    // Streaming replies flow through an observer; non-streaming ones are read
    // for usage from a clone so the body itself is untouched.
    // probe passes a minimal fake response, so this must not assume the real
    // ServerResponse surface.
    const contentTypeNow = String(
      (typeof res.getHeader === "function" ? res.getHeader("content-type") : undefined) ??
        res.headers?.["content-type"] ??
        contentType ??
        "",
    );
    if (contentTypeNow.includes("text/event-stream")) {
      stream.pipe(usageObserver(usage => {
        if (completed && !streamFailed && !clientAbort.signal.aborted) decision.success();
        recordUsage(usage);
        journal({ route, event: 'stream-finish', requestId, provider: decision.provider, completed, failed: streamFailed, ms: Date.now() - startedAt });
      }, routingEvent)).pipe(res);
    } else {
      void bodyUsage?.then(recordUsage);
      stream.on('end', () => { if (!streamFailed && !clientAbort.signal.aborted) decision.success(); });
      stream.pipe(res);
    }
  }

  /** Public entry for every route handler: one guard around the whole pipeline
   * so a failure that happens before Factory ever answers — credential read,
   * outbound fetch, request-body read — is journaled and surfaced as a message
   * instead of vanishing into the webserver's bodiless 400. Such a failure
   * writes no forward record, which used to make it indistinguishable from
   * "the request never reached the gateway at all". */
  async function forward(route, req, res) {
    const diagnostic = { requestId: randomUUID().slice(0, 8), phase: 'local-preparation' };
    try {
      await forwardInner(route, req, res, diagnostic);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause = error?.cause;
      journal({
        route,
        event: "handler-error",
        ...diagnostic,
        error: message,
        cause:
          cause instanceof Error
            ? cause.message
            : cause === undefined
              ? undefined
              : String(cause),
      });
      logger?.warn?.(`dsh-factory-provider: request failed during ${diagnostic.phase}: ${message}`);
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) {
        writeJson(res, 502, {
          error: {
            type: "api_error",
            message: `dsh-factory-provider: request failed during ${diagnostic.phase} — ${message}`,
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
        // Same source of truth as the provider entries and /status.
        data: servableModels(route).map((m) => ({
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
      providerRouting: providerRouter.status(),
      gatewayPrefix,
      routes: Object.fromEntries(
        Object.keys(ROUTES).map((route) => [
          route,
          {
            enabled: routeEnabled(route),
            providerKey: ROUTES[route].key,
            models: servableModels(route).length,
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
    if (typeof next?.routingHost === 'string') providerRouter.configure({ host: next.routingHost });
    if (typeof next?.preferAnthropic === 'boolean') providerRouter.configure({ preferAnthropic: next.preferAnthropic });
    const before = JSON.stringify([activeRoutes, upstreamMessages, anthropicCacheMode, anthropicCacheTTL,
      anthropicToolClear, anthropicToolClearKeep, anthropicToolClearTrigger, anthropicToolClearBatchTokens]);
    if (Array.isArray(next?.routes)) activeRoutes = [...next.routes];
    if (typeof next?.apiBaseURL === "string" && next.apiBaseURL.length > 0) {
      const root = next.apiBaseURL.replace(/\/+$/, "");
      upstreamMessages = `${root}/api/llm/a/v1/messages`;
      upstreamCompletions = `${root}/api/llm/o/v1/chat/completions`;
      upstreamResponses = `${root}/api/llm/o/v1/responses`;
    }
    if (typeof next?.cliVersion === "string" && next.cliVersion.length > 0) version = next.cliVersion;
    if (typeof next?.cacheMode === "string") anthropicCacheMode = next.cacheMode;
    if (typeof next?.cacheTTL === "string") anthropicCacheTTL = next.cacheTTL;
    if (typeof next?.toolClear === "boolean") anthropicToolClear = next.toolClear;
    if (Number.isInteger(next?.toolClearKeep)) anthropicToolClearKeep = next.toolClearKeep;
    if (Number.isInteger(next?.toolClearTrigger)) anthropicToolClearTrigger = next.toolClearTrigger;
    if (Number.isInteger(next?.toolClearBatchTokens) && next.toolClearBatchTokens >= 0) anthropicToolClearBatchTokens = next.toolClearBatchTokens;
    const after = JSON.stringify([activeRoutes, upstreamMessages, anthropicCacheMode, anthropicCacheTTL,
      anthropicToolClear, anthropicToolClearKeep, anthropicToolClearTrigger, anthropicToolClearBatchTokens]);
    if (before !== after) toolClearBatches.clear();
    if (Number.isInteger(next?.requestMaxBytes) && next.requestMaxBytes >= 0 && next.requestMaxBytes <= MAX_BODY_BYTES) finalBodyBudget = next.requestMaxBytes;
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
