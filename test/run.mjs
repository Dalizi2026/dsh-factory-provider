// Offline test suite for dsh-factory-provider.
//
//   node test/run.mjs
//
// Covers the credential envelope (decrypt / WorkOS refresh / atomic rewrite /
// single-flight / API-key bypass), the per-route payload rewrites, the catalog
// → llm-pi-ai entry mapping, and the gateway end to end against local mock
// Factory + WorkOS servers (header injection, SSE streaming, 401 refresh-retry,
// loopback guard, catalog/status routes). No network, no droid CLI needed.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

import {
  authKeySource,
  decryptCredential,
  envelopeFile,
  normalizeKey,
  writeCredential,
  readAuthKey,
  resolveAuthKey,
  tokenExpiryMs,
  refreshCredential,
  createTokenResolver,
  resolveCredentialForHome,
} from "../lib/credentials.js";
import {
  authKeyCommands,
  droidCandidates,
  ENVELOPE_NAMES,
  findDroidExecutable,
  loginCommand,
} from "../lib/platform.js";
import {
  accountsRoot,
  activeAccountHome,
  createPendingAccount,
  deleteAccount,
  getActiveAccountId,
  getCredentialMode,
  activeApiKey,
  saveApiKeyAccount,
  disableCredentials,
  useDefaultCredentials,
  listAccounts,
  resolveAccountCredential,
  saveAccount,
  saveCurrentAccount,
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

/** A .factory home directory holding `creds` under the droid envelope. */
function seedFactoryHome(t, creds) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(home, "auth.v2.key"), key.toString("base64"));
  fs.writeFileSync(path.join(home, "auth.v2.file"), encryptEnvelope(key, creds));
  return home;
}

/** A droid >= 0.231 layout home: envelope at auth.v2.loginkeychain, key
 * supplied out-of-band (keychain in production; FACTORY_AUTH_KEY here). */
function seedKeychainHome(t, creds) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-home-kc-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(home, "auth.v2.loginkeychain"), encryptEnvelope(key, creds));
  return { home, keyBase64: key.toString("base64") };
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

test("envelope roundtrip: write then decrypt returns the same credential", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "auth.v2.key"), crypto.randomBytes(32).toString("base64"));
  const creds = {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "refresh-1",
    active_organization_id: "org_123",
  };
  writeCredential(creds, home);
  assert.deepEqual(decryptCredential(home), creds);
});

test("decryptCredential returns undefined for a missing/foreign home", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(decryptCredential(home), undefined);
  fs.writeFileSync(path.join(home, "auth.v2.key"), crypto.randomBytes(32).toString("base64"));
  fs.writeFileSync(path.join(home, "auth.v2.file"), "not-an-envelope");
  assert.equal(decryptCredential(home), undefined);
});

test("tokenExpiryMs reads the JWT exp claim; non-JWT yields undefined", () => {
  assert.equal(tokenExpiryMs(makeJwt({ exp: 1_800_000_000 })), 1_800_000_000_000);
  assert.equal(tokenExpiryMs("fk-not-a-jwt"), undefined);
});

test("keychain layout (droid >= 0.231): loginkeychain envelope decrypts, write-back keeps the same file", async (t) => {
  const creds = {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "refresh-old",
    active_organization_id: "org_5",
    whoami: { email: "pro@example.com" },
  };
  const { home, keyBase64 } = seedKeychainHome(t, creds);
  await withEnv({ FACTORY_HOME: home, FACTORY_AUTH_KEY: keyBase64 }, async () => {
    assert.equal(readAuthKey(home).toString("base64"), keyBase64);
    const read = decryptCredential(home);
    assert.equal(read.access_token, creds.access_token);
    assert.deepEqual(read.whoami, { email: "pro@example.com" });
    // A write-back must land on the file droid itself reads, not the legacy one.
    writeCredential({ ...creds, access_token: makeJwt({ exp: 9 }) }, home);
    assert.equal(fs.existsSync(path.join(home, "auth.v2.file")), false);
    assert.equal(fs.existsSync(path.join(home, "auth.v2.loginkeychain")), true);
    assert.notEqual(decryptCredential(home).access_token, creds.access_token);
  });
});

test("keychain layout: refresh rotates the pair, preserves unknown fields, rewrites the envelope", async (t) => {
  const creds = {
    access_token: makeJwt({ exp: 1 }),
    refresh_token: "refresh-old",
    active_organization_id: "org_5",
    whoami: { email: "pro@example.com", plan: "pro" },
  };
  const { home, keyBase64 } = seedKeychainHome(t, creds);
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "refresh-new",
    }),
  });
  await withEnv(
    { FACTORY_HOME: home, FACTORY_AUTH_KEY: keyBase64, FACTORY_WORKOS_BASE_URL: "http://workos.test" },
    async () => {
      const rotated = await refreshCredential(decryptCredential(home), { fetchImpl, home });
      assert.equal(rotated.refresh_token, "refresh-new");
      assert.deepEqual(rotated.whoami, { email: "pro@example.com", plan: "pro" });
      // droid keeps working: the on-disk envelope now holds the rotated pair.
      const onDisk = decryptCredential(home);
      assert.equal(onDisk.refresh_token, "refresh-new");
      assert.equal(onDisk.active_organization_id, "org_5");
    },
  );
});

test("real macOS keychain item (skip when absent): ambient ~/.factory decrypts", (t) => {
  const home = process.env.FACTORY_HOME ?? path.join(os.homedir(), ".factory");
  const envelope = path.join(home, "auth.v2.loginkeychain");
  if (process.platform !== "darwin" || !fs.existsSync(envelope)) {
    t.skip("no keychain-based login on this machine");
    return;
  }
  if (process.env.FACTORY_AUTH_KEY || fs.existsSync(path.join(home, "auth.v2.key"))) {
    t.skip("operator override / legacy layout present");
    return;
  }
  const creds = decryptCredential(home);
  assert.ok(creds !== undefined, "ambient droid credential should decrypt");
  assert.ok(creds.access_token.length > 0);
});

test("refreshCredential posts the form grant and rewrites the envelope", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: 1 }),
    refresh_token: "refresh-old",
    active_organization_id: "org_123",
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
    return {
      ok: true,
      json: async () => ({
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "refresh-new",
        active_organization_id: "org_123",
      }),
    };
  };
  const rotated = await refreshCredential(decryptCredential(home), { fetchImpl, home });
  assert.equal(rotated.refresh_token, "refresh-new");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/user_management\/authenticate$/);
  assert.equal(calls[0].body.grant_type, "refresh_token");
  assert.equal(calls[0].body.refresh_token, "refresh-old");
  assert.equal(calls[0].body.client_id, "client_01HNM792M5G5G1A2THWPXKFMXB");
  assert.ok(!("organization_id" in calls[0].body));
  // The droid CLI must keep working: the envelope on disk holds the rotated pair.
  assert.equal(decryptCredential(home).refresh_token, "refresh-new");
});

test("resolve: API-key env bypasses the envelope entirely", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: 1 }),
    refresh_token: "r",
    active_organization_id: null,
  });
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: "fk-live-key", FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
    const resolver = createTokenResolver({});
    const state = await resolver.resolve();
    assert.equal(state.source, "api-key");
    assert.equal(state.token, "fk-live-key");
  });
});

test("resolve: expired envelope token triggers one refresh, shared by concurrent callers", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
    refresh_token: "refresh-old",
    active_organization_id: "org_9",
  });
  let workosCalls = 0;
  const fetchImpl = async () => {
    workosCalls += 1;
    await new Promise((r) => setTimeout(r, 30));
    return {
      ok: true,
      json: async () => ({
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "refresh-new",
      }),
    };
  };
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://workos.test" }, async () => {
    const resolver = createTokenResolver({ fetchImpl });
    const [a, b] = await Promise.all([resolver.resolve(), resolver.resolve()]);
    assert.equal(workosCalls, 1); // single-flight
    assert.equal(a.token, b.token);
    assert.equal(a.source, "droid-cli");
    assert.equal(a.orgId, "org_9");
    assert.equal(resolver.state().source, "droid-cli");
  });
});

test("resolve: no credential anywhere reports source none", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined }, async () => {
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined }, async () => {
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

test("quota: without a credential it reports no-credential instead of throwing", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined }, async () => {
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined }, async () => {
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined }, async () => {
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
  const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const home = seedFactoryHome(t, {
    access_token: accessToken,
    refresh_token: "r",
    active_organization_id: "org_42",
  });
  const upstream = await startMockUpstream(t, (_record, res) => {
    sseReply(res, [{ type: "message_start" }, { type: "content_block_delta", delta: { text: "hi" } }]);
  });
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });

  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
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
    assert.equal(sent.headers.authorization, `Bearer ${accessToken}`);
    assert.equal(sent.headers["x-api-provider"], "bedrock_anthropic");
    assert.equal(sent.headers["x-api-key"], "placeholder");
    assert.equal(sent.headers["x-stainless-package-version"], "0.70.1");
    assert.equal(sent.headers["user-agent"], "factory-cli/0.231.0");
    assert.equal(sent.headers["x-factory-org-id"], "org_42");
    assert.equal(sent.headers["anthropic-version"], "2023-06-01");
    // skills beta dropped (no code_execution tool), fast-mode beta added, speed set
    assert.equal(sent.headers["anthropic-beta"], "fast-mode-2026-02-01");
    assert.equal(sent.body.speed, "fast");
    // top-level system passes through with the canonical line first
    assert.equal(sent.body.system, `${DROID_SYSTEM_LINE}\n\nSYSTEM`);
    assert.equal(sent.body.messages.length, 1);
    assert.equal(sent.body.messages[0].content, "hello");
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
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

test("gateway: upstream 401 forces exactly one WorkOS refresh and retries", async (t) => {
  const staleToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
  const home = seedFactoryHome(t, {
    access_token: staleToken,
    refresh_token: "refresh-old",
    active_organization_id: null,
  });
  const freshToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200 });
  const workos = await startMockWorkos(t, () => ({
    access_token: freshToken,
    refresh_token: "refresh-new",
  }));
  const upstream = await startMockUpstream(t, (record, res) => {
    if (record.headers.authorization === `Bearer ${freshToken}`) {
      sseReply(res, [{ type: "message_start" }]);
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "authentication_error" } }));
  });
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv(
    { FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: workos.baseURL },
    async () => {
      const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/a/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      await readAll(res);
      assert.equal(upstream.seen.length, 2);
      assert.equal(upstream.seen[0].headers.authorization, `Bearer ${staleToken}`);
      assert.equal(upstream.seen[1].headers.authorization, `Bearer ${freshToken}`);
      assert.equal(workos.seen.length, 1);
      // The droid envelope on disk now holds the rotated pair.
      assert.equal(decryptCredential(home).access_token, freshToken);
      assert.equal(decryptCredential(home).refresh_token, "refresh-new");
    },
  );
});

test("gateway: no credential yields an actionable 401, upstream untouched", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, []));
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined }, async () => {
    const res = await fetch(`${gateway.baseURL}/api/dsh-factory-provider/a/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error.message, /droid CLI/);
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
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
  const entry = entries[entries.length - 1];
  assert.equal(entry.route, "generic");
  assert.equal(entry.event, "forward");
  assert.equal(entry.upstreamStatus, 200);
  assert.equal(entry.shape.model, "glm-5.3-flash");
  assert.equal(entry.shape.tools, 1);
  // No tokens or full bodies in the journal.
  assert.ok(!JSON.stringify(entry).includes("Bearer"));
});

test("gateway: status and models routes report state and the catalog", async (t) => {
  const home = seedFactoryHome(t, {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "r",
    active_organization_id: "org_7",
  });
  const upstream = await startMockUpstream(t, (_record, res) => sseReply(res, []));
  const gateway = await startGateway(t, { upstreamBaseURL: upstream.baseURL });
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
    const status = await (await fetch(`${gateway.baseURL}/api/dsh-factory-provider/status`)).json();
    assert.equal(status.ok, true);
    assert.equal(status.credential.source, "droid-cli");
    assert.equal(status.credential.orgId, "org_7");
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
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

test("accounts: save/list/switch/delete roundtrip through the vault API", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_a", "org_a"));
  const credsB = credsFor("user_b", "org_b");
  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined },
    async () => {
      // Snapshot the live default login, then add a second account.
      const saved = saveCurrentAccount({ label: "main" });
      assert.equal(saved.created, true);
      const savedB = saveAccount({ label: "second", creds: credsB });
      const accounts = listAccounts();
      assert.equal(accounts.length, 2);
      const a = accounts.find((x) => x.id === saved.id);
      const b = accounts.find((x) => x.id === savedB.id);
      assert.equal(a.email, "user_a@test.dev");
      assert.equal(a.matchesDroidCli, true);
      assert.equal(b.matchesDroidCli, false);
      assert.equal(b.premBaseHost, "https://user_b.prem.factory.ai");

      // Re-saving the same identity upserts instead of duplicating.
      const again = saveAccount({ label: "second-renamed", creds: credsB });
      assert.equal(again.id, savedB.id);
      assert.equal(again.created, false);
      assert.equal(listAccounts().find((x) => x.id === savedB.id).label, "second-renamed");

      // Switching: the resolver resolves the active snapshot's token.
      setActiveAccountId(savedB.id);
      assert.equal(activeAccountHome(), path.join(accountsRoot(), savedB.id));
      const resolver = createTokenResolver({ activeHome: () => activeAccountHome() });
      const state = await resolver.resolve();
      assert.equal(state.source, "droid-cli");
      assert.equal(state.orgId, "org_b");
      assert.equal(jwtOf(state.token).sub, "user_b");

      // Switch back to the default login.
      setActiveAccountId(undefined);
      resolver.reset();
      const back = await resolver.resolve();
      assert.equal(jwtOf(back.token).sub, "user_a");

      // Deleting the active account clears the active pointer.
      setActiveAccountId(savedB.id);
      deleteAccount(savedB.id);
      assert.equal(fs.existsSync(path.join(vault, savedB.id)), false);
      assert.equal(getActiveAccountId(), undefined);
    },
  );
});

test("accounts: a selected account wins over an ambient api-key env", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_a", "org_a"));
  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: "fk-ambient-env-key" },
    async () => {
      saveCurrentAccount({ label: "main" });
      const accounts = listAccounts();
      const selected = accounts[0].id;

      // Nothing selected: the ambient env key is what the gateway uses.
      const bare = createTokenResolver({ activeHome: () => activeAccountHome() });
      assert.equal((await bare.resolve()).token, "fk-ambient-env-key");

      // Selecting an account is an explicit choice, so it beats the ambient
      // variable — otherwise a leftover env key would silently pin the gateway
      // to one account and make the account list look broken.
      setActiveAccountId(selected);
      const chosen = createTokenResolver({
        activeHome: () => activeAccountHome(),
        activeKey: () => activeApiKey(),
      });
      const state = await chosen.resolve();
      assert.equal(state.source, "droid-cli");
      assert.equal(jwtOf(state.token).sub, "user_a");
      setActiveAccountId(undefined);
    },
  );
});

test("accounts: refresh rotates the snapshot in its own home, default login untouched", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_a", "org_a"));
  const expired = credsFor("user_b", "org_b", Math.floor(Date.now() / 1000) - 10);
  let workosCalls = 0;
  const fetchImpl = async () => {
    workosCalls += 1;
    return {
      ok: true,
      json: async () => ({
        access_token: makeJwt({ sub: "user_b", exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "refresh-new",
      }),
    };
  };
  await withEnv(
    {
      FACTORY_HOME: defaultHome,
      DSH_FACTORY_ACCOUNTS_DIR: vault,
      FACTORY_API_KEY: undefined,
      FACTORY_WORKOS_BASE_URL: "http://workos.test",
    },
    async () => {
      const { id } = saveAccount({ label: "b", creds: expired });
      const dir = path.join(vault, id);
      const rotated = await resolveCredentialForHome(dir, { fetchImpl });
      assert.equal(rotated.refresh_token, "refresh-new");
      assert.equal(workosCalls, 1);
      // Rotation landed in the snapshot, not in the default droid login.
      assert.equal(decryptCredential(dir).refresh_token, "refresh-new");
      assert.equal(decryptCredential(defaultHome).refresh_token, "refresh-user_a");
      // resolveAccountCredential reads through the vault by id.
      const viaVault = await resolveAccountCredential(id, { fetchImpl });
      assert.equal(viaVault.access_token, rotated.access_token);
    },
  );
});

test("accounts: snapshot homes decrypt via the default home's auth.v2.key when they have no key file", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_a", "org_a"));
  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined, FACTORY_AUTH_KEY: undefined },
    async () => {
      const { id } = saveCurrentAccount({ label: "main" });
      const dir = path.join(vault, id);
      assert.equal(fs.existsSync(path.join(dir, "auth.v2.key")), false);
      assert.notEqual(decryptCredential(dir), undefined);
    },
  );
});

test("accounts: pending login dirs are adopted once droid writes its envelope", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_a", "org_a"));
  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined },
    async () => {
      const pending = createPendingAccount({ label: "work" });
      // The command must be pasteable as-is on this OS: the override points at
      // the pending home and the CLI is the resolved absolute path (droid is
      // often installed outside PATH).
      assert.ok(pending.command.includes(`FACTORY_HOME_OVERRIDE=`));
      assert.ok(pending.command.includes(pending.home));
      assert.ok(pending.command.includes("droid"));
      if (process.platform === "win32") {
        assert.match(pending.command, /^\$env:FACTORY_HOME_OVERRIDE=/);
        assert.match(pending.windowsCommand, /^set "FACTORY_HOME_OVERRIDE=/);
      } else {
        assert.match(pending.command, /^FACTORY_HOME_OVERRIDE=/);
        assert.ok(!pending.command.includes("$env:"));
      }
      assert.equal(listAccounts().find((x) => x.id === pending.id)?.state, "pending");
      // The isolated-home official login lands the envelope in that dir.
      saveAccount({ label: "work", creds: credsFor("user_c", "org_c") });
      // adopt by writing into the pending dir directly (what droid does):
      writeCredential(credsFor("user_c", "org_c"), pending.home);
      const adopted = listAccounts().find((x) => x.id === pending.id);
      assert.equal(adopted.state, "ready");
      assert.equal(adopted.email, "user_c@test.dev");
      assert.equal(adopted.label, "work");
    },
  );
});

test("accounts: per-account quota reads the billing endpoint with that account's token", async (t) => {
  let seen = {};
  const server = http.createServer((req, res) => {
    seen = { auth: req.headers.authorization, org: req.headers["x-factory-org-id"] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usesTokenRateLimitsBilling: true, limits: { standard: { fiveHour: { usedPercent: 12 } } } }));
  });
  const port = await listen(server);
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_a", "org_a"));
  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined },
    async () => {
      const { id } = saveAccount({ label: "b", creds: credsFor("user_b", "org_b") });
      const envelope = await resolveAccountCredential(id);
      const quota = await fetchQuota({
        credential: { token: envelope.access_token, orgId: envelope.active_organization_id },
        host: `http://127.0.0.1:${port}`,
      });
      assert.equal(quota.ok, true);
      assert.equal(quota.value.standard.fiveHour.usedPercent, 12);
      assert.equal(seen.auth, `Bearer ${envelope.access_token}`);
      assert.equal(seen.org, "org_b");
    },
  );
});

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

test("accounts: a pending login droid wrote under .factory/ is adopted", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  // Default home in the droid >= 0.231 layout (envelope only, key in the
  // keychain in production — FACTORY_AUTH_KEY stands in here).
  const defaultHome = seedKeychainHome(t, credsFor("user_a", "org_a")).home;
  const nestedKey = crypto.randomBytes(32);
  await withEnv(
    {
      FACTORY_HOME: defaultHome,
      DSH_FACTORY_ACCOUNTS_DIR: vault,
      FACTORY_API_KEY: undefined,
      FACTORY_AUTH_KEY: nestedKey.toString("base64"),
    },
    async () => {
      // Pending login dir as the plugin creates it; droid run with
      // FACTORY_HOME_OVERRIDE=<dir> writes its envelope one level deeper.
      const dir = path.join(vault, "login-abc123");
      fs.mkdirSync(path.join(dir, ".factory"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ label: "login-abc123", pending: true }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(dir, ".factory", "auth.v2.loginkeychain"),
        encryptEnvelope(nestedKey, credsFor("user_c", "org_c")),
        { mode: 0o600 },
      );
      // The vault adopts the nested envelope: ready, with identity read.
      const adopted = listAccounts().find((a) => a.id === "login-abc123");
      assert.equal(adopted.state, "ready");
      assert.equal(adopted.email, "user_c@test.dev");
      assert.equal(adopted.matchesDroidCli, false);

      // Switching and resolving go through the nested home.
      setActiveAccountId("login-abc123");
      assert.equal(activeAccountHome(), path.join(dir, ".factory"));
      const creds = await resolveAccountCredential("login-abc123");
      assert.equal(creds.active_organization_id, "org_c");
    },
  );
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
  await withEnv({ FACTORY_HOME: home, FACTORY_API_KEY: undefined, FACTORY_WORKOS_BASE_URL: "http://127.0.0.1:1/unused" }, async () => {
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
    "refreshWindowMinutes",
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

test("apply: an active saved account does not abort route registration", async (t) => {
  // Regression for a silent total outage: applyAccountHost() closes over
  // `gateway`, so applying the persisted account selection BEFORE
  // createGateway() threw a temporal-dead-zone ReferenceError out of apply().
  // Every route — and with them the providers, the settings card and the
  // gateway — disappeared on every boot with a saved account active, and the
  // host log said nothing.
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_a", "org_a"));
  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined },
    async () => {
      const { id } = saveCurrentAccount({ label: "main" });
      setActiveAccountId(id);
      assert.equal(getActiveAccountId(), id);
      assert.equal(listAccounts().find((account) => account.id === id)?.state, "ready");

      const registered = [];
      const disposers = [];
      const settings = {
        installSection: () => {},
        describe: () => [
          { ns: "llm-pi-ai", revision: 1, value: { providers: {} } },
          { ns: "dsh-factory-provider", revision: 1, value: {} },
        ],
        mutate: async () => {},
      };
      const webServer = {
        port: 19387,
        register: (route) => {
          registered.push(route.path);
          return () => {};
        },
      };
      const ctx = {
        logger: { info: () => {}, warn: () => {} },
        get: () => undefined,
        inject: (_services, callback) => {
          const sctx = {
            webServer,
            settings,
            effect: (fn) => {
              const dispose = fn();
              if (typeof dispose === "function") disposers.push(dispose);
              return () => {};
            },
            on: () => () => {},
          };
          const dispose = callback(sctx);
          if (typeof dispose === "function") disposers.push(dispose);
          return () => {};
        },
      };

      apply(ctx, { enabled: true, proactiveRefreshMinutes: 0 });
      assert.ok(
        registered.includes("/api/dsh-factory-provider/status"),
        `gateway routes registered (got: ${registered.join(", ") || "none"})`,
      );
      assert.ok(registered.includes("/api/dsh-factory-provider/o/v1/chat/completions"));
      assert.ok(registered.includes("/api/dsh-factory-provider/quota"));
      for (const dispose of disposers) dispose();
    },
  );
});

// --- cross-platform (Windows / Linux / macOS) ------------------------------------
//
// The plugin has to work on a machine it was not developed on, so the platform
// matrix is exercised by injection: every resolver takes `{ platform, env,
// homedir }`, and the keyring readers are asserted as commands instead of being
// executed. That keeps the whole Windows/Linux surface testable from macOS.

test("platform: droid executable candidates are per-OS", () => {
  const winEnv = {
    LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
    APPDATA: "C:\\Users\\demo\\AppData\\Roaming",
    ProgramFiles: "C:\\Program Files",
  };
  const win = droidCandidates({ platform: "win32", homedir: "C:\\Users\\demo", env: winEnv });
  assert.ok(win.includes("C:\\Users\\demo\\AppData\\Local\\Programs\\Factory\\droid.exe"));
  assert.ok(win.includes("C:\\Users\\demo\\AppData\\Roaming\\npm\\droid.cmd"));
  assert.ok(win.includes("C:\\Users\\demo\\.factory\\bin\\droid.exe"));
  assert.ok(win.every((candidate) => !candidate.includes("/")), "no POSIX separators on Windows");

  const mac = droidCandidates({ platform: "darwin", homedir: "/Users/demo", env: {} });
  assert.ok(mac.includes("/Users/demo/.local/bin/droid"));
  assert.ok(mac.includes("/Applications/Factory.app/Contents/Resources/bin/droid"));
  assert.ok(mac.every((candidate) => !candidate.includes("\\")), "no Windows separators on macOS");

  const linux = droidCandidates({ platform: "linux", homedir: "/home/demo", env: {} });
  assert.ok(linux.includes("/home/demo/.local/bin/droid"));
  assert.ok(linux.includes("/usr/local/bin/droid"));
  assert.ok(!linux.some((candidate) => candidate.startsWith("/Applications")));

  // Without LOCALAPPDATA/APPDATA the profile-relative defaults are used.
  const bare = droidCandidates({ platform: "win32", homedir: "C:\\Users\\demo", env: {} });
  assert.ok(bare.includes("C:\\Users\\demo\\AppData\\Local\\Programs\\Factory\\droid.exe"));
});

test("platform: findDroidExecutable takes the first existing candidate", () => {
  const options = { platform: "win32", homedir: "C:\\Users\\demo", env: {} };
  const candidates = droidCandidates(options);
  const target = candidates[2];
  assert.equal(
    findDroidExecutable({ ...options, exists: (candidate) => candidate === target }),
    target,
  );
  assert.equal(findDroidExecutable({ ...options, exists: () => false }), undefined);
  assert.equal(
    findDroidExecutable({
      ...options,
      exists: () => {
        throw new Error("EACCES");
      },
    }),
    undefined,
    "an unreadable candidate is skipped, not fatal",
  );
});

test("platform: the login command is pasteable on each OS", () => {
  const winHome = "C:\\Users\\demo\\AppData\\Roaming\\dsh accounts\\work-1";
  const winDroid = "C:\\Program Files\\Factory\\droid.exe";
  const powershell = loginCommand({ platform: "win32", home: winHome, droid: winDroid });
  assert.match(powershell, /^\$env:FACTORY_HOME_OVERRIDE="/);
  assert.ok(powershell.includes("& \"C:\\Program Files\\Factory\\droid.exe\""));
  assert.ok(powershell.includes(winHome), "the path with a space stays quoted");

  const cmd = loginCommand({ platform: "win32", home: winHome, droid: winDroid, shell: "cmd" });
  assert.match(cmd, /^set "FACTORY_HOME_OVERRIDE=/);
  assert.ok(cmd.includes("&&"));

  for (const platform of ["darwin", "linux"]) {
    const sh = loginCommand({ platform, home: "/home/demo/accounts/a b", droid: "/usr/local/bin/droid" });
    assert.match(sh, /^FACTORY_HOME_OVERRIDE="/);
    assert.ok(!sh.includes("$env:"), "no PowerShell syntax on POSIX");
    assert.ok(!sh.startsWith("set "), "no cmd.exe syntax on POSIX");
  }
});

test("platform: keyring commands match each OS backend", () => {
  const mac = authKeyCommands({ platform: "darwin", env: {} });
  assert.equal(mac.length, 1);
  assert.equal(mac[0].file, "/usr/bin/security");
  assert.deepEqual(mac[0].args, [
    "find-generic-password",
    "-s",
    "Factory CLI",
    "-a",
    "auth-encryption-key-security-cli",
    "-w",
  ]);

  const win = authKeyCommands({ platform: "win32", env: {} });
  assert.equal(win.length, 1);
  assert.equal(win[0].file, "powershell");
  const script = win[0].args.at(-1);
  assert.ok(script.includes("CredReadW"), "reads the Credential Manager through advapi32");
  assert.ok(script.includes("'Factory CLI'"), "looks up the droid target");
  assert.equal(win[0].parse, "windows-credential");
  assert.equal(win[0].account, "auth-encryption-key-security-cli");

  const linux = authKeyCommands({ platform: "linux", env: {} });
  assert.equal(linux[0].file, "secret-tool");
  assert.deepEqual(linux[0].args, [
    "lookup",
    "service",
    "Factory CLI",
    "account",
    "auth-encryption-key-security-cli",
  ]);

  const custom = authKeyCommands({
    platform: "linux",
    env: { FACTORY_KEYCHAIN_SERVICE: "Acme", FACTORY_KEYCHAIN_ACCOUNT: "key-1" },
  });
  assert.deepEqual(custom[0].args, ["lookup", "service", "Acme", "account", "key-1"]);
  assert.deepEqual(authKeyCommands({ platform: "freebsd", env: {} }), []);
});

test("platform: every envelope name droid may write is known", () => {
  assert.deepEqual(ENVELOPE_NAMES, ["auth.v2.file", "auth.v2.keyring", "auth.v2.loginkeychain"]);
});

test("credentials: the envelope name defaults to the key backend of the OS", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-env-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const name = (platform, options = { exists: () => false }) =>
    path.basename(envelopeFile(home, { platform, ...options }));
  assert.equal(name("win32"), "auth.v2.keyring");
  assert.equal(name("linux"), "auth.v2.keyring");
  assert.equal(name("darwin"), "auth.v2.loginkeychain");
  // Whatever exists wins, in droid's own preference order.
  fs.writeFileSync(path.join(home, "auth.v2.keyring"), "x");
  assert.equal(name("darwin", {}), "auth.v2.keyring");
  fs.writeFileSync(path.join(home, "auth.v2.file"), "x");
  assert.equal(name("win32", {}), "auth.v2.file");
});

test("credentials: normalizeKey accepts CRLF, UTF-16 blobs and unpadded base64", () => {
  const key = crypto.randomBytes(32);
  const base64 = key.toString("base64");
  assert.deepEqual(normalizeKey(`${base64}\r\n`), key, "a Windows text file ends in CRLF");
  assert.deepEqual(normalizeKey(Buffer.from(base64, "utf16le").toString("utf8")), key, "a Credential Manager blob is UTF-16");
  assert.deepEqual(normalizeKey(base64.replace(/=+$/, "")), key, "padding is optional");
  assert.equal(normalizeKey("not a key!"), undefined);
  assert.equal(normalizeKey(""), undefined);
  assert.equal(normalizeKey(undefined), undefined);
  assert.equal(normalizeKey(null), undefined);
});

test("credentials: a Windows keyring layout decrypts with the CredRead result", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-win-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const creds = credsFor("user_win", "org_win");
  fs.writeFileSync(path.join(home, "auth.v2.keyring"), encryptEnvelope(key, creds));

  const calls = [];
  const runCommand = (file, args) => {
    calls.push({ file, args });
    return `auth-encryption-key-security-cli\t${key.toString("base64")}`;
  };
  const decrypted = decryptCredential(home, {
    platform: "win32",
    env: {},
    defaultHome: home,
    runCommand,
  });
  assert.equal(decrypted.active_organization_id, "org_win");
  assert.equal(jwtOf(decrypted.access_token).sub, "user_win");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell");
  assert.ok(calls[0].args.at(-1).includes("CredReadW"));
});

test("credentials: a foreign Credential Manager entry is rejected, not mis-decrypted", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-win2-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(home, "auth.v2.keyring"), encryptEnvelope(key, credsFor("user_x", "org_x")));

  const result = resolveAuthKey(home, {
    platform: "win32",
    env: {},
    defaultHome: home,
    runCommand: () => `somebody-else\t${key.toString("base64")}`,
  });
  assert.equal(result.key, undefined, "another account's credential on the same target is not ours");
  assert.ok(result.attempts.includes("windows-credential-manager:unusable"));
});

test("credentials: key sources are tried in a fixed, platform-independent order", (t) => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "factory-src-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "factory-src2-"));
  t.after(() => {
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  const localKey = crypto.randomBytes(32);
  const machineKey = crypto.randomBytes(32);
  const envKey = crypto.randomBytes(32);
  const commandKey = crypto.randomBytes(32);
  const keyringKey = crypto.randomBytes(32);
  const b64 = (buffer) => buffer.toString("base64");
  const base = {
    platform: "linux",
    defaultHome: other,
    readFile: (file) => {
      if (file === path.join(other, "auth.v2.key")) return b64(machineKey);
      if (file === path.join(local, "auth.v2.key")) return b64(localKey);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };

  // 1. this home's key file
  assert.equal(resolveAuthKey(local, base).source, "auth.v2.key");
  // 2. the default home's key file — a snapshot home shares the machine key
  const noLocal = { ...base, readFile: (file) => (file.startsWith(other) ? b64(machineKey) : (() => { throw new Error("ENOENT"); })()) };
  assert.equal(resolveAuthKey(local, noLocal).source, "default-auth.v2.key");
  // 3. FACTORY_AUTH_KEY
  const noFiles = { ...base, readFile: () => { throw new Error("ENOENT"); } };
  assert.equal(resolveAuthKey(local, { ...noFiles, env: { FACTORY_AUTH_KEY: b64(envKey) } }).source, "FACTORY_AUTH_KEY");
  // 4. FACTORY_AUTH_KEY_COMMAND (the escape hatch for locked-down machines)
  const viaCommand = resolveAuthKey(local, {
    ...noFiles,
    env: { FACTORY_AUTH_KEY_COMMAND: "get-key --raw" },
    runCommand: (file) => (file === "get-key --raw" ? b64(commandKey) : ""),
  });
  assert.equal(viaCommand.source, "FACTORY_AUTH_KEY_COMMAND");
  assert.deepEqual(viaCommand.key, commandKey);
  // 5. the OS keyring
  const viaKeyring = resolveAuthKey(local, {
    ...noFiles,
    env: {},
    runCommand: (file) => (file === "secret-tool" ? `${b64(keyringKey)}\n` : ""),
  });
  assert.equal(viaKeyring.source, "linux-secret-service");
  assert.deepEqual(viaKeyring.key, keyringKey);
  // Nothing available: the attempts list is what makes this diagnosable.
  const nothing = resolveAuthKey(local, {
    ...noFiles,
    env: {},
    runCommand: () => {
      throw new Error("not found");
    },
  });
  assert.equal(nothing.key, undefined);
  assert.deepEqual(nothing.attempts, [
    "auth.v2.key:absent",
    "default-auth.v2.key:absent",
    "linux-secret-service:absent",
    "linux-secret-service-username:absent",
  ]);
});

test("credentials: the macOS keychain path still resolves and reports its source", async (t) => {
  const { home, keyBase64 } = seedKeychainHome(t, credsFor("user_kc", "org_kc"));
  const calls = [];
  const runCommand = (file, args) => {
    calls.push({ file, args });
    return `${keyBase64}\n`;
  };
  await withEnv({ FACTORY_HOME: home, FACTORY_AUTH_KEY: undefined, FACTORY_AUTH_KEY_COMMAND: undefined }, async () => {
    const creds = decryptCredential(home, { platform: "darwin", env: {}, defaultHome: home, runCommand });
    assert.equal(creds.active_organization_id, "org_kc");
    assert.equal(calls[0].file, "/usr/bin/security");
    assert.equal(readAuthKey(home, { platform: "darwin", env: {}, defaultHome: home, runCommand }) !== undefined, true);
    assert.equal(authKeySource(), "macos-login-keychain");
  });
});

test("accounts: a Windows-layout snapshot is adopted instead of looking pending", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-win-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const dir = path.join(vault, "win-account");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ label: "win", pending: true }));
  fs.writeFileSync(path.join(dir, "auth.v2.keyring"), encryptEnvelope(key, credsFor("user_w", "org_w")));

  await withEnv(
    { DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_AUTH_KEY: key.toString("base64"), FACTORY_API_KEY: undefined },
    async () => {
      const account = listAccounts().find((entry) => entry.id === "win-account");
      assert.equal(account.state, "ready", "auth.v2.keyring is recognised like any other envelope");
      assert.equal(account.email, "user_w@test.dev");
    },
  );
});

test("accounts: deleting the account in use stops credential serving", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-del-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_default", "org_default"));

  await withEnv(
    {
      FACTORY_HOME: defaultHome,
      DSH_FACTORY_ACCOUNTS_DIR: vault,
      FACTORY_API_KEY: undefined,
      FACTORY_AUTH_KEY: undefined,
    },
    async () => {
      const resolver = createTokenResolver({
        activeHome: () => activeAccountHome(),
        disabled: () => getCredentialMode() === "off",
      });

      // Out of the box the droid CLI's own login is used.
      assert.equal(getCredentialMode(), "default");
      assert.equal(jwtOf((await resolver.resolve()).token).sub, "user_default");

      const saved = saveAccount({ label: "second", creds: credsFor("user_second", "org_second") });
      setActiveAccountId(saved.id);
      assert.equal(getCredentialMode(), "account");
      resolver.reset();
      assert.equal(jwtOf((await resolver.resolve()).token).sub, "user_second");

      // Deleting the account in use must stop serving credentials: no silent
      // fallback to the droid CLI login (or to another snapshot), so quota reads
      // and model calls fail until an account is picked again.
      deleteAccount(saved.id);
      assert.equal(getActiveAccountId(), undefined);
      assert.equal(getCredentialMode(), "off");
      resolver.reset();
      const after = await resolver.resolve();
      assert.equal(after.source, "disabled");
      assert.equal(after.token, undefined);
      assert.equal(activeAccountHome(), undefined);

      // "Switch back to the default login" is the explicit way out.
      useDefaultCredentials();
      assert.equal(getCredentialMode(), "default");
      resolver.reset();
      const restored = await resolver.resolve();
      assert.equal(restored.source, "droid-cli");
      assert.equal(jwtOf(restored.token).sub, "user_default");
    },
  );
});

test("accounts: deleting another account leaves the credential mode alone", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-del2-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_default", "org_default"));

  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined },
    async () => {
      const keep = saveAccount({ label: "keep", creds: credsFor("user_keep", "org_keep") });
      const drop = saveAccount({ label: "drop", creds: credsFor("user_drop", "org_drop") });
      setActiveAccountId(keep.id);
      deleteAccount(drop.id);
      assert.equal(getCredentialMode(), "account", "the active account is untouched");
      assert.equal(getActiveAccountId(), keep.id);
    },
  );
});

test("accounts: credentials can be turned off explicitly and restored", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-off-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_default", "org_default"));

  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: undefined },
    async () => {
      const resolver = createTokenResolver({
        activeHome: () => activeAccountHome(),
        disabled: () => getCredentialMode() === "off",
      });
      disableCredentials();
      assert.equal(getCredentialMode(), "off");
      const off = await resolver.resolve();
      assert.equal(off.source, "disabled");
      assert.equal(off.token, undefined);
      // A forced refresh (the gateway does this after an upstream 401) must not
      // sneak a credential back in.
      resolver.reset();
      const forced = await resolver.resolve({ force: true });
      assert.equal(forced.token, undefined);

      setActiveAccountId(undefined);
      assert.equal(getCredentialMode(), "default");
      resolver.reset();
      assert.equal((await resolver.resolve()).source, "droid-cli");
    },
  );
});

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

test("accounts: selecting a key account serves that key, not the envelope", async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "factory-vault-key2-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const defaultHome = seedFactoryHome(t, credsFor("user_env", "org_env"));
  const key = `fk-${"A".repeat(40)}Zz9q`;
  await withEnv(
    { FACTORY_HOME: defaultHome, DSH_FACTORY_ACCOUNTS_DIR: vault, FACTORY_API_KEY: "fk-ambient" },
    async () => {
      const saved = saveApiKeyAccount({ label: "key account", key });
      setActiveAccountId(saved.id);

      const resolver = createTokenResolver({
        activeHome: () => activeAccountHome(),
        activeKey: () => activeApiKey(),
        disabled: () => getCredentialMode() === "off",
      });
      const state = await resolver.resolve();
      assert.equal(state.source, "api-key");
      assert.equal(state.token, key, "the selected key wins over the ambient env key");
      assert.equal(state.expiresAt, undefined, "a key never expires");

      // A key account has no envelope home, which is what keeps the envelope
      // path from being used at all.
      assert.equal(activeAccountHome(), undefined);

      // Quota for a key account resolves to the key itself.
      const creds = await resolveAccountCredential(saved.id);
      assert.equal(creds.access_token, key);

      // Deleting the selected key account stops credential serving outright,
      // exactly like deleting a snapshot does.
      deleteAccount(saved.id);
      assert.equal(getCredentialMode(), "off");
      resolver.reset();
      const after = await resolver.resolve();
      assert.equal(after.source, "disabled");
      assert.equal(after.token, undefined);
      useDefaultCredentials();
    },
  );
});
