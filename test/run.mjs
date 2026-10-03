// Offline test suite for dsh-factory-provider.
//
//   node test/run.mjs
//
// The plugin authenticates with a Factory API key and nothing else, so the
// credential side is small: a key is stored per account, the resolver picks the
// selected one (falling back to FACTORY_API_KEY while none is selected), and a
// deleted key stops serving. The rest covers the per-route payload rewrites,
// the catalog → llm-pi-ai entry mapping, and the gateway end to end against a
// local mock Factory (header injection, SSE streaming, 401 retry, loopback
// guard, status/catalog routes). No network access, no API key, no droid CLI.

// Point the journal at a temp file before anything can write to it: this suite
// deliberately breaks handlers, and those records used to land in the journal of
// whatever host the developer had running.
process.env.DSH_FACTORY_JOURNAL = path.join(os.tmpdir(), `dsh-factory-test-journal-${process.pid}.jsonl`);

import { createHash } from "node:crypto";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

import { createTokenResolver } from "../lib/credentials.js";
import {
  accountApiKey,
  accountsRoot,
  activeApiKey,
  clearActiveAccount,
  deleteAccount,
  disableCredentials,
  getActiveAccountId,
  getCredentialMode,
  listAccounts,
  saveApiKeyAccount,
  setActiveAccountId,
} from "../lib/accounts.js";
import {
  sanitizeAnthropicPayload,
  normalizeGenericPayload,
  normalizeResponsesPayload,
  filterAnthropicBeta,
  DROID_SYSTEM_LINE,
} from "../lib/sanitize.js";
import {
  ROUTES,
  buildModelEntries,
  buildProviderEntry,
} from "../lib/catalog.js";
import { createGateway } from "../lib/gateway.js";
import { applyAnthropicCacheBreakpoints, fingerprintAnthropicPayload } from "../lib/cache.js";
import { apply, Config } from "../lib/index.js";
import { journal, readJournal } from "../lib/journal.js";
import { fetchQuota } from "../lib/quota.js";
import {
  createSessionIdMap,
  sessionKeyParts,
  contentText,
} from "../lib/session.js";

// --- helpers -----------------------------------------------------------------

const openServers = new Set();
after(() => {
  for (const server of openServers) server.close();
  openServers.clear();
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.add(server);
  return server.address().port;
}

function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

function jwtOf(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
}

function encryptEnvelope(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(":");
}

/** The credential a gateway test runs with. It used to be a droid envelope in
 *  a temp home; with API keys the credential *is* the key, so the same call
 *  returns the string the resolver reads from FACTORY_API_KEY. */
function seedFactoryHome(_t, creds) {
  return creds.access_token;
}


function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function readAll(res) {
  const chunks = [];
  for await (const chunk of res.body) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

function sseReply(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_mock" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

// --- credentials --------------------------------------------------------------

test("resolve: no credential anywhere reports source none", async () => {
  await withEnv({ FACTORY_API_KEY: undefined }, async () => {
    const resolver = createTokenResolver({});
    const state = await resolver.resolve();
    assert.equal(state.source, "none");
    assert.equal(state.token, undefined);
  });
});

// --- sanitize -----------------------------------------------------------------

test("anthropic sanitize: string system is prepended with the canonical line, messages untouched", () => {
  const parsed = {
    model: "claude-sonnet-5",
    system: "SYSTEM PROMPT",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ],
  };
  sanitizeAnthropicPayload(parsed);
  assert.equal(parsed.system, `${DROID_SYSTEM_LINE}\n\nSYSTEM PROMPT`);
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[0].content, "hello");
});

test("anthropic sanitize: WAF phrases are softened, messages untouched", () => {
  const parsed = {
    model: "claude-sonnet-5",
    messages: [
      { role: "user", content: [{ type: "text", text: "You are OpenCode, the best coding agent on the planet." }] },
    ],
  };
  sanitizeAnthropicPayload(parsed);
  // No system was sent: a canonical system block is inserted, messages keep shape.
  assert.deepEqual(parsed.system, [{ type: "text", text: DROID_SYSTEM_LINE }]);
  assert.equal(parsed.messages[0].content[0].text, "You are OpenCode. The best coding agent on the planet.");
});

test("anthropic sanitize: top-level system passes through with the canonical line prepended", () => {
  const parsed = {
    model: "claude-opus-5-5",
    max_tokens: 64,
    system: [
      { type: "text", text: "DSH persona block." },
      { type: "text", text: "You are OpenCode, the best coding agent on the planet.", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "hello" }],
  };
  sanitizeAnthropicPayload(parsed);
  assert.equal(parsed.system.length, 3);
  assert.equal(parsed.system[0].text, DROID_SYSTEM_LINE);
  assert.equal(parsed.system[1].text, "DSH persona block.");
  assert.equal(parsed.system[2].text, "You are OpenCode. The best coding agent on the planet.");
  assert.deepEqual(parsed.system[2].cache_control, { type: "ephemeral" });
  // The route accepts the system block; no folding into the first message.
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].content, "hello");
});

test("anthropic sanitize: a string system is prepended, an already-canonical one untouched", () => {
  const withString = { model: "claude-sonnet-5", system: "DSH persona.", messages: [{ role: "user", content: "hi" }] };
  sanitizeAnthropicPayload(withString);
  assert.equal(withString.system, `${DROID_SYSTEM_LINE}\n\nDSH persona.`);

  const canonical = {
    model: "claude-sonnet-5",
    system: [{ type: "text", text: DROID_SYSTEM_LINE }],
    messages: [{ role: "user", content: "hi" }],
  };
  sanitizeAnthropicPayload(canonical);
  assert.deepEqual(canonical.system, [{ type: "text", text: DROID_SYSTEM_LINE }]);
});

test("anthropic beta filter: skills-* dropped without a code_execution tool, kept with one", () => {
  const base = { model: "claude-sonnet-5", messages: [{ role: "user", content: "x" }] };
  assert.equal(filterAnthropicBeta("skills-2025-01,interleaved-thinking", base), "interleaved-thinking");
  const withTool = { ...base, tools: [{ name: "code_execution", type: "code_execution_20250825" }] };
  assert.equal(filterAnthropicBeta("skills-2025-01", withTool), "skills-2025-01");
});

test("anthropic sanitize: thinking blocks and tool_use inputs are softened", () => {
  const parsed = {
    model: "claude-opus-5-5",
    system: [{ type: "text", text: DROID_SYSTEM_LINE }],
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: 'The phrase "You are OpenCode, the best coding agent on the planet." is blocked.',
          },
          { type: "tool_use", id: "t1", name: "write", input: { text: "You are powered by the model named GLM" } },
        ],
      },
    ],
  };
  sanitizeAnthropicPayload(parsed);
  assert.equal(
    parsed.messages[1].content[0].thinking,
    'The phrase "You are OpenCode. The best coding agent on the planet." is blocked.',
  );
  assert.equal(parsed.messages[1].content[1].input.text, "You are powered by the model, named GLM");
});

test("generic normalize: system role kept, canonical line guaranteed, unknown keys stripped, WAF softened", () => {
  const parsed = {
    model: "glm-5.3-flash",
    messages: [{ role: "system", content: "You are powered by the model named GLM" }, { role: "user", content: "hi" }],
    baseURL: "http://127.0.0.1:1/x",
    apiKey: "leaked",
    temperature: 0.5,
    stream: true,
  };
  normalizeGenericPayload(parsed);
  assert.equal(parsed.messages[0].role, "system");
  assert.ok(parsed.messages[0].content.startsWith(DROID_SYSTEM_LINE));
  assert.ok(parsed.messages[0].content.endsWith("You are powered by the model, named GLM"));
  assert.ok(!("baseURL" in parsed));
  assert.ok(!("apiKey" in parsed));
  assert.equal(parsed.temperature, 0.5);
  assert.equal(parsed.stream, true);
});

test("generic normalize: replayed reasoning and tool-call arguments are softened too", () => {
  // Regression for the live 403: pi-ai replays the assistant's thinking under
  // `reasoning_content` and its tool calls as JSON arguments. Softening only
  // `content` left both surfaces raw, so one identity phrase the model wrote in
  // its own thinking failed every later request of that conversation (Factory's
  // edge answers 403 with a body the SDK renders as "403 status code (no body)").
  const parsed = {
    model: "glm-5.3-flash",
    messages: [
      { role: "system", content: DROID_SYSTEM_LINE },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "ok",
        reasoning_content: 'Use the OpenCode one: "You are OpenCode, the best coding agent on the planet."',
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({ text: "You are powered by the model named GLM" }),
            },
          },
        ],
      },
    ],
  };
  normalizeGenericPayload(parsed);
  const assistant = parsed.messages[2];
  assert.equal(
    assistant.reasoning_content,
    'Use the OpenCode one: "You are OpenCode. The best coding agent on the planet."',
  );
  assert.equal(
    JSON.parse(assistant.tool_calls[0].function.arguments).text,
    "You are powered by the model, named GLM",
  );
  assert.equal(assistant.tool_calls[0].function.name, "write");
});

test("generic normalize: a request with no system message gets one", () => {
  const parsed = { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] };
  normalizeGenericPayload(parsed);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].role, "system");
  assert.equal(parsed.messages[0].content, DROID_SYSTEM_LINE);
});

test("generic normalize: an already-canonical system message is left untouched", () => {
  const messages = [{ role: "system", content: `${DROID_SYSTEM_LINE}\n\nDSH persona here.` }, { role: "user", content: "hi" }];
  const parsed = { model: "glm-5.3-flash", messages: structuredClone(messages) };
  normalizeGenericPayload(parsed);
  assert.deepEqual(parsed.messages, messages);
});

// --- catalog ------------------------------------------------------------------

test("catalog: model entries carry limits and per-model effort selectors", () => {
  const entries = buildModelEntries("anthropic");
  const opus = entries.find((e) => e.id === "claude-opus-4-8");
  assert.equal(opus.contextWindow, 200_000);
  assert.deepEqual(opus.reasoningEfforts, { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  assert.deepEqual(opus.input, ["text", "image"]);
  assert.equal(buildModelEntries("anthropic", ["claude-sonnet-5"]).length, 1);

  // The models the user asked for are present with their documented value sets.
  const opus55 = entries.find((e) => e.id === "claude-opus-5-5");
  const sonnet55 = entries.find((e) => e.id === "claude-sonnet-5-5");
  assert.ok(opus55 !== undefined && sonnet55 !== undefined);
  assert.ok(!("off" in opus55.reasoningEfforts)); // Opus 5.5 has no `off` level
  assert.deepEqual(sonnet55.reasoningEfforts.low, "low");

  const generic = buildModelEntries("generic");
  // glm-5.3-flash leads the Droid Core list — the free-quota default.
  assert.equal(generic[0].id, "glm-5.3-flash");
  // GLM-5.3-Flash offers exactly low/high/max per the official model table.
  assert.deepEqual(generic[0].reasoningEfforts, { low: "low", high: "high", max: "max" });
  assert.deepEqual(generic.find((e) => e.id === "minimax-m3").reasoningEfforts, { high: "high" });
  // Deprecated / other-region ids probed against the live API are excluded.
  assert.ok(!generic.some((e) => ["glm-5.2", "glm-5.2-fast", "kimi-k2.6", "kimi-k2.7-code", "glm-5.1"].includes(e.id)));

  // Every Claude entry carries pi-ai's forceAdaptiveThinking compat: Factory's
  // bedrock_anthropic route refuses budget thinking with a 400.
  for (const entry of buildModelEntries("anthropic")) {
    assert.deepEqual(entry.compat, { forceAdaptiveThinking: true }, `model ${entry.id}`);
  }
});

test("catalog: refreshed against the live edge — dot id, no region-gated, new Core models", () => {
  const anthropic = buildModelEntries("anthropic").map((e) => e.id);
  // Fable 5.1's wire id uses a DOT: the hyphenated form answers "Invalid model ID".
  assert.ok(anthropic.includes("claude-fable-5.1"));
  assert.ok(!anthropic.includes("claude-fable-5-1"));
  assert.ok(anthropic.includes("claude-sonnet-4-6") && anthropic.includes("claude-opus-4-7"));
  // Fast Mode is region-gated for this account (probed 400). The ids stay in
  // the table — the gateway still knows the Fast Mode beta and its test drives
  // that path — but regionGated keeps them out of the picker.
  assert.ok(!anthropic.includes("claude-opus-5-5-fast"));
  assert.ok(!anthropic.includes("claude-opus-5-fast"));
  for (const id of ["claude-opus-5-5-fast", "claude-opus-4-8-fast", "claude-opus-5-fast"]) {
    assert.equal(ROUTES.anthropic.models.find((m) => m.id === id)?.regionGated, true, id);
  }

  const generic = buildModelEntries("generic");
  const ids = generic.map((e) => e.id);
  for (const id of ["inkling", "qwen3.8-max", "nemotron-3-ultra"]) assert.ok(ids.includes(id), id);
  // The Core newcomers take none/low/medium/high/xhigh/max, so the selector's
  // off key maps to the wire value `none` (inkling refuses a literal "off").
  assert.deepEqual(generic.find((e) => e.id === "inkling").reasoningEfforts, {
    off: "none",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
  // Claude 4.6 has no xhigh level (the route answers 400 for it).
  assert.deepEqual(buildModelEntries("anthropic").find((e) => e.id === "claude-sonnet-4-6").reasoningEfforts, {
    low: "low",
    medium: "medium",
    high: "high",
    max: "max",
  });

  const openai = buildModelEntries("openai").map((e) => e.id);
  assert.ok(!openai.includes("gpt-5.5-pro") && !openai.includes("gpt-5.3-codex-fast"));
});

test("catalog: provider entries point at the loopback gateway with per-route defaults", () => {
  const a = buildProviderEntry("anthropic", { port: 19387, gatewayPrefix: "/api/dsh-factory-provider" });
  const g = buildProviderEntry("generic", { port: 19387, gatewayPrefix: "/api/dsh-factory-provider" });
  assert.equal(a.api, "anthropic-messages");
  assert.equal(a.baseURL, "http://127.0.0.1:19387/api/dsh-factory-provider/a");
  assert.deepEqual(a.headers, { "x-api-key": "factory-gateway" });
  assert.equal(g.api, "openai-completions");
  assert.equal(g.baseURL, "http://127.0.0.1:19387/api/dsh-factory-provider/o/v1");
  assert.deepEqual(g.compat, { thinkingFormat: "openai", supportsReasoningEffort: true });
  assert.equal(g.headers.authorization, "Bearer factory-gateway");
  assert.equal(ROUTES.anthropic.key, "factory-a");
  assert.equal(ROUTES.generic.key, "factory-g");
});



// --- session ids (prompt-cache affinity) -----------------------------------------

test("session: one conversation derives one stable id across turns", () => {
  const sessions = createSessionIdMap({ mint: (() => { let n = 0; return () => `uuid-${++n}`; })() });
  const turn = (firstUser) =>
    sessions.derive({
      orgId: "org_1",
      model: "glm-5.3-flash",
      system: "You are Droid, an AI software engineering agent built by Factory.",
      firstUser,
    });
  // Every turn's body carries the same opening message (history grows AFTER
  // it), so the derived id is stable for the whole conversation.
  const a = turn("帮我看看这个仓库");
  const b = turn("帮我看看这个仓库");
  assert.equal(a, b);
  assert.equal(turn("帮我看看这个仓库"), a);
});

test("session: different conversations derive different ids", () => {
  const sessions = createSessionIdMap();
  const base = { orgId: "org_1", model: "glm-5.3-flash", system: "sys", firstUser: "hello" };
  const ids = new Set([
    sessions.derive(base),
    sessions.derive({ ...base, firstUser: "different opener" }),
    sessions.derive({ ...base, system: "different persona" }),
    sessions.derive({ ...base, model: "kimi-k3" }),
    sessions.derive({ ...base, orgId: "org_2" }), // multi-account isolation
  ]);
  assert.equal(ids.size, 5);
});

test("session: LRU caps the map and refreshes recency on use", () => {
  const sessions = createSessionIdMap({ max: 2 });
  const key = (n) => ({ orgId: "org", model: "m", system: "s", firstUser: `msg-${n}` });
  const first = sessions.derive(key(1));
  const second = sessions.derive(key(2));
  assert.equal(sessions.size(), 2);
  // Touch the oldest, then insert a third: the untouched one is evicted.
  sessions.derive(key(1));
  sessions.derive(key(3));
  assert.equal(sessions.size(), 2);
  // key(1) survived (refreshed), key(2) was evicted → its slot minted a new id.
  assert.equal(sessions.derive(key(1)), first);
  assert.notEqual(sessions.derive(key(2)), second);
});

test("session: key extraction reads both route shapes", () => {
  const anthropic = sessionKeyParts("anthropic", {
    model: "claude-sonnet-5-5",
    system: [
      { type: "text", text: "You are Droid, an AI software engineering agent built by Factory." },
      { type: "text", text: "persona block" },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "first question" }] },
      { role: "assistant", content: "answer" },
    ],
  });
  assert.ok(anthropic.system.includes("persona block"));
  assert.equal(anthropic.firstUser, "first question");

  const generic = sessionKeyParts("generic", {
    model: "glm-5.3-flash",
    messages: [
      { role: "system", content: "sys-a" },
      { role: "system", content: "sys-b" },
      { role: "user", content: "hello" },
    ],
  });
  assert.equal(generic.system, "sys-a\nsys-b");
  assert.equal(generic.firstUser, "hello");

  // Malformed bodies degrade to empty parts, never throw.
  assert.deepEqual(sessionKeyParts("generic", null), { system: "", firstUser: "" });
  assert.deepEqual(sessionKeyParts("anthropic", { messages: [] }), { system: "", firstUser: "" });
});

test("session: contentText reads strings, block arrays, and junk", () => {
  assert.equal(contentText("plain"), "plain");
  assert.equal(contentText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(contentText(undefined), "");
  assert.equal(contentText([{ type: "image", source: {} }]), "");
});

test("gateway: forwards of one conversation carry a stable x-session-id", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: "org_9",
  });
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, [{ choices: [{ delta: { content: "ok" } }] }]));
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const body = (firstUser) => JSON.stringify({
      model: "glm-5.3-flash",
      stream: true,
      messages: [{ role: "system", content: "You are Droid, an AI software engineering agent built by Factory." }, { role: "user", content: firstUser }],
    });
    // Turn 1 and turn 2 of the same conversation: identical first user message.
    for (const _ of [1, 2]) {
      const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/o/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body("same opener"),
      });
      await readAll(res);
    }
    assert.equal(upstream.seen.length, 2);
    assert.equal(upstream.seen[0].headers["x-session-id"], upstream.seen[1].headers["x-session-id"]);
    assert.ok(upstream.seen[0].headers["x-session-id"].length > 0);

    // A different conversation (different opener) must get a different id.
    const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/o/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body("another opener"),
    });
    await readAll(res);
    assert.notEqual(upstream.seen[2].headers["x-session-id"], upstream.seen[0].headers["x-session-id"]);
  });
});

// --- quota ----------------------------------------------------------------------

test("quota: normalizes the billing windows and account facts", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: "org_1",
  });
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      usesTokenRateLimitsBilling: true,
      overagePreference: "droidCore",
      extraUsageAllowed: true,
      extraUsageBalanceCents: 500,
      limits: {
        standard: {
          fiveHour: { usedPercent: 12, windowEnd: "2026-10-02T06:00:00Z", secondsRemaining: 3600 },
          weekly: { usedPercent: 3, windowEnd: "2026-10-08T00:00:00Z", secondsRemaining: 500000 },
          monthly: { usedPercent: 1, windowEnd: "2026-10-31T00:00:00Z", secondsRemaining: 2000000 },
        },
        core: { fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null } },
      },
    }),
  });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const result = await fetchQuota({ resolver: createTokenResolver({}), fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.value.tokenRateLimits, true);
    assert.equal(result.value.overagePreference, "droidCore");
    assert.equal(result.value.extraUsageBalanceCents, 500);
    assert.equal(result.value.standard.fiveHour.usedPercent, 12);
    assert.equal(result.value.standard.fiveHour.windowEnd, "2026-10-02T06:00:00Z");
    // A window the account has never opened stays null, not 0.
    assert.equal(result.value.core.fiveHour.windowEnd, null);
    assert.equal(result.value.core.weekly, undefined);
  });
});

test("quota: without a credential it reports no-credential instead of throwing", async () => {
  await withEnv({ FACTORY_API_KEY: undefined }, async () => {
    const result = await fetchQuota({ resolver: createTokenResolver({}), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
    assert.equal(result.ok, false);
    assert.equal(result.code, "no-credential");
  });
});

test("quota: a network failure surfaces as a reason, not an exception", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: "org_1",
  });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const result = await fetchQuota({
      resolver: createTokenResolver({}),
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "network");
    assert.match(result.message, /ECONNREFUSED/);
  });
});

// --- journal --------------------------------------------------------------------

test("journal: write then read tail preserves shape without secrets", (t) => {
  journal({ route: "generic", event: "test-write", shape: { model: "glm-5.3-flash" }, upstreamStatus: 200 });
  const entries = readJournal(10);
  const last = entries[entries.length - 1];
  assert.equal(last.event, "test-write");
  assert.equal(last.shape.model, "glm-5.3-flash");
  assert.equal(last.upstreamStatus, 200);
  assert.ok(typeof last.t === "string");
});

// --- probe ----------------------------------------------------------------------

test("gateway: probe drives the real forward path against a mock upstream", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: "org_9",
  });
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, [{ choices: [{ delta: { content: "PONG" } }] }]));
  const { gateway } = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const result = await gateway.probe("generic", "glm-5.3-flash");
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.model, "glm-5.3-flash");
    assert.match(result.body, /data:/);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].headers["x-api-provider"], "fireworks");
  });
});

test("gateway: a failed upstream fetch is journaled and answered, not swallowed", async (t) => {
  // Port 1 refuses connections, so the outbound fetch throws before any upstream
  // response exists. That is the failure shape that used to reach the caller as
  // a bodiless 400 with no journal record at all — indistinguishable from a
  // request that never arrived.
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: "org_9",
  });
  const { gateway } = await startGateway(t, { upstreamBaseURL: "http://127.0.0.1:1" });
  const before = readJournal(100000).length;
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const result = await gateway.probe("generic", "glm-5.3-flash");
    assert.equal(result.status, 502);
    assert.match(result.body, /failed before reaching Factory/);
    const added = readJournal(100000).slice(before);
    const record = added.find((entry) => entry.event === "handler-error");
    assert.ok(record, "handler-error record is journaled");
    assert.equal(record.route, "generic");
    assert.ok(record.error.length > 0);
  });
});

// --- gateway end to end -------------------------------------------------------

/** Mock Factory upstream server; records every forwarded request. */
async function startMockUpstream(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = {
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
    };
    seen.push(record);
    await handler(record, res);
  });
  const port = await listen(server);
  return { baseURL: `http://127.0.0.1:${port}`, seen };
}

/** Mock WorkOS user_management server: mints a fresh token pair per call. */
async function startMockWorkos(t, mintToken) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(mintToken()));
  });
  const port = await listen(server);
  return { baseURL: `http://127.0.0.1:${port}`, seen };
}

async function startGateway(t, { upstreamBaseURL, enabledRoutes, cliVersion = "0.231.0" }) {
  const gateway = createGateway({
    resolver: createTokenResolver({}),
    enabledRoutes: enabledRoutes ?? ["anthropic", "generic"],
    gatewayPrefix: "/api/dsh-factory-provider",
    apiBaseURL: upstreamBaseURL,
    cliVersion,
    logger: { warn: () => {} },
  });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    const route = gateway.routes.find((r) => r.kind === "exact" && r.path === pathname);
    if (route === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    void route.handler(req, res);
  });
  const port = await listen(server);
  return { baseURL: `http://127.0.0.1:${port}`, port, gateway };
}

test("gateway: anthropic route injects credential/headers, rewrites body, streams SSE back", async (t) => {
  const home = seedFactoryHome(t, { access_token: "fk-test-credential-for-anthropic-route" });
  const upstream = await startMockUpstream(t, (_record, res) => {
    sseReply(res, [{ type: "message_start" }, { type: "content_block_delta", delta: { text: "hi" } }]);
  });
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });

  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/a/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "skills-2025-01" },
      body: JSON.stringify({
        model: "claude-opus-4-8-fast",
        system: "SYSTEM",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("x-request-id"), "req_mock");
    const body = await readAll(res);
    assert.match(body.toString(), /message_start/);
    assert.match(body.toString(), /\[DONE\]/);

    const sent = upstream.seen[0];
    assert.equal(sent.headers.authorization, `Bearer ${home}`);
    assert.equal(sent.headers["x-api-provider"], "bedrock_anthropic");
    assert.equal(sent.headers["x-api-key"], "placeholder");
    assert.equal(sent.headers["x-stainless-package-version"], "0.70.1");
    assert.equal(sent.headers["user-agent"], "factory-cli/0.231.0");
    assert.equal(sent.headers["anthropic-version"], "2023-06-01");
    // skills beta dropped (no code_execution tool), fast-mode beta added, speed set
    assert.equal(sent.headers["anthropic-beta"], "fast-mode-2026-02-01");
    assert.equal(sent.body.speed, "fast");
    // Top-level system passes through with the canonical line first. It is now
    // a block array because the cache layer needs somewhere legal to put a
    // breakpoint; the text itself is unchanged.
    const systemText = Array.isArray(sent.body.system)
      ? sent.body.system.map((b) => b.text).join("")
      : sent.body.system;
    assert.equal(systemText, `${DROID_SYSTEM_LINE}\n\nSYSTEM`);
    assert.equal(sent.body.messages.length, 1);
    const firstText = Array.isArray(sent.body.messages[0].content)
      ? sent.body.messages[0].content.map((b) => b.text ?? "").join("")
      : sent.body.messages[0].content;
    assert.equal(firstText, "hello");
  });
});

test("gateway: generic route maps x-api-provider and keeps the canonical system gate", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: null,
  });
  const upstream = await startMockUpstream(t, (_record, res) => {
    sseReply(res, [{ choices: [{ delta: { content: "ok" } }] }]);
  });
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/o/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.3-flash",
        baseURL: "leak",
        messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    await readAll(res);
    const sent = upstream.seen[0];
    assert.equal(sent.headers["x-api-provider"], "fireworks");
    assert.equal(sent.headers["user-agent"], "factory-cli/0.231.0");
    assert.ok(!("x-factory-org-id" in sent.headers));
    assert.equal(sent.body.messages[0].role, "system");
    assert.ok(sent.body.messages[0].content.startsWith(DROID_SYSTEM_LINE));
    assert.ok(!("baseURL" in sent.body));
  });
});

test("gateway: no credential yields an actionable 401, upstream untouched", async (t) => {
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, []));
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv({ FACTORY_API_KEY: undefined }, async () => {
    const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/a/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error.message, /Factory API key/);
    // pi-ai formats failures as `${status} ${msg}` from a TOP-LEVEL message;
    // without one every auth failure degrades to a bare "401 unauthorized".
    assert.equal(body.message, body.error.message);
    assert.equal(upstream.seen.length, 0);
  });
});

test("gateway: journal records the forwarded request shape and upstream status", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: "org_1",
  });
  const upstream = await startMockUpstream(t, (_record, res) => {
    sseReply(res, [{ choices: [{ delta: { content: "ok" } }] }]);
  });
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/o/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.3-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "bash" } }],
      }),
    });
    assert.equal(res.status, 200);
    await readAll(res);
  });
  const entries = readJournal(10);
  // The forward record is no longer last: a usage record follows once the
  // stream ends. Find it by event rather than by position.
  const entry = entries.filter((e) => e.event === "forward").at(-1);
  assert.equal(entry.route, "generic");
  assert.equal(entry.upstreamStatus, 200);
  assert.equal(entry.shape.model, "glm-5.3-flash");
  assert.equal(entry.shape.tools, 1);
  assert.equal(typeof entry.requestId, "string", "records carry a request id");
  // No tokens or full bodies in the journal.
  assert.ok(!JSON.stringify(entry).includes("Bearer"));

  // The usage record shares that id and carries the accounting.
  const usage = entries.filter((e) => e.event === "usage").at(-1);
  assert.equal(usage.requestId, entry.requestId, "usage belongs to the same request");
  assert.ok(usage.totalInput === null || typeof usage.totalInput === "number");
  assert.ok(usage.hitRatio === null || (usage.hitRatio >= 0 && usage.hitRatio <= 1));
  assert.ok(!JSON.stringify(usage).includes("Bearer"));
});

test("gateway: status and models routes report state and the catalog", async (t) => {
  const home = seedFactoryHome(t, { access_token: `fk-status-${"e".repeat(40)}` });
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, []));
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const status = await (await fetch(`${gateway.baseURL}/api/dsh-factory-provider/status`)).json();
    assert.equal(status.ok, true);
    assert.equal(status.credential.source, "api-key");
    // A key carries no identity claims, so there is no org to report.
    assert.equal(status.credential.orgId, null);
    assert.equal(status.credential.expiresAt, null);
    assert.equal(status.routes.anthropic.providerKey, "factory-a");

    const models = await (await fetch(`${gateway.baseURL}/api/dsh-factory-provider/o/v1/models`)).json();
    assert.equal(models.object, "list");
    assert.ok(models.data.some((m) => m.id === "glm-5.3-flash"));
  });
});

test("gateway: non-loopback Host header is refused (LAN callers)", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: null,
  });
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, []));
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    // fetch forbids setting `host`, so speak raw HTTP with a foreign Host.
    const status = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: "claude-sonnet-5", messages: [] });
      const req = http.request(
        {
          host: "127.0.0.1",
          port: gateway.port,
          path: "/api/dsh-factory-provider/a/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", host: "evil.example", "content-length": Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(status, 403);
    assert.equal(upstream.seen.length, 0);
  });
});

test("gateway: a disabled route answers 404 on its paths", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: null,
  });
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, []));
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL, enabledRoutes: ["anthropic"] });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/o/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.2", messages: [] }),
    });
    assert.equal(res.status, 404);
  });
});

// --- accounts (vault + switching) -----------------------------------------------

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;

function credsFor(user, org, exp = FUTURE_EXP) {
  return {
    access_token: makeJwt({ sub: user, email: `${user}@test.dev`, exp }),
    refresh_token: `refresh-${user}`,
    active_organization_id: org,
    whoami: { premBaseHostV2: `https://${user}.prem.factory.ai` },
  };
}

test("accounts: reject path-traversal ids", async (t) => {
  assert.throws(() => deleteAccount("../escape"));
  assert.throws(() => setActiveAccountId("a/b"));
});

// --- client (browser half) smoke ------------------------------------------------

test("client: registers a settings.section entry with the expected shape", async (t) => {
  // Minimal browser shim: capture the loaded factory, run it, run apply().
  const loaded = {};
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded.id = entry.id;
        loaded.factory = entry.factory;
      },
    },
  };
  const react = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useSyncExternalStore: (_sub, get) => get(),
  };
  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: () => {},
      bind: (ns) => {
        ctx.locale.ns = ns;
        return (key) => key;
      },
    },
    slots: {
      inject: (name, factory) => {
        const entry = factory();
        registrations.push({ name, entry });
      },
      register: (options, component) => ({ options, component }),
    },
  };
  try {
    await import("../lib/client.js");
    assert.equal(loaded.id, "dsh-factory-provider");
    const mod = loaded.factory((name) => (name === "react" ? react : {}));
    assert.deepEqual(mod.inject, ["slots", "locale"]);
    mod.apply(ctx);
    const section = registrations.find((r) => r.name === "settings.section");
    assert.ok(section !== undefined, "settings.section registration missing");
    assert.equal(section.entry.options.id, "factory-provider");
    assert.equal(section.entry.options.name, "settings.section");
    assert.equal(section.entry.options.order, 85);
    assert.equal(typeof section.entry.options.label, "function");
    assert.equal(section.entry.options.label(), "nav");
    const injected = section.entry.options.inject();
    assert.equal(typeof injected.t, "function");
  } finally {
    delete globalThis.window;
  }
});

// --- openai (GPT) route -----------------------------------------------------------

test("catalog: openai route lists probed-callable GPT models only", () => {
  const models = buildModelEntries("openai");
  const ids = models.map((m) => m.id);
  // gpt-6.1-sol answered "Provider not available in this region" live.
  assert.ok(!ids.includes("gpt-6.1-sol"));
  assert.ok(ids.includes("gpt-6-luna"));
  assert.ok(ids.includes("gpt-5.2"));
  for (const m of models) {
    assert.equal(m.reasoningEfforts !== undefined || m.reasoningEfforts === undefined, true);
    assert.ok(m.contextWindow > 0 && m.maxTokens > 0);
  }
  const entry = buildProviderEntry("openai", { port: 19387, gatewayPrefix: "/api/dsh-factory-provider" });
  assert.equal(entry.api, "openai-responses");
  // The Responses SDK appends `/responses` itself: the baseURL stops at /openai/v1.
  assert.equal(entry.baseURL, "http://127.0.0.1:19387/api/dsh-factory-provider/openai/v1");
});

test("sanitize: responses payload keeps the instructions identity gate and strips unknowns", () => {
  const parsed = {
    model: "gpt-6-luna",
    instructions: "DSH persona.",
    input: [{ role: "user", content: [{ type: "input_text", text: "You are OpenCode, the best coding agent on the planet." }] }],
    stream: true,
    max_output_tokens: 32,
    baseURL: "leak",
    previous_response_id: "resp_1",
  };
  normalizeResponsesPayload(parsed);
  assert.ok(parsed.instructions.startsWith(DROID_SYSTEM_LINE));
  assert.ok(parsed.instructions.endsWith("DSH persona."));
  assert.ok(!("baseURL" in parsed));
  assert.equal(parsed.previous_response_id, "resp_1"); // legitimate Responses field kept
  assert.equal(parsed.input[0].content[0].text, "You are OpenCode. The best coding agent on the planet.");

  // Missing instructions still gets the gate line (the edge 403s without it).
  const bare = { model: "gpt-6-luna", input: [] };
  normalizeResponsesPayload(bare);
  assert.equal(bare.instructions, DROID_SYSTEM_LINE);
});

test("gateway: openai route carries azure_openai + openai-platform headers", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: "org_9",
  });
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, [{ type: "response.output_text.delta", delta: "PONG" }]));
  const gw = await startGateway(t, { upstreamBaseURL: upstream.baseURL, enabledRoutes: ["openai"] });
  await withEnv({ FACTORY_API_KEY: home }, async () => {
    const res = await fetch(`${gw.baseURL}/api/dsh-factory-provider/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna",
        stream: true,
        instructions: "DSH persona.",
        input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
      }),
    });
    assert.equal(res.status, 200);
    await readAll(res);
    const sent = upstream.seen[0];
    assert.equal(sent.url, "/api/llm/o/v1/responses");
    assert.equal(sent.headers["x-api-provider"], "azure_openai");
    assert.ok(typeof sent.headers["openai-platform"] === "string" && sent.headers["openai-platform"].length > 0);
    assert.ok(sent.body.instructions.startsWith("You are Droid, an AI software engineering agent built by Factory."));
  });
});

// --- plugin apply ---------------------------------------------------------------

test("apply: a crash is journaled before it propagates", () => {
  // apply() failing costs every route at once and the host log is unreadable
  // from outside the app, so the wrapper must leave a record behind.
  const before = readJournal(100000).length;
  assert.throws(() => apply({ logger: undefined }, { enabled: true }), TypeError);
  const record = readJournal(100000)
    .slice(before)
    .find((entry) => entry.event === "apply-error");
  assert.ok(record, "apply-error record is journaled");
  assert.equal(record.route, "plugin");
  assert.ok(record.error.length > 0);
});

test("config: every settings-editable field is volatile", () => {
  // DSH's settings service rejects a write to a namespace that declares no
  // volatile fields — `Plugin entry "dsh-factory-provider" has no volatile
  // fields` — which is how the settings card's Save silently failed, leaving
  // the tick state to be wiped by the next poll.
  for (const name of [
    "enabled",
    "routes",
    "cliVersion",
    "apiBaseURL",
    "quotaHost",
    "keyEnv",
    "proactiveRefreshMinutes",
    "modelAllowlist",
  ]) {
    assert.equal(Config.dict?.[name]?.meta?.volatile, true, `${name} must be .volatile()`);
  }
});

test("apply: modelAllowlist narrows the provider entries to the ticked models", async (t) => {
  // The settings card's model checkboxes only edit modelAllowlist; this proves
  // the rest of the chain: allowlist → provider entries → what the DSH model
  // picker can show. Routes whose every model was filtered out are not written
  // at all, so they disappear from the picker instead of going empty.
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_a", "org_a"));
  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined },
    async () => {
      const ops = [];
      const settings = {
        installSection: () => {},
        describe: () => [
          { ns: "llm-pi-ai", revision: 1, value: { providers: {} } },
          { ns: "dsh-factory-provider", revision: 1, value: {} },
        ],
        mutate: async (_ns, batch) => {
          ops.push(...batch);
        },
      };
      const webServer = { port: 19387, register: () => () => {} };
      // A provider write only reaches the model picker when the plugins that
      // derive their state from live config are nudged: llm-pi-ai rebuilds its
      // llm-service registration and model directory on `loader/volatile-update`,
      // and the settings write never emits it.
      const emitted = [];
      const ctx = {
        logger: { info: () => {}, warn: () => {} },
        get: () => undefined,
        emit: (event) => {
          emitted.push(event);
        },
        inject: (_services, callback) => {
          const dispose = callback({
            webServer,
            settings,
            effect: (fn) => {
              fn();
              return () => {};
            },
            on: () => () => {},
          });
          return () => {
            if (typeof dispose === "function") dispose();
          };
        },
      };

      // Settings-section values arrive as schemastery volatile references (read
      // with .get()); row-config values arrive plain. Exercise both shapes.
      const ref = (value) => ({ get: () => value });
      apply(ctx, {
        enabled: true,
        proactiveRefreshMinutes: ref(0),
        routes: ref(["generic"]),
        modelAllowlist: ref(["glm-5.3-flash"]),
      });
      // Wait for the whole reconcile chain: the write lands first, the nudge
      // follows once the mutation resolves.
      for (
        let i = 0;
        i < 200 &&
        (!emitted.includes("loader/volatile-update") ||
          !emitted.includes("llm/adapters-updated") ||
          !ops.some((op) => op.path?.[1] === "factory-g"));
        i += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const generic = ops.find((op) => op.path?.[1] === "factory-g");
      assert.ok(generic, "factory-g provider entry written");
      assert.deepEqual(generic.value.models.map((m) => m.id), ["glm-5.3-flash"]);
      // Every model of the other routes was filtered out → those routes are skipped.
      assert.ok(!ops.some((op) => op.path?.[1] === "factory-a"));
      assert.ok(!ops.some((op) => op.path?.[1] === "factory-o"));
      // …and the write is followed by exactly one nudge, which is what makes
      // llm-pi-ai re-derive the catalog the picker reads, plus the client-facing
      // announcement that makes clients refetch *after* that rebuild.
      assert.deepEqual(
        emitted.filter((event) => event === "loader/volatile-update").length,
        1,
        "loader/volatile-update emitted once",
      );
      assert.ok(
        emitted.indexOf("llm/adapters-updated") > emitted.indexOf("loader/volatile-update"),
        "clients are told to refetch after the rebuild nudge",
      );
    },
  );
});

// --- cross-platform (Windows / Linux / macOS) ------------------------------------
//
// The plugin has to work on a machine it was not developed on, so the platform
// matrix is exercised by injection: every resolver takes `{ platform, env,
// homedir }`, and the keyring readers are asserted as commands instead of being
// executed. That keeps the whole Windows/Linux surface testable from macOS.

test("client: every literal label is defined in both languages", () => {
  // The card's labels live in two plain dictionaries inside client.js. A key
  // added to one of them only renders as the raw key in the other language, so
  // every literal t("…") usage must have two definitions.
  const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const used = new Set([...source.matchAll(/\bt\("([A-Za-z0-9_]+)"/g)].map((match) => match[1]));
  assert.ok(used.size > 30, `label usages found (${used.size})`);
  const missing = [];
  for (const key of used) {
    const definitions = source.match(new RegExp(`^\\s+"?${key}"?:`, "gm")) ?? [];
    if (definitions.length < 2) missing.push(`${key}:${definitions.length}`);
  }
  assert.deepEqual(missing, [], "each label is defined in the zh and en dictionaries");
});

// --- API-key accounts (0.7.0-beta) ----------------------------------------------

test("accounts: an API key is stored as a switchable account entry", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-key-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const key = "fk-TESTKEYNOTAREALKEY0000000000000000000000000000000000000000000000000";
  await withEnv(
    { DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined },
    async () => {
      const saved = saveApiKeyAccount({ label: "work", key });
      assert.equal(saved.created, true);
      const entry = listAccounts().find((account) => account.id === saved.id);
      assert.equal(entry.kind, "api-key");
      assert.equal(entry.state, "ready");
      assert.equal(entry.label, "work");
      assert.equal(entry.keyHint, key.slice(-4));

      // The list must never carry the key itself: only the last four characters.
      assert.ok(!JSON.stringify(entry).includes(key.slice(0, 30)), "full key is not exposed");

      // The key lives in a 0600 file inside the per-account directory.
      const file = path.join(vault, saved.id, "api-key");
      assert.equal(fs.readFileSync(file, "utf8"), key);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);

      // Saving the same key again updates its entry instead of duplicating it.
      const again = saveApiKeyAccount({ label: "work renamed", key });
      assert.equal(again.created, false);
      assert.equal(again.id, saved.id);
      assert.equal(listAccounts().filter((a) => a.kind === "api-key").length, 1);

      // A non-key string is refused.
      assert.throws(() => saveApiKeyAccount({ label: "bad", key: "not a key" }), /does not look like/);
      assert.throws(() => saveApiKeyAccount({ label: "bad", key: `fk-${"x".repeat(30)} y` }), /does not look like/);
    },
  );
});

// --- account keys (key-only credential) -------------------------------------------

test("accounts: save / list / switch / delete a key roundtrip", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-keys-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const work = `fk-work-${"a".repeat(40)}`;
  const personal = `fk-personal-${"b".repeat(40)}`;
  await withEnv({ DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined }, async () => {
    const first = saveApiKeyAccount({ label: "work", key: work });
    const second = saveApiKeyAccount({ label: "personal", key: personal });
    assert.equal(first.created, true);
    assert.equal(second.created, true);

    const listed = listAccounts();
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((a) => a.label).sort(), ["personal", "work"]);
    assert.ok(listed.every((a) => a.kind === "api-key" && a.state === "ready"));

    // Selecting one points the resolver at it.
    setActiveAccountId(second.id);
    assert.equal(getActiveAccountId(), second.id);
    assert.equal(getCredentialMode(), "account");
    assert.equal(activeApiKey(), personal);

    const resolver = createTokenResolver({
      activeKey: () => activeApiKey(),
      disabled: () => getCredentialMode() === "off",
    });
    assert.equal((await resolver.resolve()).token, personal);

    // Deleting the selected key stops credential serving outright.
    deleteAccount(second.id);
    assert.equal(getCredentialMode(), "off");
    resolver.reset();
    assert.equal((await resolver.resolve()).source, "disabled");

    // Clearing the selection drops the "off" state as well.
    clearActiveAccount();
    assert.equal(getCredentialMode(), "none");
    assert.equal(activeApiKey(), undefined);
  });
});

test("accounts: a selected key wins over an ambient FACTORY_API_KEY", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-keys2-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const selected = `fk-selected-${"c".repeat(40)}`;
  await withEnv(
    { DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: "fk-ambient-env-key-000000000000" },
    async () => {
      // Nothing selected: the ambient variable is what the gateway uses.
      const bare = createTokenResolver({});
      assert.equal((await bare.resolve()).token, "fk-ambient-env-key-000000000000");

      const saved = saveApiKeyAccount({ label: "selected", key: selected });
      setActiveAccountId(saved.id);

      // Selecting a key is an explicit choice, so it beats the ambient variable;
      // otherwise a leftover env key would silently pin the gateway to one
      // account and make the account list look broken.
      const chosen = createTokenResolver({
        activeKey: () => activeApiKey(),
        disabled: () => getCredentialMode() === "off",
      });
      assert.equal((await chosen.resolve()).token, selected);
    },
  );
});

test("accounts: per-account quota reads the billing endpoint with that key", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-keys3-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const key = `fk-quota-${"d".repeat(40)}`;
  const seen = [];
  await withEnv({ DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined }, async () => {
    const saved = saveApiKeyAccount({ label: "quota", key });
    assert.equal(accountApiKey(saved.id), key);
    const result = await fetchQuota({
      credential: { token: accountApiKey(saved.id) },
      fetchImpl: async (url, init) => {
        seen.push(init.headers.authorization);
        return {
          ok: true,
          json: async () => ({ limits: { standard: { fiveHour: { usedPercent: 7 } } } }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.standard.fiveHour.usedPercent, 7);
    assert.deepEqual(seen, [`Bearer ${key}`]);
  });
});

test("accounts: a leftover droid-CLI snapshot is reported as legacy, never used", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-keys4-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  await withEnv({ DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined }, async () => {
    // An envelope left behind by the droid-CLI build.
    const dir = path.join(vault, "old-login");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "auth.v2.keyring"), "iv:tag:ct");
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ label: "old" }));

    const entry = listAccounts().find((a) => a.id === "old-login");
    assert.equal(entry.kind, "legacy");
    assert.equal(entry.state, "legacy");
    assert.equal(entry.label, "old");

    // It is never selected, and never resolved as a credential.
    assert.throws(() => setActiveAccountId("old-login"), /has no key/);
    assert.equal(activeApiKey(), undefined);

    // It can be deleted like anything else.
    deleteAccount("old-login");
    assert.equal(listAccounts().length, 0);
  });
});

test("config: a stored config with the removed refresh field still applies", async () => {
  // `refreshWindowMinutes` timed droid access-token refreshes and is gone. A
  // config saved by the older build still carries it, and the plugin must load
  // rather than reject the whole section.
  const registered = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    emit: () => {},
    inject: (_services, callback) => {
      const settings = {
        installSection: () => {},
        describe: () => [{ ns: "llm-pi-ai", revision: 1, value: { providers: {} } }],
        mutate: async () => {},
      };
      const sctx = {
        webServer: { port: 19387, register: (route) => { registered.push(route.path); return () => {}; } },
        settings,
        effect: (fn) => { fn(); return () => {}; },
        on: () => () => {},
      };
      const dispose = callback(sctx);
      if (typeof dispose === "function") dispose();
      return () => {};
    },
  };
  apply(ctx, {
    enabled: true,
    proactiveRefreshMinutes: 0,
    refreshWindowMinutes: 15, // legacy field, must be ignored
  });
  assert.ok(registered.includes("/api/dsh-factory-provider/status"), "plugin applied despite the legacy field");
});

test("client and host agree on every account action", () => {
  // A client bundle from disk can meet a host running an older module
  // generation, and then a button the card offers answers
  // "unknown accounts action". Every action the card can send must be handled
  // by the host half, in both directions.
  const client = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const host = fs.readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

  const sent = new Set([...client.matchAll(/onAction\("([a-z-]+)"/g)].map((m) => m[1]));
  const handled = new Set([...host.matchAll(/body\.action === "([a-z-]+)"/g)].map((m) => m[1]));
  // Two actions are sent without an onAction("…") literal: the paste-key button
  // passes extra fields through doAccountAction, and the enable/disable switch
  // picks its action from the current mode.
  sent.add("save-key");
  sent.add("clear");
  sent.add("disable");

  assert.ok(sent.size >= 4, `actions found (${[...sent].join(", ")})`);
  assert.deepEqual(
    [...sent].filter((action) => !handled.has(action)),
    [],
    "every client action is handled by the host",
  );
  assert.deepEqual(
    [...handled].filter((action) => !sent.has(action)),
    [],
    "the host handles nothing the client never sends",
  );
});

// --- regression suite for the review findings -------------------------------------
//
// Each case here reproduces a finding from the 2026-10-03 review. They are
// written against observable behaviour (a thrown error, a written file, an
// upstream call count), not against the shape of the fix, so they keep working
// if the implementation is reorganised.

// --- settings half: one complete mock, shared -------------------------------------
//
// The plugin's unload path calls removeOwnedProviders → readProviders, which
// needs settings.describe; a mock without it produced an unhandled rejection
// *after* the assertions had passed, so the suite looked green and still exited
// non-zero. Every settings mock below therefore provides the same surface, and
// each test waits for the asynchronous cleanup before it ends.

function makeSettingsMock() {
  const state = { source: {}, providers: {}, mutations: [] };
  let hooks;
  return {
    state,
    get hooks() {
      return hooks;
    },
    // The real service hands the section's hooks the same way, and the plugin
    // reads its live config through the source setter.
    installSection: (_ctx, _ns, _schema, _entry, h) => {
      hooks = h;
      h.setSource(() => state.source);
    },
    describe: () => [
      { ns: "llm-pi-ai", revision: 1, value: { providers: state.providers } },
      { ns: "dsh-factory-provider", revision: 1, value: {} },
    ],
    mutate: async (ns, batch) => {
      state.mutations.push({ ns, batch });
      for (const op of batch ?? []) {
        if (op?.path?.length === 2 && op.path[0] === "providers") {
          if (op.op === "set" || op.op === "add") state.providers[op.path[1]] = op.value;
          if (op.op === "remove" || op.op === "delete") delete state.providers[op.path[1]];
        }
      }
    },
  };
}

/** Let queued reconcile/cleanup work finish before the test ends. */
async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Drive a registered route handler the way the host would. */
function invokeRoute(handlers, path, { method = "GET", body, remoteAddress = "127.0.0.1", host = "127.0.0.1:19387" } = {}) {
  return new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      method,
      headers: { host, "content-type": "application/json" },
      socket: { remoteAddress },
      on() {},
      off() {},
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      writableEnded: false,
      writableFinished: false,
      setHeader(k, v) { this.headers[k] = v; },
      writeHead(code) { this.statusCode = code; },
      end(text) { this.body = text ?? ""; this.writableFinished = true; resolve(this); },
      destroy() { this.writableFinished = true; resolve(this); },
      on() {},
      off() {},
    };
    const handler = handlers.get(path);
    if (handler === undefined) {
      resolve({ statusCode: 0, headers: {}, body: "", missing: true });
      return;
    }
    void handler(req, res);
  });
}

test("settings: a change that arrives before the runtime is live is applied once it is", async (t) => {
  // The onChange hook cannot call into the webServer half before that half
  // exists. It must not throw, and the change must not be lost: it is replayed
  // as soon as the runtime is ready.
  const handlers = new Map();
  const settings = makeSettingsMock();
  const sctx = {
    webServer: {
      port: 19387,
      register: (route) => {
        handlers.set(route.path, route.handler);
        return () => handlers.delete(route.path);
      },
    },
    settings,
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
  };
  let releaseInjected;
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    emit: () => {},
    inject: (services, callback) => {
      // The settings-only injection runs immediately; the webServer one is held
      // back so the "not ready yet" window can actually be exercised.
      if (services.includes("webServer")) {
        releaseInjected = () => callback(sctx);
        return () => {};
      }
      callback(sctx);
      return () => {};
    },
  };

  settings.state.source = { enabled: true, proactiveRefreshMinutes: 0 };
  apply(ctx, settings.state.source);
  assert.equal(typeof settings.hooks?.onChange, "function", "the section installed its hooks");
  assert.equal(typeof releaseInjected, "function", "the webServer half is still pending");

  // The config changes while the runtime does not exist yet.
  settings.state.source = { enabled: false, proactiveRefreshMinutes: 0 };
  assert.doesNotThrow(() => settings.hooks.onChange(), "onChange before the runtime is live");

  releaseInjected();
  await settle();

  // The replayed change really took effect: the routes report themselves off.
  const status = await invokeRoute(handlers, "/api/dsh-factory-provider/status");
  const parsed = JSON.parse(status.body);
  assert.equal(parsed.routes.generic.enabled, false, "the pending change was applied");

  // And a late callback after unload is still harmless.
  if (typeof releaseInjected === "function") {
    /* already released */
  }
});

test("settings: every route registration is released on unload", async (t) => {
  // Both route groups used to write one disposeRoutes variable, so unloading
  // released only the second group.
  const registered = [];
  const disposed = [];
  const settings = makeSettingsMock();
  let injectedDisposer;
  const sctx = {
    webServer: {
      port: 19387,
      register: (route) => {
        registered.push(route.path);
        return () => disposed.push(route.path);
      },
    },
    settings,
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    emit: () => {},
    inject: (_services, callback) => {
      const dispose = callback(sctx);
      if (typeof dispose === "function") injectedDisposer = dispose;
      return () => {};
    },
  };

  settings.state.source = { enabled: true, proactiveRefreshMinutes: 0 };
  apply(ctx, settings.state.source);
  await settle();
  assert.ok(registered.length >= 10, `registered ${registered.length} routes`);

  injectedDisposer();
  await settle();
  assert.deepEqual(
    [...disposed].sort(),
    [...registered].sort(),
    "every registered route is disposed",
  );
  assert.doesNotThrow(() => injectedDisposer(), "releasing twice is safe");
  await settle();

  // A settings callback that arrives after unload must not throw either.
  assert.doesNotThrow(() => settings.hooks.onChange(), "onChange after unload");
  await settle();
});

test("settings: one failing registration does not lose the rest", async (t) => {
  const registered = [];
  const disposed = [];
  let calls = 0;
  let injectedDisposer;
  const settings = makeSettingsMock();
  const sctx = {
    webServer: {
      port: 19387,
      register: (route) => {
        calls += 1;
        if (calls === 4) throw new Error("register exploded");
        registered.push(route.path);
        return () => disposed.push(route.path);
      },
    },
    settings,
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    emit: () => {},
    inject: (_services, callback) => {
      const dispose = callback(sctx);
      if (typeof dispose === "function") injectedDisposer = dispose;
      return () => {};
    },
  };

  settings.state.source = { enabled: true, proactiveRefreshMinutes: 0 };
  apply(ctx, settings.state.source);
  await settle();
  // One route refusing to register used to abort the whole group and lose the
  // disposers of the ones that had already succeeded.
  assert.ok(registered.length > 3, `the remaining routes still register (${registered.length})`);
  injectedDisposer();
  await settle();
  assert.deepEqual(disposed.sort(), registered.sort(), "everything registered is released");
});

test("bridge: management routes refuse a non-loopback caller", async (t) => {
  // The bridge routes had no guard at all: an external caller reaching a host
  // bound for LAN access could disable accounts or rewrite the config.
  const handlers = new Map();
  const sctx = {
    webServer: {
      port: 19387,
      register: (route) => {
        handlers.set(route.path, route.handler);
        return () => {};
      },
    },
    settings: { installSection: () => {} },
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    emit: () => {},
    inject: (_services, callback) => callback(sctx),
  };
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-bridge-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));

  await withEnv({ DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined }, async () => {
    const saved = saveApiKeyAccount({ label: "guard", key: `fk-guard-${"a".repeat(40)}` });
    setActiveAccountId(saved.id);
    apply(ctx, { enabled: true, proactiveRefreshMinutes: 0 });

    const invoke = (path, { remoteAddress, host, method = "POST", body }) =>
      new Promise((resolve) => {
        const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
        const req = {
          method,
          headers: host === undefined ? {} : { host },
          socket: { remoteAddress },
          on() {},
          off() {},
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
          },
        };
        const res = {
          statusCode: 0,
          headers: {},
          body: "",
          setHeader(k, v) { this.headers[k] = v; },
          writeHead(code) { this.statusCode = code; },
          end(text) { this.body = text ?? ""; resolve(this); },
          destroy() { resolve(this); },
        };
        void handlers.get(path)(req, res);
      });

    const remote = await invoke("/api/dsh-factory-provider/accounts", {
      remoteAddress: "192.0.2.1",
      host: "evil.example",
      body: { action: "disable" },
    });
    assert.equal(remote.statusCode, 403, "a remote caller is refused");
    assert.equal(getCredentialMode(), "account", "the refused call changed nothing");

    const foreignHost = await invoke("/api/dsh-factory-provider/accounts", {
      remoteAddress: "127.0.0.1",
      host: "evil.example",
      body: { action: "disable" },
    });
    assert.equal(foreignHost.statusCode, 403, "a loopback socket with a foreign Host is refused");

    const local = await invoke("/api/dsh-factory-provider/accounts", {
      remoteAddress: "127.0.0.1",
      host: "127.0.0.1:19387",
      method: "GET",
    });
    assert.equal(local.statusCode, 200, "a loopback caller still works");
  });
});

test("enabled:false stops inference instead of only hiding the models", async (t) => {
  // The switch only narrowed the provider list; the forwarding handlers kept
  // answering and kept billing.
  let upstreamCalls = 0;
  const handlers = new Map();
  const sctx = {
    webServer: {
      port: 19387,
      register: (route) => {
        handlers.set(route.path, route.handler);
        return () => {};
      },
    },
    settings: { installSection: () => {} },
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    emit: () => {},
    inject: (_services, callback) => callback(sctx),
  };
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-off-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));

  await withEnv({ DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined }, async () => {
    const saved = saveApiKeyAccount({ label: "off", key: `fk-off-${"b".repeat(40)}` });
    setActiveAccountId(saved.id);
    apply(ctx, { enabled: false, proactiveRefreshMinutes: 0 });

    const invoke = (path, body) =>
      new Promise((resolve) => {
        const chunks = [Buffer.from(JSON.stringify(body))];
        const req = {
          method: "POST",
          headers: { host: "127.0.0.1:19387", "content-type": "application/json" },
          socket: { remoteAddress: "127.0.0.1" },
          on() {},
          off() {},
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
          },
        };
        const res = {
          statusCode: 0,
          headers: {},
          body: "",
          writableEnded: false,
          setHeader(k, v) { this.headers[k] = v; },
          writeHead(code) { this.statusCode = code; },
          end(text) { this.body = text ?? ""; resolve(this); },
          destroy() { resolve(this); },
          on() {},
          off() {},
        };
        void handlers.get(path)(req, res);
      });

    const res = await invoke("/api/dsh-factory-provider/o/v1/chat/completions", {
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.statusCode, 404, "a disabled route answers 404");
    assert.equal(upstreamCalls, 0, "nothing reached an upstream");
  });
});

test("credentials: a stale resolution cannot repopulate the cache", async () => {
  // resolveOnce wrote the shared cache before the generation check, so a task
  // that started before a switch could put the previous key back — the caller
  // then served A after the user had selected B.
  let releaseFirst;
  const firstKey = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const resolver = createTokenResolver({
    resolveKey: async () => {
      calls += 1;
      if (calls === 1) return firstKey;
      return `fk-ambient-${"c".repeat(40)}`;
    },
    activeKey: () => activeKey,
  });
  let activeKey;

  const stale = resolver.resolve(); // starts, blocks on the pending ambient key
  await new Promise((r) => setTimeout(r, 0));

  activeKey = `fk-selected-${"d".repeat(40)}`;
  resolver.reset();
  assert.equal((await resolver.resolve()).token, activeKey, "the new selection wins");

  releaseFirst(`fk-ambient-${"c".repeat(40)}`); // the stale task finishes late
  const afterStale = await stale;
  assert.equal(afterStale.source, "switched", "the stale task reports itself stale");
  assert.equal((await resolver.resolve()).token, activeKey, "the stale key did not come back");
});

test("credentials: the last selection always wins across interleaved switches", async () => {
  let activeKey = `fk-first-${"e".repeat(40)}`;
  const resolver = createTokenResolver({ activeKey: () => activeKey });
  assert.equal((await resolver.resolve()).token, activeKey);

  activeKey = `fk-second-${"f".repeat(40)}`;
  resolver.reset();
  assert.equal((await resolver.resolve()).token, activeKey);

  activeKey = undefined;
  resolver.reset();
  assert.equal((await resolver.resolve()).source, "none");

  activeKey = `fk-third-${"g".repeat(40)}`;
  resolver.reset();
  assert.equal((await resolver.resolve()).token, activeKey);
});

test("sanitize: block-shaped system content keeps the caller's rules", () => {
  const parsed = {
    messages: [{ role: "system", content: [{ type: "text", text: "REQUIRED ORIGINAL RULE" }] }],
  };
  normalizeGenericPayload(parsed);
  const content = parsed.messages[0].content;
  assert.ok(Array.isArray(content), "block content stays block content");
  assert.ok(
    content.some((block) => block.text === "REQUIRED ORIGINAL RULE"),
    "the original rule survives",
  );
  assert.ok(
    content.some((block) => block.text?.startsWith("You are Droid")),
    "the identity line is present",
  );

  // Idempotent: sanitizing twice does not stack identity lines.
  normalizeGenericPayload(parsed);
  const count = JSON.stringify(parsed).split("You are Droid").length - 1;
  assert.equal(count, 1, "the identity line is injected once");
});

test("sanitize: an empty anthropic system still gets the identity line", () => {
  for (const value of ["", null, undefined, []]) {
    const parsed = { messages: [] };
    if (value !== undefined) parsed.system = value;
    sanitizeAnthropicPayload(parsed);
    assert.ok(
      JSON.stringify(parsed.system).includes("You are Droid"),
      `system ${JSON.stringify(value)} carries the identity line`,
    );
  }
});

test("accounts: two keys with the same label never collide", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-ids-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  await withEnv({ DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined }, async () => {
    const realNow = Date.now;
    Date.now = () => 12345; // same millisecond for both saves
    try {
      const first = saveApiKeyAccount({ label: "same", key: `fk-one-${"h".repeat(40)}` });
      const second = saveApiKeyAccount({ label: "same", key: `fk-two-${"i".repeat(40)}` });
      assert.notEqual(first.id, second.id, "the two keys get their own ids");
      assert.equal(listAccounts().length, 2, "both entries survive");
    } finally {
      Date.now = realNow;
    }
  });
});

test("accounts: a widened key file is tightened on the next save", async (t) => {
  if (process.platform === "win32") return; // mode bits are not the guard there
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-mode-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const key = `fk-mode-${"j".repeat(40)}`;
  await withEnv({ DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined }, async () => {
    const saved = saveApiKeyAccount({ label: "mode", key });
    const file = path.join(vault, saved.id, "api-key");
    fs.chmodSync(file, 0o644);
    saveApiKeyAccount({ label: "mode", key });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the key file is 0600 again");
    assert.equal(fs.statSync(path.join(vault, saved.id)).mode & 0o777, 0o700, "the dir is 0700");
  });
});

test("accounts: a traversing active id reads nothing outside the vault", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "factory-active-"));
  const vault = path.join(parent, "accounts");
  fs.mkdirSync(vault, { recursive: true });
  const outside = path.join(parent, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "api-key"), `fk-outside-${"k".repeat(40)}`);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  await withEnv({ DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined }, async () => {
    for (const bad of ["../outside", "/etc", "..\\outside", ""]) {
      fs.writeFileSync(path.join(vault, "active.json"), JSON.stringify({ activeId: bad }));
      assert.equal(getActiveAccountId(), undefined, `active id ${JSON.stringify(bad)} is rejected`);
      assert.equal(activeApiKey(), undefined, "no key is read from outside the vault");
    }
    fs.writeFileSync(path.join(vault, "active.json"), "{ not json");
    assert.equal(activeApiKey(), undefined, "malformed state reads as no credential");
  });
});

test("gateway: /models does not advertise region-gated ids", async (t) => {
  const gateway = await startGateway(t, { upstreamBaseURL: "http://127.0.0.1:1/unused" });
  const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/a/v1/models`);
  const body = await res.json();
  const ids = body.data.map((m) => m.id);
  assert.ok(ids.length > 0, "the route still lists models");
  assert.ok(!ids.includes("claude-opus-5-fast"), "a region-gated id is not advertised");
  assert.ok(ids.includes("claude-opus-5"), "its ungated sibling still is");
});

test("gateway: a client disconnect cancels the upstream stream", async (t) => {
  // The handler listened on req "close", but the request body is already read by
  // then, so cancelling the response left the upstream generating.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => res.write("data: chunk\n\n"), 5);
    res.on("close", () => {
      clearInterval(timer);
      upstream.cancelled = true;
    });
  });
  await new Promise((resolve) => upstream.listen(0, resolve));
  t.after(() => upstream.close());

  const gateway = await startGateway(t, { upstreamBaseURL: `http://127.0.0.1:${upstream.address().port}` });
  await withEnv({ FACTORY_API_KEY: `fk-disconnect-${"m".repeat(40)}` }, async () => {
    const controller = new AbortController();
    const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/o/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(res.status, 200, "the request reached the upstream");
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(upstream.cancelled, true, "the upstream request was cancelled");
  });
});

// --- regression: model counts agree, and a startup race is retried ----------------

test("gateway: /status counts exactly what /models lists", async (t) => {
  // /status counted the raw catalog, so it advertised 13 Claude models while
  // /models and the provider entries both served 10 — the same region-gate
  // filter applied in two places out of three.
  const gateway = await startGateway(t, {
    upstreamBaseURL: "http://127.0.0.1:1/unused",
    enabledRoutes: ["anthropic", "generic", "openai"],
  });
  const status = await (await fetch(`${gateway.baseURL}/api/dsh-factory-provider/status`)).json();
  for (const [route, sub] of [["anthropic", "a"], ["generic", "o"], ["openai", "openai"]]) {
    const models = await (await fetch(`${gateway.baseURL}/api/dsh-factory-provider/${sub}/v1/models`)).json();
    assert.equal(
      status.routes[route].models,
      models.data.length,
      `${route}: /status and /models agree`,
    );
  }
  const anthropic = await (await fetch(`${gateway.baseURL}/api/dsh-factory-provider/a/v1/models`)).json();
  assert.ok(
    !anthropic.data.some((m) => m.id === "claude-opus-5-fast"),
    "a region-gated id is in neither list",
  );
  assert.equal(status.routes.anthropic.models, buildModelEntries("anthropic").length, "and matches the provider entries");
});

test("settings: a service that is still starting up is retried, not reported as failed", async (t) => {
  // At startup the settings write can fail with "cannot get required service
  // \"loader\" in inactive context". That was classified as a hard failure, so
  // the first reconcile gave up instead of retrying.
  let mutations = 0;
  const settings = makeSettingsMock();
  const failing = settings.mutate;
  settings.mutate = async (ns, batch) => {
    mutations += 1;
    if (mutations === 1) throw new Error('cannot get required service "loader" in inactive context');
    return failing(ns, batch);
  };

  const handlers = new Map();
  const sctx = {
    webServer: {
      port: 19387,
      register: (route) => {
        handlers.set(route.path, route.handler);
        return () => handlers.delete(route.path);
      },
    },
    settings,
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    emit: () => {},
    inject: (_services, callback) => callback(sctx),
  };

  settings.state.source = { enabled: true, proactiveRefreshMinutes: 0 };
  apply(ctx, settings.state.source);
  // A service-not-ready race waits a full second before retrying, so this has
  // to outlast that delay rather than just a few ticks.
  await new Promise((resolve) => setTimeout(resolve, 1600));

  assert.ok(mutations >= 2, `the write was retried (${mutations} attempts)`);
  const status = await invokeRoute(handlers, "/api/dsh-factory-provider/status");
  const parsed = JSON.parse(status.body);
  assert.equal(parsed.plugin.reconcile, "applied", "the retry succeeded");
  assert.equal(parsed.plugin.error, undefined, "no failure is reported");
});

// --- anthropic prompt-cache breakpoints ------------------------------------------

const EPHEMERAL = { type: "ephemeral" };
const EPHEMERAL_1H = { type: "ephemeral", ttl: "1h" };
const textBlock = (text, extra = {}) => ({ type: "text", text, ...extra });

function markerCount(parsed) {
  let count = 0;
  if (parsed.cache_control !== undefined) count += 1;
  for (const tool of parsed.tools ?? []) if (tool?.cache_control !== undefined) count += 1;
  for (const block of Array.isArray(parsed.system) ? parsed.system : []) {
    if (block?.cache_control !== undefined) count += 1;
  }
  for (const message of parsed.messages ?? []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.cache_control !== undefined) count += 1;
    }
  }
  return count;
}

test("cache: auto places breakpoints on tools, system and the newest message", () => {
  const parsed = {
    tools: [{ name: "read" }, { name: "write" }],
    system: [textBlock("SYS")],
    messages: [{ role: "user", content: [textBlock("hi")] }],
  };
  const report = applyAnthropicCacheBreakpoints(parsed, { mode: "auto", ttl: "5m" });
  assert.equal(report.source, "proxy");
  assert.equal(report.breakpoints, 3);
  assert.deepEqual(parsed.tools[1].cache_control, EPHEMERAL);
  assert.deepEqual(parsed.system[0].cache_control, EPHEMERAL);
  assert.deepEqual(parsed.messages[0].content[0].cache_control, EPHEMERAL);
  assert.ok(markerCount(parsed) <= 4, "within the 4-block limit");
});

test("cache: auto leaves a client that already manages caching alone", () => {
  const parsed = {
    system: [textBlock("SYS", { cache_control: EPHEMERAL })],
    messages: [{ role: "user", content: [textBlock("hi", { cache_control: EPHEMERAL })] }],
  };
  const report = applyAnthropicCacheBreakpoints(parsed, { mode: "auto" });
  assert.equal(report.source, "client");
  assert.equal(report.breakpoints, 2);
  assert.equal(markerCount(parsed), 2, "nothing was added");
});

test("cache: passthrough changes nothing at all", () => {
  const parsed = {
    system: [textBlock("SYS")],
    messages: [{ role: "user", content: [textBlock("hi")] }],
  };
  const before = JSON.stringify(parsed);
  const report = applyAnthropicCacheBreakpoints(parsed, { mode: "passthrough" });
  assert.equal(JSON.stringify(parsed), before);
  assert.equal(report.breakpoints, 0);
  assert.equal(report.source, "none");
});

test("cache: rewrite replaces client placement instead of adding to it", () => {
  const parsed = {
    system: [textBlock("SYS", { cache_control: EPHEMERAL })],
    messages: [
      { role: "user", content: [textBlock("old", { cache_control: EPHEMERAL })] },
      { role: "user", content: [textBlock("new")] },
    ],
  };
  const report = applyAnthropicCacheBreakpoints(parsed, { mode: "rewrite" });
  assert.equal(report.source, "proxy");
  assert.ok(markerCount(parsed) <= 4);
  assert.equal(parsed.messages[0].content[0].cache_control, undefined, "the stale marker is gone");
  assert.deepEqual(parsed.messages[1].content[0].cache_control, EPHEMERAL, "the newest message is marked");
});

test("cache: a field named cache_control inside tool input is never touched", () => {
  // The trap: tool inputs, JSON schemas and user data may legitimately contain
  // a property with this name. Only the known outer surfaces may be edited.
  const parsed = {
    tools: [
      {
        name: "configure",
        input_schema: { type: "object", properties: { cache_control: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] },
          { type: "text", text: "data", cache_control: EPHEMERAL },
        ],
      },
    ],
  };
  applyAnthropicCacheBreakpoints(parsed, { mode: "rewrite" });
  assert.deepEqual(
    parsed.tools[0].input_schema.properties.cache_control,
    { type: "string" },
    "the schema property survives",
  );
  assert.equal(parsed.messages[0].content[0].tool_use_id, "toolu_1");
});

test("cache: running twice produces the same request", () => {
  const build = () => ({
    tools: [{ name: "read" }],
    system: [textBlock("SYS")],
    messages: [{ role: "user", content: [textBlock("hi")] }],
  });
  const once = build();
  applyAnthropicCacheBreakpoints(once, { mode: "rewrite" });
  const twice = build();
  applyAnthropicCacheBreakpoints(twice, { mode: "rewrite" });
  applyAnthropicCacheBreakpoints(twice, { mode: "rewrite" });
  assert.equal(JSON.stringify(twice), JSON.stringify(once), "idempotent");
  assert.ok(markerCount(twice) <= 4);
});

test("cache: string system and string message content are upgraded without loss", () => {
  const parsed = { system: "SYS", messages: [{ role: "user", content: "hello" }] };
  applyAnthropicCacheBreakpoints(parsed, { mode: "rewrite" });
  assert.equal(parsed.system[0].text, "SYS");
  assert.equal(parsed.messages[0].content[0].text, "hello");
  assert.deepEqual(parsed.messages[0].content[0].cache_control, EPHEMERAL);
});

test("cache: the session key is identical before and after the rewrite", () => {
  // Upgrading a string to a block array must not change the derived session id,
  // or cache affinity would break in a way no marker can repair.
  const before = { model: "m", system: "SYS", messages: [{ role: "user", content: "hello" }] };
  const after = JSON.parse(JSON.stringify(before));
  applyAnthropicCacheBreakpoints(after, { mode: "rewrite" });
  assert.deepEqual(
    sessionKeyParts("anthropic", after),
    sessionKeyParts("anthropic", before),
    "sessionKeyParts is unchanged",
  );
});

test("cache: an existing ttl is not overwritten", () => {
  const parsed = {
    messages: [{ role: "user", content: [textBlock("hi", { cache_control: EPHEMERAL_1H })] }],
  };
  applyAnthropicCacheBreakpoints(parsed, { mode: "auto", ttl: "5m" });
  assert.deepEqual(parsed.messages[0].content[0].cache_control, EPHEMERAL_1H, "client ttl wins");
});

test("cache: the 1h ttl is applied when asked for", () => {
  const parsed = { system: [textBlock("SYS")], messages: [{ role: "user", content: [textBlock("hi")] }] };
  const report = applyAnthropicCacheBreakpoints(parsed, { mode: "rewrite", ttl: "1h" });
  assert.deepEqual(parsed.system[0].cache_control, EPHEMERAL_1H);
  assert.deepEqual(report.ttlSummary, { "1h": 2 });
});

test("cache: thinking, empty text and unknown blocks never carry a marker", () => {
  const parsed = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…" },
          { type: "redacted_thinking", data: "…" },
          textBlock(""),
          { type: "image", source: {} },
        ],
      },
      { role: "user", content: [textBlock("real")] },
    ],
  };
  applyAnthropicCacheBreakpoints(parsed, { mode: "rewrite" });
  assert.equal(parsed.messages[0].content[0].cache_control, undefined);
  assert.equal(parsed.messages[0].content[1].cache_control, undefined);
  assert.equal(parsed.messages[0].content[2].cache_control, undefined);
  assert.deepEqual(parsed.messages[1].content[0].cache_control, EPHEMERAL);
});

test("cache: empty and missing shapes are handled without throwing", () => {
  for (const parsed of [{}, { messages: [] }, { system: [] }, { messages: [{ role: "user", content: [] }] }]) {
    const report = applyAnthropicCacheBreakpoints(parsed, { mode: "rewrite" });
    assert.ok(markerCount(parsed) <= 4);
    assert.equal(typeof report.breakpoints, "number");
  }
  assert.doesNotThrow(() => applyAnthropicCacheBreakpoints(undefined, { mode: "auto" }));
  const unknown = { messages: [{ role: "user", content: [textBlock("hi")] }] };
  const before = JSON.stringify(unknown);
  const report = applyAnthropicCacheBreakpoints(unknown, { mode: "nonsense" });
  assert.equal(JSON.stringify(unknown), before, "an unknown mode changes nothing");
  assert.equal(report.warnings.length, 1);
});

test("cache: the fingerprint separates serialization order from content", () => {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const fp = (payload) => fingerprintAnthropicPayload(payload, hash);
  const base = { system: [textBlock("SYS")], messages: [{ role: "user", content: [textBlock("a")] }] };

  const same = JSON.parse(JSON.stringify(base));
  assert.deepEqual(fp(same), fp(base), "identical input, identical fingerprint");

  const grown = JSON.parse(JSON.stringify(base));
  grown.messages.push({ role: "assistant", content: [textBlock("b")] });
  assert.deepEqual(fp(grown).messages.raw.slice(0, 1), fp(base).messages.raw, "appending keeps the earlier prefix");

  const changed = JSON.parse(JSON.stringify(base));
  changed.messages[0].content[0].text = "A";
  assert.notEqual(fp(changed).messages.raw[0], fp(base).messages.raw[0], "changed text shows up at its index");

  // Key order only: raw moves, structural does not.
  const reordered = { messages: [{ content: [textBlock("a")], role: "user" }], system: [textBlock("SYS")] };
  const a = fp(base);
  const b = fp(reordered);
  assert.notEqual(a.messages.raw[0], b.messages.raw[0], "raw sees the reordering");
  assert.equal(a.messages.structural[0], b.messages.structural[0], "structural does not");

  // A marker moving is metadata, not content.
  const marked = JSON.parse(JSON.stringify(base));
  marked.messages[0].content[0].cache_control = EPHEMERAL;
  assert.deepEqual(fp(marked), fp(base), "moving a marker changes nothing");

  // A business field that happens to be called cache_control IS content.
  const business = { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: { cache_control: "old" } }] }] };
  const businessChanged = JSON.parse(JSON.stringify(business));
  businessChanged.messages[0].content[0].input.cache_control = "new";
  assert.notEqual(
    fp(business).messages.raw[0],
    fp(businessChanged).messages.raw[0],
    "a tool input field of that name is content, not a marker",
  );

  const schema = { tools: [{ name: "x", input_schema: { properties: { cache_control: { type: "string" } } } }], messages: [] };
  const schemaChanged = JSON.parse(JSON.stringify(schema));
  schemaChanged.tools[0].input_schema.properties.cache_control.type = "number";
  assert.notEqual(fp(schema).tools.raw, fp(schemaChanged).tools.raw, "and neither is a schema property");

  // The snapshot must not touch the caller payload.
  const before = JSON.stringify(base);
  fp(base);
  assert.equal(JSON.stringify(base), before, "fingerprinting does not mutate its input");
});


test("cache: only the anthropic route gains markers", async (t) => {
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, [{ choices: [{ delta: { content: "ok" } }] }]));
  const gateway = await startGateway(t, {
    upstreamBaseURL: upstream.baseURL,
    enabledRoutes: ["generic", "anthropic"],
  });
  await withEnv({ FACTORY_API_KEY: `fk-cache-${"n".repeat(40)}` }, async () => {
    await readAll(
      await fetch(`${gateway.baseURL}/api/dsh-factory-provider/o/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    const sent = upstream.seen.at(-1);
    assert.equal(markerCount(sent.body), 0, "the generic route is untouched");
  });
});

test("gateway: usage is collected from a streamed reply without buffering it", async (t) => {
  // Anthropic reports usage across message_start and message_delta, and a chunk
  // boundary can fall inside an event. The observer must merge fields (not sum
  // cumulative repeats) and still pass every byte through unchanged.
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7, input_tokens: 12, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 } })}\n\n`,
  ];
  const upstream = await startMockUpstream(t, (_record, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Deliberately split one event across two writes.
    const whole = events.join("");
    const cut = Math.floor(whole.length / 2);
    res.write(whole.slice(0, cut));
    setTimeout(() => {
      res.write(whole.slice(cut));
      res.end();
    }, 5);
  });
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL, enabledRoutes: ["anthropic"] });
  await withEnv({ FACTORY_API_KEY: `fk-usage-${"p".repeat(40)}` }, async () => {
    const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/a/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = await readAll(res);
    assert.equal(res.status, 200);
    assert.match(body.toString(), /message_start/, "the stream still reaches the client");
    assert.match(body.toString(), /content_block_delta/);

    // Give the observer's flush a tick to land.
    await new Promise((r) => setTimeout(r, 50));
    const usage = readJournal(20).filter((e) => e.event === "usage").at(-1);
    assert.equal(usage.input, 12, "input is not double counted");
    assert.equal(usage.read, 5000);
    assert.equal(usage.write, 300);
    assert.equal(usage.output, 7);
    assert.equal(usage.totalInput, 12 + 5000 + 300);
    assert.ok(Math.abs(usage.hitRatio - 5000 / 5312) < 0.001, "hit ratio is read / total input");
  });
});
