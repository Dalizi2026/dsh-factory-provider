import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../lib/gateway.js';
import { ROUTES } from '../lib/catalog.js';
import { scopeFactoryRequest } from '../lib/request-purpose.js';
import { PROVIDER_ROUTING_DATA as data, providerOrder, createProviderRouter, normalizeFactoryFailures,
  createRoutingAttemptTracker, FACTORY_ATTEMPT_HEADER, FACTORY_PREVIOUS_FAILURE_HEADER } from '../lib/provider-routing.js';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-routing-tests-'));
process.env.DSH_FACTORY_JOURNAL = path.join(temp, 'journal.jsonl');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const credential = { token: 'fk-offline-routing-fixture' };
const selectArgs = (overrides = {}) => ({ credential, model: 'claude-opus-5-5', route: 'anthropic', session: 'fixture-session', host: 'https://offline.invalid', ...overrides });
const cloneConfig = () => structuredClone(data.config);

test('Anthropic preference reorders only eligible Claude candidates; fallback success stays sticky', async () => {
  const router = createProviderRouter({ preferAnthropic: true });
  const first = await router.select(selectArgs());
  assert.equal(first.provider, 'anthropic'); assert.equal(first.source, 'preferred_order');
  assert.deepEqual(first.order, ['anthropic', 'bedrock_anthropic', 'snowflake', 'azure_anthropic']);
  first.failure();
  const fallback = await router.select(selectArgs()); assert.equal(fallback.provider, 'bedrock_anthropic'); fallback.success();
  assert.equal((await router.select(selectArgs())).provider, 'bedrock_anthropic');
  assert.equal((await router.select(selectArgs({ session: 'new' }))).provider, 'anthropic');
});

test('Anthropic preference never bypasses account order, blocked providers, or region limits', async () => {
  for (const restriction of ['unconfigured', 'blocked', 'region']) {
    const config = cloneConfig();
    if (restriction === 'unconfigured') config.models['claude-opus-5-5'] = ['bedrock_anthropic'];
    if (restriction === 'blocked') config.blockedProviders['claude-opus-5-5'] = ['anthropic'];
    const router = createProviderRouter({ config, preferAnthropic: true });
    const args = restriction === 'region' ? { model: 'claude-opus-5', region: 'eu' } : {};
    const selection = await router.select(selectArgs(args));
    assert.notEqual(selection.provider, 'anthropic', restriction);
    assert.equal(selection.preferenceReason, 'anthropic_unavailable');
    assert.equal(router.status().lastClaudeSelection.preferenceReason, 'anthropic_unavailable');
  }
});

test('saved preference changes affect new sessions only; existing Claude/Core/GPT sessions stay on their healthy upstream', async () => {
  const router = createProviderRouter();
  const claude = await router.select(selectArgs()); claude.success();
  const coreArgs = selectArgs({ model: 'glm-5.3-flash', route: 'generic' });
  (await router.select(coreArgs)).failure(); (await router.select(coreArgs)).success();
  const gptArgs = selectArgs({ model: 'gpt-5.5', route: 'openai' });
  (await router.select(gptArgs)).failure(); const gpt = await router.select(gptArgs); gpt.success();
  router.configure({ preferAnthropic: true });
  assert.equal((await router.select(selectArgs())).provider, 'bedrock_anthropic');
  const newArgs = selectArgs({ session: 'new-with-preference' });
  const preferred = await router.select(newArgs); assert.equal(preferred.provider, 'anthropic'); preferred.success();
  assert.equal((await router.select(coreArgs)).provider, 'baseten');
  assert.equal((await router.select(gptArgs)).provider, gpt.provider);
  router.configure({ preferAnthropic: true });
  assert.equal((await router.select(selectArgs())).source, 'session_lock');
  router.configure({ preferAnthropic: false });
  assert.equal((await router.select(selectArgs())).provider, 'bedrock_anthropic');
  assert.equal((await router.select(newArgs)).provider, 'anthropic');
  assert.equal((await router.select(selectArgs({ session: 'new-with-default' }))).provider, 'bedrock_anthropic');
  assert.equal((await router.select(coreArgs)).provider, 'baseten');
});

test('all 38 catalog models have audited routing and each selected backend belongs to its model', () => {
  assert.equal(Object.keys(data.models).length, 38);
  for (const [route, entry] of Object.entries(ROUTES)) for (const model of entry.models) {
    const registry = data.models[model.id]; assert(registry, model.id); assert.equal(registry.route, route);
    const order = providerOrder(model.id); assert(order.length, model.id);
    for (const p of order) assert(registry.providers.includes(p), `${model.id}: ${p}`);
  }
});
test('official ordering is configured order, not registered backend order', () => {
  assert.deepEqual(providerOrder('claude-opus-5-5'), ['bedrock_anthropic', 'snowflake', 'azure_anthropic', 'anthropic']);
  assert.deepEqual(providerOrder('claude-sonnet-5-5'), ['anthropic']);
  assert.deepEqual(providerOrder('claude-sonnet-5'), ['azure_anthropic', 'bedrock_anthropic', 'anthropic', 'vertex_anthropic']);
  assert.deepEqual(providerOrder('glm-5.3-flash'), ['fireworks', 'baseten']);
  assert.deepEqual(providerOrder('glm-5.3'), ['baseten', 'fireworks']);
  assert.deepEqual(providerOrder('minimax-m3'), ['fireworks']);
  assert.deepEqual(providerOrder('inkling'), ['fireworks']);
  assert.deepEqual(providerOrder('claude-opus-5-5-fast'), ['anthropic']);
});
test('unknown/wrong protocol models are rejected; blocked and regional routes obey official eligibility', () => {
  assert.deepEqual(providerOrder('unknown'), []);
  assert.deepEqual(providerOrder('glm-5.3-flash', { route: 'anthropic' }), []);
  assert.deepEqual(providerOrder('claude-opus-5', { region: 'eu' }), ['bedrock_anthropic']);
  assert.deepEqual(providerOrder('gpt-6-astra', { region: 'eu' }), []);
  assert.deepEqual(providerOrder('gpt-5.3-codex', { region: 'us' }), []);
  assert.deepEqual(providerOrder('glm-5.3', { region: 'global' }), ['baseten', 'fireworks']);
  const config = cloneConfig(); config.blockedProviders['claude-opus-5-5'] = data.models['claude-opus-5-5'].providers;
  assert.deepEqual(providerOrder('claude-opus-5-5', { config }), []);
});
test('config fallback never appends an unconfigured registry backend', () => {
  const config = cloneConfig(); config.models['glm-5.3-flash'] = ['snowflake', 'baseten', 'baseten'];
  assert.deepEqual(providerOrder('glm-5.3-flash', { config }), ['baseten']);
  config.models['glm-5.3-flash'] = []; config.defaults.factory = [];
  assert.deepEqual(providerOrder('glm-5.3-flash', { config }), ['fireworks']);
});
test('failure rotates once, successful provider stays locked; accounts, sessions and hosts are isolated', async () => {
  const router = createProviderRouter();
  const first = await router.select(selectArgs()); assert.equal(first.provider, 'bedrock_anthropic');
  assert.equal(first.failure(), 'snowflake'); assert.equal(first.failure(), undefined);
  const second = await router.select(selectArgs()); assert.equal(second.provider, 'snowflake'); second.failure();
  const third = await router.select(selectArgs()); assert.equal(third.provider, 'azure_anthropic'); third.success();
  assert.equal((await router.select(selectArgs())).source, 'session_lock');
  for (const overrides of [{ credential: { token: 'second-key' } }, { session: 'other' }, { host: 'https://other.invalid' }]) {
    assert.equal((await router.select(selectArgs(overrides))).provider, 'bedrock_anthropic');
  }
});
test('API-key flags override desktop snapshot, are key scoped, deduplicated and refresh after expiry', async () => {
  let calls = 0, clock = 1;
  const router = createProviderRouter({ now: () => clock, fetchConfig: async (_url, init) => {
    calls++; assert.equal(init.headers.authorization.startsWith('Bearer '), true);
    const config = cloneConfig(); config.models['gpt-6-luna'] = init.headers.authorization.includes('second') ? ['azure_openai'] : ['openai'];
    await new Promise(resolve => setImmediate(resolve));
    return Response.json({ configs: { provider_routing: config }, secret: 'must-not-be-stored' });
  } });
  const args = selectArgs({ model: 'gpt-6-luna', route: 'openai' });
  const replies = await Promise.all([router.select(args), router.select(args)]);
  assert.equal(calls, 1); assert(replies.every(r => r.provider === 'openai' && r.configSource === 'account_feature_flags'));
  assert.equal((await router.select({ ...args, credential: { token: 'second-key' } })).provider, 'azure_openai');
  assert.equal(calls, 2); clock += 300001; await router.select(args); assert.equal(calls, 3);
  assert(!JSON.stringify(router.status()).includes('secret')); assert(!JSON.stringify(router.status()).includes(credential.token));
});
test('healthy session never switches on routing config refresh or recovered upstream order, including long idle gaps', async () => {
  let clock = 1, calls = 0;
  const router = createProviderRouter({ preferAnthropic: true, now: () => clock, fetchConfig: async () => {
    calls++; const config = cloneConfig();
    if (calls > 1) config.models['claude-opus-5-5'] = ['azure_anthropic', 'anthropic', 'bedrock_anthropic', 'snowflake'];
    return Response.json({ configs: { provider_routing: config } });
  } });
  (await router.select(selectArgs())).failure();
  const fallback = await router.select(selectArgs()); assert.equal(fallback.provider, 'bedrock_anthropic'); fallback.success();
  clock += 3600001;
  const afterRefresh = await router.select(selectArgs());
  assert.equal(calls, 2); assert.equal(afterRefresh.provider, 'bedrock_anthropic');
  assert.equal(afterRefresh.source, 'session_lock'); afterRefresh.success();
  assert.equal((await router.select(selectArgs())).provider, 'bedrock_anthropic');
  assert.equal((await router.select(selectArgs({ session: 'new' }))).provider, 'anthropic');
});
test('routing config outage retains last verified account order; fresh downloads fall back without local Droid', async () => {
  let clock = 1, available = true;
  const router = createProviderRouter({ now: () => clock, fetchConfig: async () => {
    if (!available) throw Error('offline'); const config = cloneConfig(); config.models['claude-opus-5-5'] = ['azure_anthropic'];
    return Response.json({ configs: { provider_routing: config } });
  } });
  assert.equal((await router.select(selectArgs())).provider, 'azure_anthropic');
  clock += 300001; available = false;
  const stale = await router.select(selectArgs({ session: 'new' })); assert.equal(stale.provider, 'azure_anthropic'); assert.equal(stale.configSource, 'account_feature_flags');
  const fallback = await router.select(selectArgs({ credential: { token: 'other' } })); assert.equal(fallback.provider, 'bedrock_anthropic'); assert.equal(fallback.configSource, 'bundled_snapshot');
});
test('routing session/config caches are bounded', async () => {
  const router = createProviderRouter({ maxSessions: 3, maxAccounts: 2, fetchConfig: async () => Response.json({ configs: { provider_routing: cloneConfig() } }) });
  for (let i = 0; i < 10; i++) await router.select(selectArgs({ session: String(i), credential: { token: String(i) } }));
  assert.equal(router.status().sessions, 3); assert.equal(router.status().accountConfigs, 2);
});
test('confirmed idle timeout advances unfinished provider; stale tickets and completed/handled attempts never double rotate', async () => {
  const router = createProviderRouter();
  await router.select(selectArgs({ attempt: 'first' }));
  const retry = await router.select(selectArgs({ attempt: 'second', previousFailure: 'first' })); assert.equal(retry.provider, 'snowflake');
  const stale = await router.select(selectArgs({ attempt: 'third', previousFailure: 'first' })); assert.equal(stale.provider, 'snowflake'); stale.success();
  assert.equal((await router.select(selectArgs({ attempt: 'fourth', previousFailure: 'third' }))).provider, 'snowflake');
  const failed = await router.select(selectArgs({ attempt: 'fifth' })); failed.failure();
  assert.equal((await router.select(selectArgs({ attempt: 'sixth', previousFailure: 'fifth' }))).provider, 'azure_anthropic');
});
test('OpenAI encrypted reasoning from old route is removed after failover and stays removed on following turns', async () => {
  const router = createProviderRouter(); const args = selectArgs({ model: 'gpt-5.5', route: 'openai' });
  const first = await router.select(args); first.success();
  const old = { type: 'reasoning', id: 'rs-old', encrypted_content: 'azure-issued' }, text = { role: 'user', content: 'continue' };
  const before = await router.select(args); const original = { input: [old, text] }; before.prepare(original); assert.equal(original.input.length, 2); before.failure();
  const next = await router.select(args); assert.equal(next.provider, 'openai'); const switched = { input: [old, text] }; next.prepare(switched); assert.deepEqual(switched.input, [text]); next.success();
  const after = await router.select(args); const current = { type: 'reasoning', encrypted_content: 'openai-issued' }, body = { input: [old, current, text] }; after.prepare(body); assert.deepEqual(body.input, [current, text]);
});

async function server(t, fetchImpl, extra = {}) {
  const gw = createGateway({ resolver: { resolve: async () => credential, forceRefresh: async () => credential }, enabledRoutes: ['anthropic', 'generic', 'openai'], gatewayPrefix: '/factory', fetchImpl, ...extra });
  const host = http.createServer((req, res) => { const route = gw.routes.find(r => r.path === req.url); if (route) void route.handler(req, res); else { res.statusCode = 404; res.end(); } });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { host.close(resolve); host.closeAllConnections(); }));
  return { configure: gw.configure, async call({ route = 'anthropic', model = 'claude-opus-5-5', headers = {}, ...body } = {}) {
    const tail = route === 'anthropic' ? 'a/v1/messages' : route === 'generic' ? 'o/v1/chat/completions' : 'openai/v1/responses';
    const response = await fetch(`http://127.0.0.1:${host.address().port}/factory/${tail}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model, stream: true, max_tokens: 32, system: 'fixed-prefix', messages: [{ role: 'user', content: 'hello' }], ...body }) });
    return { status: response.status, text: await response.text() };
  } };
}
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
test('gateway preference starts new threads on Anthropic, keeps existing threads stable, and falls back after 503', async t => {
  const seen = [];
  const gw = await server(t, async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    if (seen.length === 4) return Response.json({ error: { message: 'Overloaded' } }, { status: 503 });
    return sse([{ type: 'message_stop' }]);
  });
  await gw.call();
  gw.configure({ preferAnthropic: true }); await gw.call();
  const newThread = { messages: [{ role: 'user', content: 'different first message for a new thread' }] };
  await gw.call(newThread); assert.equal((await gw.call(newThread)).status, 503);
  await gw.call(newThread); await gw.call(newThread);
  gw.configure({ preferAnthropic: false }); await gw.call(newThread);
  assert.deepEqual(seen.map(r => r.headers['x-api-provider']), ['bedrock_anthropic', 'bedrock_anthropic', 'anthropic', 'anthropic', 'bedrock_anthropic', 'bedrock_anthropic', 'bedrock_anthropic']);
  assert(seen.every(r => r.url.startsWith('https://prem.factory.ai/')));
  assert.equal(seen[0].body, seen[1].body);
  assert(seen.slice(2).every(r => r.body === seen[2].body));
  assert.equal(new Set(seen.slice(2).map(r => r.headers['x-session-id'])).size, 1);
});
test('gateway 503 -> Snowflake 500 -> Azure success and next turn locks Azure; each call sends one request and preserves cache body', async t => {
  const seen = [];
  const gw = await server(t, async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    if (seen.length <= 2) return Response.json({ error: { message: 'Overloaded' } }, { status: seen.length === 1 ? 503 : 500 });
    return sse([{ type: 'message_start', message: { usage: { input_tokens: 2, cache_read_input_tokens: 100 } } }, { type: 'message_stop' }]);
  });
  for (const status of [503, 500, 200, 200]) assert.equal((await gw.call()).status, status);
  assert.deepEqual(seen.map(r => r.headers['x-api-provider']), ['bedrock_anthropic', 'snowflake', 'azure_anthropic', 'azure_anthropic']);
  assert.equal(seen[3].headers['x-provider-routing-source'], 'session_lock');
  assert(seen.every(r => r.body === seen[0].body)); assert.equal(new Set(seen.map(r => r.headers['x-session-id'])).size, 1);
  assert(seen.every(r => r.url.endsWith('/api/llm/a/v1/messages')));
});
test('gateway GLM transport failure -> Baseten, same Chat Completions protocol; API-key GPT route applies own flags', async t => {
  const seen = []; let calls = 0;
  const gw = await server(t, async (url, init) => { seen.push({ url, ...init }); if (calls++ === 0) throw new TypeError('fetch failed'); return sse([{ choices: [{ finish_reason: 'stop' }] }, { type: 'done' }]); },
    { routingFetch: async () => { const config = cloneConfig(); config.models['gpt-6-luna'] = ['openai']; return Response.json({ configs: { provider_routing: config } }); } });
  assert.equal((await gw.call({ route: 'generic', model: 'glm-5.3-flash' })).status, 502);
  assert.equal((await gw.call({ route: 'generic', model: 'glm-5.3-flash' })).status, 200);
  assert.deepEqual(seen.slice(0, 2).map(r => r.headers['x-api-provider']), ['fireworks', 'baseten']);
  assert(seen.slice(0, 2).every(r => r.url.endsWith('/chat/completions')));
  await gw.call({ route: 'openai', model: 'gpt-6-luna', input: [{ role: 'user', content: 'hello' }] });
  assert.equal(seen[2].headers['x-api-provider'], 'openai'); assert(seen[2].headers['openai-platform']);
});
test('gateway 401 refresh does not rotate; 402/403/413/400 never rotate; unsupported model never sends', async t => {
  const providers = []; const statuses = [401, 401, 402, 403, 413, 400, 200];
  const gw = await server(t, async (_url, init) => { providers.push(init.headers['x-api-provider']); return Response.json({}, { status: statuses.shift() }); });
  for (const status of [401, 402, 403, 413, 400, 200]) assert.equal((await gw.call()).status, status);
  assert(providers.every(p => p === 'bedrock_anthropic')); assert.equal(providers.length, 7);
  assert.equal((await gw.call({ model: 'unknown' })).status, 400); assert.equal(providers.length, 7);
});
test('gateway observes HTTP-200 SSE overload without altering bytes and next attempt rotates; split frames work', async t => {
  const providers = []; const content = 'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  const gw = await server(t, async (_url, init) => { providers.push(init.headers['x-api-provider']); return new Response(new ReadableStream({ start(c) {
    for (const character of content) c.enqueue(Buffer.from(character)); c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } }); });
  assert.equal((await gw.call()).text, content); await gw.call(); assert.deepEqual(providers, ['bedrock_anthropic', 'snowflake']);
});
test('gateway consumes local timeout tickets and session metadata; no internal headers leak upstream', async t => {
  const seen = []; const first = '11111111-1111-1111-1111-111111111111', second = '22222222-2222-2222-2222-222222222222';
  const gw = await server(t, async (_url, init) => { seen.push(init.headers); return sse([{ type: 'message_start' }]); });
  await gw.call({ headers: { [FACTORY_ATTEMPT_HEADER]: first } });
  await gw.call({ headers: { [FACTORY_ATTEMPT_HEADER]: second, [FACTORY_PREVIOUS_FAILURE_HEADER]: first } });
  assert.deepEqual(seen.map(h => h['x-api-provider']), ['bedrock_anthropic', 'snowflake']);
  assert(seen.every(h => !h[FACTORY_ATTEMPT_HEADER] && !h[FACTORY_PREVIOUS_FAILURE_HEADER]));
});
const collect = async stream => { const values = []; for await (const value of stream) values.push(value); return values; };
async function* chunks(...values) { yield* values; }
const overloaded = { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' } } };
test('adapter overload becomes SERVER only before content; partial reasoning/tool calls and cancellation stay unchanged', async () => {
  assert.equal((await collect(normalizeFactoryFailures(chunks({ type: 'usage' }, overloaded)))).at(-1).reason.failure.code, 'SERVER');
  for (const chunk of [{ type: 'text-delta', text: 'partial' }, { type: 'reasoning-delta', text: 'thinking' }, { type: 'tool-call-delta' }])
    assert.equal((await collect(normalizeFactoryFailures(chunks(chunk, overloaded)))).at(-1), overloaded);
  const controller = new AbortController(); controller.abort();
  assert.equal((await collect(normalizeFactoryFailures(chunks(overloaded), controller.signal)))[0], overloaded);
  const unknown = { ...overloaded, reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'unexpected failure' } } };
  assert.equal((await collect(normalizeFactoryFailures(chunks(unknown))))[0], unknown);
});
test('adapter scopes timeout tickets to a session/model and keeps profiles immutable; user abort is not a timeout signal', () => {
  const tracker = createRoutingAttemptTracker(), snapshot = { profiles: new Map([['factory-g', { headers: { kept: 'yes' } }]]) }, options = { provider: 'factory-g', model: 'glm-5.3-flash', sessionId: 'abc' };
  const first = tracker.prepare(options, snapshot); first.finish({ failure: { code: 'TIMEOUT' }, emittedContent: false });
  const second = tracker.prepare(options, snapshot); assert.equal(second.snapshot.profiles.get('factory-g').headers[FACTORY_PREVIOUS_FAILURE_HEADER], first.snapshot.profiles.get('factory-g').headers[FACTORY_ATTEMPT_HEADER]);
  assert.deepEqual(snapshot.profiles.get('factory-g').headers, { kept: 'yes' });
  assert.equal(tracker.prepare({ ...options, sessionId: 'other' }, snapshot).snapshot.profiles.get('factory-g').headers[FACTORY_PREVIOUS_FAILURE_HEADER], undefined);
  second.finish({ failure: { code: 'ABORTED' }, emittedContent: false });
  assert.equal(tracker.prepare(options, snapshot).snapshot.profiles.get('factory-g').headers[FACTORY_PREVIOUS_FAILURE_HEADER], undefined);
  const scoped = scopeFactoryRequest(snapshot, options); assert(scoped.profiles.get('factory-g').headers['x-dsh-factory-session']);
});
