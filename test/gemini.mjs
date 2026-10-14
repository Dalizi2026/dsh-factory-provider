// Gemini route (Factory /api/llm/g/v1/generate): payload rewrite, provider
// entry, session keys and the gateway's path/stream/error handling. Offline:
// every upstream reply is a fixture.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../lib/gateway.js";
import { normalizeGeminiPayload, geminiLevelForBudget, DROID_SYSTEM_LINE } from "../lib/sanitize.js";
import { buildProviderEntry, GEMINI_GATEWAY_KEY_REF, GEMINI_THINKING_BUDGETS, ROUTES } from "../lib/catalog.js";
import { sessionKeyParts } from "../lib/session.js";

process.env.DSH_FACTORY_JOURNAL = path.join(os.tmpdir(), `factory-gemini-test-${process.pid}.jsonl`);

test("gemini payload: model from path, allow-list, identity line, budget → level", () => {
  const p = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction: { parts: [{ text: "DSH system" }] },
    generationConfig: { maxOutputTokens: 100, thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } },
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    abortSignal: {},
    httpOptions: {},
  };
  normalizeGeminiPayload(p, "gemini-4-argon");
  assert.equal(p.model, "gemini-4-argon");
  assert.equal(p.abortSignal, undefined);
  assert.equal(p.httpOptions, undefined);
  assert.deepEqual(p.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  assert.equal(p.systemInstruction.parts[0].text, `${DROID_SYSTEM_LINE}\n\nDSH system`);
  assert.deepEqual(p.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: "MEDIUM" });
});

test("gemini payload: missing/string system and dynamic budget", () => {
  const a = { contents: [], generationConfig: { thinkingConfig: { thinkingBudget: -1 } } };
  normalizeGeminiPayload(a, "gemini-4-argon");
  assert.deepEqual(a.systemInstruction, { parts: [{ text: DROID_SYSTEM_LINE }] });
  assert.deepEqual(a.generationConfig.thinkingConfig, {});
  const b = { contents: [], systemInstruction: `${DROID_SYSTEM_LINE} already` };
  normalizeGeminiPayload(b, "x");
  assert.deepEqual(b.systemInstruction, { parts: [{ text: `${DROID_SYSTEM_LINE} already` }] });
  // An explicit level wins over a stray budget.
  const c = { contents: [], generationConfig: { thinkingConfig: { thinkingLevel: "HIGH", thinkingBudget: 10 } } };
  normalizeGeminiPayload(c, "x");
  assert.deepEqual(c.generationConfig.thinkingConfig, { thinkingLevel: "HIGH" });
});

test("gemini payload: signed thought parts stay byte-exact", () => {
  const signed = { text: "You are powered by the model, named", thoughtSignature: "sig" };
  const p = { contents: [{ role: "model", parts: [signed] }] };
  normalizeGeminiPayload(p, "gemini-4-argon");
  assert.equal(p.contents[0].parts[0].text, "You are powered by the model, named");
});

test("gemini level ranges match the budgets handed to pi-ai", () => {
  assert.equal(geminiLevelForBudget(GEMINI_THINKING_BUDGETS.low), "LOW");
  assert.equal(geminiLevelForBudget(GEMINI_THINKING_BUDGETS.medium), "MEDIUM");
  assert.equal(geminiLevelForBudget(GEMINI_THINKING_BUDGETS.high), "HIGH");
  assert.equal(geminiLevelForBudget(GEMINI_THINKING_BUDGETS.minimal), "LOW");
  assert.equal(geminiLevelForBudget(-1), undefined);
});

test("gemini provider entry reuses pi-ai's google catalog provider", () => {
  assert.equal(ROUTES.google.key, "google");
  const entry = buildProviderEntry("google", { port: 3080, gatewayPrefix: "/api/dsh-factory-provider", allowlist: ["gemini-4-argon"] });
  assert.equal(entry.api, undefined, "naming an api would make a hand-declared route that cannot speak Gemini");
  assert.equal(entry.apiKeyEnv, GEMINI_GATEWAY_KEY_REF);
  assert.equal(entry.baseURL, "http://127.0.0.1:3080/api/dsh-factory-provider/g/v1beta");
  assert.deepEqual(entry.models.map((m) => m.id), ["gemini-4-argon"]);
  assert.deepEqual(entry.models[0].reasoningEfforts, { low: "low", medium: "medium", high: "high" });
  assert.deepEqual(entry.thinkingBudgets, GEMINI_THINKING_BUDGETS);
});

test("gemini session key: system and first user text", () => {
  const parts = sessionKeyParts("google", {
    systemInstruction: { parts: [{ text: "S" }] },
    contents: [{ role: "model", parts: [{ text: "no" }] }, { role: "user", parts: [{ text: "first" }] }],
  });
  assert.deepEqual(parts, { system: "S", firstUser: "first" });
});

async function fixture(t, fetchImpl) {
  const seen = [];
  const gateway = createGateway({
    gatewayPrefix: "/fixture",
    enabledRoutes: ["google"],
    cliVersion: "9.9.9",
    resolver: { resolve: async () => ({ token: "offline-fixture", orgId: "org-1" }), forceRefresh: async () => undefined, state: () => ({}) },
    fetchImpl: async (url, opts) => {
      seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      return fetchImpl();
    },
  });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    const route = gateway.routes.find((r) => (r.kind === "exact" ? r.path === pathname : pathname.startsWith(`${r.path}/`)));
    if (route) void route.handler(req, res);
    else { res.statusCode = 599; res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/fixture/g/v1beta`;
  return { seen, base, gateway };
}

const sse = (...frames) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

test("gemini gateway: stream path → Factory generate with droid headers, SSE untouched", async (t) => {
  const frames = [
    { candidates: [{ content: { role: "model", parts: [{ text: "PO" }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "NG", thoughtSignature: "s" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 2 } },
  ];
  const f = await fixture(t, () => sse(...frames));
  const res = await fetch(`${f.base}/models/gemini-4-argon:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": "factory-gateway" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, frames.map((fr) => `data: ${JSON.stringify(fr)}\n\n`).join(""));
  assert.equal(f.seen.length, 1);
  const [call] = f.seen;
  assert.equal(call.url, "https://prem.factory.ai/api/llm/g/v1/generate");
  assert.equal(call.headers.authorization, "Bearer offline-fixture");
  assert.equal(call.headers["x-api-provider"], "google");
  assert.equal(call.headers["user-agent"], "factory-cli/9.9.9");
  assert.equal(call.headers["X-Factory-Org-Id"], "org-1");
  assert.equal(call.headers["x-goog-api-key"], undefined, "the placeholder key never leaves the gateway");
  assert.equal(call.body.model, "gemini-4-argon");
  assert.ok(call.body.systemInstruction.parts[0].text.startsWith(DROID_SYSTEM_LINE));
});

test("gemini gateway: non-streaming call is merged into one response", async (t) => {
  const f = await fixture(t, () => sse(
    { candidates: [{ content: { parts: [{ text: "PO" }] } }] },
    { candidates: [{ content: { parts: [{ text: "NG" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 3 } },
  ));
  const res = await fetch(`${f.base}/models/gemini-3.8-flash:generateContent`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.candidates[0].content, { role: "model", parts: [{ text: "PO" }, { text: "NG" }] });
  assert.equal(body.candidates[0].finishReason, "STOP");
  assert.deepEqual(body.usageMetadata, { totalTokenCount: 3 });
});

test("gemini gateway: Factory errors reach the SDK in Google's error shape", async (t) => {
  const f = await fixture(t, () => new Response(JSON.stringify({ detail: "Forbidden", status: 403, title: "Forbidden" }), { status: 403 }));
  const res = await fetch(`${f.base}/models/gemini-4-argon:streamGenerateContent?alt=sse`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [] }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, 403);
  assert.equal(body.error.status, "PERMISSION_DENIED");
  assert.match(body.error.message, /Factory Gemini route 403: Forbidden/);
});

test("gemini gateway: unknown path and disabled route", async (t) => {
  const f = await fixture(t, () => sse());
  const bad = await fetch(`${f.base}/models/x:countTokens`, { method: "POST", body: "{}" });
  assert.equal(bad.status, 404);
  const list = await (await fetch(`${f.base}/models`)).json();
  assert.ok(list.models.some((m) => m.name === "models/gemini-4-argon"));
  f.gateway.configure({ routes: [] });
  const off = await fetch(`${f.base}/models/gemini-4-argon:streamGenerateContent`, { method: "POST", body: "{}" });
  assert.equal(off.status, 404);
  assert.equal(f.seen.length, 0);
});

test("gemini limits follow droid 0.241.1's registry (1M in, 65536 out)", () => {
  for (const m of ROUTES.google.models) {
    assert.equal(m.contextWindow, 1_000_000, m.id);
    assert.equal(m.maxTokens, 65_536, m.id);
  }
  assert.deepEqual(ROUTES.google.models.map((m) => m.id), ["gemini-4-argon", "gemini-3.1-pro-preview", "gemini-3.8-flash"]);
});
