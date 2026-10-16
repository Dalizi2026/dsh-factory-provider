import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ROUTES, buildProviderEntry } from '../lib/catalog.js';
import { modelPreset, modelMultiplier } from '../lib/model-presets.js';
import { factoryModelLimits } from '../lib/model-limits.js';
import { providerOrder } from '../lib/provider-routing.js';
import { resolveModelCompactionPolicy } from '../lib/compaction-policy.js';
import { createGateway } from '../lib/gateway.js';
import { installAdaptiveImages } from '../lib/images.js';

const root = process.env.DSH_FACTORY_HOST_ROOT;
const evidence = JSON.parse(fs.readFileSync(new URL('./fixtures/droid-0.243.0-model-additions.json', import.meta.url)));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-oct16-'));
process.env.DSH_FACTORY_JOURNAL = path.join(directory, 'journal.jsonl');
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('Oct 16 models: official pool, budget, efforts, image capability and exclusive upstream', () => {
  for (const record of evidence.models) {
    const spec = ROUTES[record.route], model = spec.models.find(m => m.id === record.id);
    assert.equal(spec.billingPool, record.billingPool);
    assert.equal(model.billingPool, record.billingPool);
    assert.equal(spec.key, record.provider);
    assert.equal(model.defaultEffort, 'high');
    assert.deepEqual(factoryModelLimits(spec.key, model.id), record.limits);
    assert.deepEqual(modelPreset(model.id).supportedEfforts, record.supportedReasoningEfforts);
    assert.equal(modelMultiplier(model.id), record.tokenMultiplier);
    assert.deepEqual(providerOrder(model.id, { route: record.route }), record.apiProviders);
    const profile = buildProviderEntry(record.route, { port: 1, gatewayPrefix: '/fixture' });
    assert.equal(profile.models.find(m => m.id === model.id).input.includes('image'), record.images);
    assert.equal(resolveModelCompactionPolicy(model.id).thresholdTokens, 250000);
    assert.equal(resolveModelCompactionPolicy(model.id, { modelCompactionTokens: { [model.id]: 200000 } }).thresholdTokens, 200000);
    assert.equal(factoryModelLimits(record.provider === 'factory-s' ? 'factory-g' : 'factory-s', model.id), undefined);
  }
  assert.equal(ROUTES.generic.models[0].id, 'glm-5.3-flash');
  assert(!ROUTES.generic.models.some(m => m.id.startsWith('muse-')));
  assert.equal(ROUTES.standard.models.length, 2);
  assert.deepEqual(providerOrder('muse-spark-open', { route: 'generic' }), []);
});

// The real DSH adapter and real Chat Completions SDK use a local gateway;
// every upstream response is synthetic, with no real keys or model charges.
for (const record of evidence.models) test(`Oct 16 native DSH: ${record.id} defaults, tool replay, usage and session affinity`, { skip: !root }, async t => {
  const load = name => import(pathToFileURL(path.join(root, '@deepseek-ai', name, 'lib/index.js')));
  const [{ Context }, { PiAiAdapter, Config }, sdk, { normalizeContext }] = await Promise.all([
    load('cordis'), load('dsh-llm-pi-ai'),
    import(pathToFileURL(path.join(root, '@earendil-works/pi-ai/dist/api/openai-completions.js'))),
    import(pathToFileURL(path.join(root, '@earendil-works/pi-ai/dist/utils/transcript.js'))),
  ]);
  const seen = [];
  const credential = { token: 'fk-offline', source: 'api-key' };
  const gateway = createGateway({ resolver: { resolve: async () => credential, state: () => credential },
    enabledRoutes: [record.route], gatewayPrefix: '/fixture', apiBaseURL: 'https://offline.invalid',
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const delta = seen.length === 1 ? { role: 'assistant', reasoning_content: 'Inspecting fixture.',
        tool_calls: [{ index: 0, id: 'inspect_fixture', type: 'function', function: { name: 'inspect', arguments: '{}' } }] }
        : { role: 'assistant', content: 'OK' };
      const frames = [{ id: 'chat_fixture', choices: [{ index: 0, delta, finish_reason: null }] },
        { id: 'chat_fixture', choices: [{ index: 0, delta: {}, finish_reason: seen.length === 1 ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 40 } } }];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  const server = http.createServer((req, res) => {
    const handler = gateway.routes.find(r => r.path === new URL(req.url, 'http://localhost').pathname)?.handler;
    if (handler) void handler(req, res); else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const profile = buildProviderEntry(record.route, { port: server.address().port, gatewayPrefix: '/fixture', allowlist: [record.id] });
  assert.doesNotThrow(() => Config({ providers: { [record.provider]: profile } }));
  const entry = profile.models[0];
  const model = { ...entry, provider: record.provider, api: profile.api, baseUrl: profile.baseURL,
    reasoning: true, thinkingLevelMap: entry.reasoningEfforts, headers: profile.headers, compat: profile.compat,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const profiles = new Map([[record.provider, { ...profile, modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 60000 }]]);
  const models = { getModel: () => model, streamSimple: (m, context, options) => sdk.streamSimple(m, normalizeContext(context), options) };
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined, resolveAttachments: () => ({}) });
  adapter.snapshot = { profiles, models };
  const ctx = new Context(); ctx.provide('llm', { registration: () => ({ adapter }) });
  const dispose = installAdaptiveImages(ctx, () => ({ routes: [record.route], factoryAdaptiveImages: false }), {}, () => {});
  t.after(dispose); await new Promise(resolve => setImmediate(resolve));
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Inspect the fixture.' }] }];
  const args = { provider: record.provider, model: record.id, sessionId: `fixture-${record.id}`, messages, maxTokens: 16,
    tools: [{ name: 'inspect', description: 'Inspect fixture', parameters: { type: 'object', properties: {} } }] };
  const first = []; for await (const chunk of adapter.stream(args)) first.push(chunk);
  assert.equal(first.at(-1).reason.kind, 'tool-calls', JSON.stringify(first));
  assert.equal(seen[0].body.reasoning_effort, 'high');
  assert.equal(seen[0].body.max_tokens ?? seen[0].body.max_completion_tokens, 16);
  assert.equal(seen[0].headers['x-api-provider'], record.apiProviders[0]);
  assert(seen[0].url.endsWith('/api/llm/o/v1/chat/completions'));
  const blocks = first.filter(c => c.type === 'block-end').map(c => c.block);
  const call = blocks.find(block => block.type === 'tool-call'); assert(call);
  const finish = first.find(c => c.type === 'finish');
  const next = [...messages, { role: 'assistant', content: blocks,
    source: { provider: record.provider, model: record.id, replayState: finish.replayState } },
    { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'fixture result' }] }];
  const second = []; for await (const chunk of adapter.stream({ ...args, messages: next,
    reasoningEffort: record.id === 'nemotron-3.5-super' ? 'off' : 'low' })) second.push(chunk);
  assert.equal(second.at(-1).reason.kind, 'stop', JSON.stringify(second));
  assert.equal(seen[1].body.reasoning_effort, record.id === 'nemotron-3.5-super' ? 'none' : 'low');
  assert.equal(seen[1].body.messages.find(m => m.role === 'assistant').reasoning_content, 'Inspecting fixture.');
  assert.equal(seen[1].body.messages.find(m => m.role === 'tool').tool_call_id, call.id);
  assert.equal(seen[1].headers['x-session-id'], seen[0].headers['x-session-id']);
  assert.equal(seen[1].headers['x-provider-routing-source'], 'session_lock');
  assert.equal(second.find(c => c.type === 'usage').usage.cacheReadTokens, 40);
});
