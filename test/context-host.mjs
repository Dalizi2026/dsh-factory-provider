// Integration against an extracted, unmodified installed DSH runtime. All LLM
// calls are local synthetic streams. Set DSH_FACTORY_HOST_ROOT to its node_modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { createGateway } from '../lib/gateway.js';
process.env.DSH_FACTORY_JOURNAL = path.join(os.tmpdir(), `factory-host-test-${process.pid}.jsonl`);
import { pathToFileURL } from 'node:url';
import { installContextOptimization } from '../lib/context.js';
import { factoryModelLimits } from '../lib/model-limits.js';
import { buildProviderEntry } from '../lib/catalog.js';
const root = process.env.DSH_FACTORY_HOST_ROOT;
const host = name => import(pathToFileURL(path.join(root, '@deepseek-ai', name, 'lib/index.js')));
async function setup({ pressure = 130000, finish = 'stop', provider = 'factory-a', config = {}, nativeConfig = {}, capacities = {}, image = false, model = 'claude-opus-5-5', output = 64000, reasoningEffort, isolatedCompaction = false, streamImpl, imageProjection = false, imageEveryStep = false, textRepeat = 2000 } = {}) {
  const [{ Context }, { Session }, { default: TokenMeter }, { default: Basic }, llmTypes, { createScope }, { agentEvents }] = await Promise.all([host('cordis'), host('dsh-session'), host('dsh-token-meter'), host('dsh-compaction-basic'), host('dsh-llm'), host('dsh-scope'), host('dsh-agent')]);
  const ctx = new Context(); const seen = [];
  ctx.provide('sessionProjections', { register() {} });
  const projections = [];
  ctx.provide('sessions', { messageProjections: projections, registerMessageProjection: projection => { projections.push(projection); return () => {}; } });
  if (imageProjection) { ctx.provide('agents', {}); (await host('dsh-compaction-image-offload')).apply(ctx); }
  ctx.provide('llm', { imageRequestPricing: () => undefined, resolveModelInfo: async (provider, model) => ({ context: { contextWindow: capacities[`${provider}/${model}`] ?? (config.factoryContextAlignment === true ? factoryModelLimits(provider, model)?.contextWindow : undefined) ?? 200000 }, defaultMaxTokens: config.factoryContextAlignment === true ? factoryModelLimits(provider, model)?.maxOutputTokens ?? 64000 : 64000 }),
    async *stream(request) { seen.push(request); if (streamImpl) { yield* streamImpl(request, seen.length, llmTypes); return; } yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Constraints and next actions retained.' } }; yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 } }; yield { type: 'finish', reason: { kind: finish } }; } });
  const meter = new TokenMeter(ctx);
  const session = new Session('offline-factory', undefined, undefined, 'snapshot', undefined, projections);
  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1, message: llmTypes.createSystemMessage('Stable instructions.') }, { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider, model, maxTokens: output, ...(reasoningEffort ? { reasoningEffort } : {}) }, tools: [{ name: 'inspect', description: 'Inspect', parameters: { type: 'object' } }] }, reason: 'initial' });
  for (let step = 1; step <= 15; step++) {
    session.append('step/start', { turn: 1, step });
    session.append('user/message', llmTypes.createUserMessage({ content: [{ type: 'text', text: '任务资料'.repeat(textRepeat) }, ...(imageEveryStep || (image && step === 1) ? [{ type: 'image', mimeType: 'image/png', data: 'offline-fixture' }] : [])], source: { kind: 'user-approval' } }), { surfaceOp: 'append' });
    session.append('assistant/message', { turn: 1, step, message: llmTypes.createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider, model } }), usage: { inputTokens: 0, cacheReadTokens: pressure - 1000, outputTokens: 1000, totalTokens: pressure }, stream: [{ type: 'chunk', time: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } } }] }, { surfaceOp: 'append' });
    session.append('step/end', { turn: 1, step });
  }
  const agent = { session, options: { provider, model } }; const scope = createScope(ctx, agent);
  agent.ctx = isolatedCompaction ? scope.ctx : scope.ctx.isolate('compaction');
  let engine;
  if (isolatedCompaction) {
    // Desktop presets mount a sibling group; the Agent's own context cannot
    // resolve that group's isolated service. Use a real plugin fiber here.
    const fork = scope.ctx.isolate('compaction', 'toolResultPruner').plugin(Basic, nativeConfig);
    await fork;
    engine = fork.ctx.get('compaction')[Symbol.for('cordis.original')];
  } else engine = new Basic(agent.ctx, nativeConfig);
  await new Promise(resolve => setTimeout(resolve, 0));
  let settings = { factoryContextAlignment: false, ...config }; const status = {}, diagnostics = [];
  const dispose = installContextOptimization(ctx, () => settings, status, r => diagnostics.push(r));
  const run = () => agentEvents(ctx, agent).waterfall('agent/pre-step', { signal: new AbortController().signal, step: 16, turn: 1, messages: [] }, () => Promise.resolve('continued'));
  return { ctx, meter, engine, session, agent, seen, status, diagnostics, dispose, run, setConfig: c => { settings = { factoryContextAlignment: false, ...c }; } };
}
const skip = !root;
test('native image recovery: provider budget offloads only oldest images and retains attachment references', { skip }, async () => {
  const [{ Context }, llm, offload] = await Promise.all([host('cordis'), host('dsh-llm'), host('dsh-compaction-image-offload')]);
  const ctx = new Context(); const projections = [];
  ctx.provide('agents', {});
  ctx.provide('sessions', { registerMessageProjection: projection => { projections.push(projection); return () => {}; } });
  offload.apply(ctx);
  const refs = Array.from({ length: 13 }, (_, i) => ({ attachmentId: `sha256:${String(i).padStart(64, '0')}`, mediaType: 'image/png', bytes: 512 * 1024, width: 1000, height: 1000 }));
  const messages = refs.map(attachment => ({ role: 'user', content: [{ type: 'text', text: 'Keep the caption.' }, { type: 'image', attachment }] }));
  const snapshot = JSON.stringify(messages);
  const provider = buildProviderEntry('anthropic', { port: 19387, gatewayPrefix: '/fixture' });
  const count = llm.requiredImageOffload(messages, { representation: 'base64', maxBytes: provider.maxRequestImageBytes }, () => 512 * 1024);
  assert.equal(count, 9);
  const decisions = [];
  const events = messages.map((message, i) => ({ seq: i + 1, type: 'user/message', data: message }));
  const session = { surface: { nodes: events.map(e => e.seq) }, eventAt: seq => events[seq - 1], deriveEventMessage: event => event.data, append: (type, data) => decisions.push({ type, data }) };
  const result = await ctx.waterfall('agent/request-error', { agent: { session }, failure: { code: llm.IMAGE_OFFLOAD_REQUIRED_CODE, offloadImages: count } }, () => 'unhandled');
  assert.deepEqual(result, { kind: 'retry' });
  assert.equal(decisions[0].type, 'image/offload');
  assert.deepEqual(decisions[0].data.targets.map(t => t.seq), [1,2,3,4,5,6,7,8,9]);
  const projected = projections[0].project(decisions[0], { nodes: session.surface.nodes, events, baseSeq: 1, messages: new Map() });
  const next = messages.map((message, i) => projected.get(i + 1) ?? message);
  assert.equal(llm.requiredImageOffload(next, { representation: 'base64', maxBytes: provider.maxRequestImageBytes }, () => 512 * 1024), 0);
  assert.equal(next[0].content[1].attachment, refs[0]);
  assert.equal(next.at(-1), messages.at(-1));
  assert.equal(JSON.stringify(messages), snapshot, 'original images and captions are unchanged');
  const wire = llm.projectOffloadedImages(next, () => '[Image available to read again]');
  assert.equal(wire[0].content[1].type, 'text');
  assert.equal(wire.at(-1).content[1].type, 'image');
});
test('native desktop composition: isolated preset service is patched before its first pressure check', { skip }, async () => {
  const f = await setup({ isolatedCompaction: true, pressure: 268000, output: 128000, config: { factoryContextAlignment: true } });
  assert.equal(f.agent.ctx.get('compaction'), undefined, 'service is deliberately hidden from the Agent context');
  await f.run();
  assert.equal(f.status.state, 'active');
  assert.equal(f.status.engines, 1);
  assert.equal(f.status.lastBudget.threshold, 400000);
  assert.equal(f.seen.length, 0, 'the real native listener must see the patched threshold');
  f.dispose();
});
test('native desktop composition: another session\'s isolated compactor is never patched', { skip }, async () => {
  const f = await setup({ isolatedCompaction: true, pressure: 268000, output: 128000, config: { factoryContextAlignment: true } });
  const [{ createScope }, { default: Basic }] = await Promise.all([host('dsh-scope'), host('dsh-compaction-basic')]);
  const peer = { session: f.session, options: f.agent.options };
  peer.ctx = createScope(f.ctx, peer).ctx;
  const fork = peer.ctx.isolate('compaction').plugin(Basic, {}); await fork;
  const peerEngine = fork.ctx.get('compaction')[Symbol.for('cordis.original')];
  const original = peerEngine.compactIfNeeded;
  await f.run();
  assert.equal(f.status.engines, 1);
  assert.equal(f.status.state, 'active');
  assert.equal(peerEngine.compactIfNeeded, original);
  assert.equal(Object.hasOwn(peerEngine, 'compactIfNeeded'), false);
  f.dispose();
});
test('native desktop composition: scoped compaction commits once at 400K and unload restores it', { skip }, async () => {
  const f = await setup({ isolatedCompaction: true, pressure: 400000, output: 128000, config: { factoryContextAlignment: true } });
  const original = f.engine.compactIfNeeded;
  await f.run(); await f.run();
  assert.equal(f.status.lastBudget.threshold, 400000);
  assert.equal(f.seen.length, 1); assert.equal(f.seen[0].maxTokens, 4096);
  assert.equal(f.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 1);
  f.dispose(); assert.equal(f.engine.compactIfNeeded, original);
});
test('native DSH: shipped YAML places every new setting inside the plugin config', { skip }, async () => {
  const { parse } = await import(pathToFileURL(path.join(root, 'yaml/dist/index.js')));
  const patch = parse(fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  let found;
  function walk(value) { if (!value || typeof value !== 'object') return; if (value.name === 'dsh-factory-provider') found = value.config; for (const child of Object.values(value)) walk(child); }
  walk(patch); assert.ok(found); assert.equal(found.factoryAdaptiveImages, true); assert.equal(found.anthropicContextOptimization, true); assert.equal(found.anthropicCompactionHeadroomTokens, 16384); assert.equal(found.anthropicSummaryMaxTokens, 16384); assert.equal(found.anthropicSummaryModel, 'factory-g/glm-5.3-flash'); assert.equal(found.factoryContextAlignment, true); assert.equal(found.opus55CompactionTokens, 400000); assert.equal(found.sonnet55CompactionTokens, 400000);
});
test('native DSH: guard precedes native listener; 70K replay does not summarize', { skip }, async () => { const f = await setup({ pressure: 70905 }); const surface = [...f.session.surface.nodes]; assert.equal(await f.run(), 'continued'); assert.equal(f.seen.length, 0); assert.deepEqual(f.session.surface.nodes, surface); assert.equal(f.status.state, 'active'); f.dispose(); });
test('native DSH: one transaction shrinks history, caps summary, leaves system/tail intact', { skip }, async () => {
  const f = await setup(); const before = f.session.surface.nodes.length; const system = f.session.surface.nodes[0]; const tail = f.session.surface.nodes.at(-1);
  assert.equal(await f.run(), 'continued'); assert.equal(f.seen.length, 1); assert.equal(f.seen[0].maxTokens, 4096); assert.equal(f.seen[0].provider, 'factory-a'); assert.equal(f.seen[0].model, 'claude-opus-5-5'); assert.equal(f.seen[0].purpose, 'compaction');
  assert.match(f.seen[0].messages.at(-1).content.at(-1).text, /2457 output tokens/);
  assert.equal(f.session.surface.nodes[0], system); assert.equal(f.session.surface.nodes.at(-1), tail); assert.ok(f.session.surface.nodes.length < before - 5);
  const summaries = f.session.snapshotEvents().filter(e => e.type === 'compaction/summary'); assert.equal(summaries.length, 1); assert.equal(f.session.snapshotEvents().filter(e => e.type === 'compaction/start').length, 1); assert.equal(f.session.snapshotEvents().filter(e => e.type === 'compaction/end').length, 1);
  assert.equal(f.engine.config.maxTokens, 65536); await f.run(); assert.equal(f.seen.length, 1, 'no immediate summary-of-summary'); assert.equal(f.status.engines, 1, 'fresh Cordis proxies do not stack wrappers');
  f.dispose(); assert.equal(Object.hasOwn(f.engine, 'compactIfNeeded'), false); assert.equal(Object.hasOwn(f.engine, 'summarize'), false);
});
test('native DSH: truncated summary never commits and unchanged range is not repeated', { skip }, async () => { const f = await setup({ finish: 'max-tokens' }); const before = [...f.session.surface.nodes]; await f.run(); assert.equal(f.seen.length, 1); assert.deepEqual(f.session.surface.nodes, before); assert.equal(f.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 0); await f.run(); assert.equal(f.seen.length, 1); assert.ok(f.diagnostics.some(e => e.action === 'skip-rejected-range')); f.dispose(); });
test('native DSH: explicit smaller summary cap is preserved', { skip }, async () => { const f = await setup({ nativeConfig: { maxTokens: 1024 } }); await f.run(); assert.equal(f.seen[0].maxTokens, 1024); f.dispose(); });
test('native DSH: live opt-out restores native threshold and summary budget', { skip }, async () => { const f = await setup({ pressure: 70905 }); await f.run(); assert.equal(f.seen.length, 0); f.setConfig({ anthropicContextOptimization: false }); await f.run(); assert.ok(f.seen.length > 0); assert.equal(f.seen[0].maxTokens, 65536); f.dispose(); });
test('native DSH: other providers retain native compaction behavior', { skip }, async () => { const f = await setup({ pressure: 70905, provider: 'unrelated-provider' }); await f.run(); assert.ok(f.seen.length > 0); assert.equal(f.seen[0].provider, 'unrelated-provider'); assert.equal(f.seen[0].maxTokens, 65536); f.dispose(); });
test('native DSH: GLM compacts while the main model and header stay Opus', { skip }, async () => {
  const f = await setup({ config: { anthropicSummaryModel: 'factory-g/glm-5.3-flash' }, nativeConfig: { modelPolicies: [{ provider: 'factory-a', model: 'claude-opus-5-5', summarizationProvider: 'factory-a', summarizationModel: 'claude-sonnet-5-5' }] } });
  const header = JSON.stringify(f.session.requestHeader()); await f.run();
  assert.equal(f.seen.length, 1); assert.equal(f.seen[0].provider, 'factory-g'); assert.equal(f.seen[0].model, 'glm-5.3-flash'); assert.equal(f.seen[0].maxTokens, 4096);
  assert.equal(JSON.stringify(f.session.requestHeader()), header); assert.equal(f.agent.options.model, 'claude-opus-5-5');
  assert.equal(f.session.snapshotEvents().find(e => e.type === 'compaction/summary').data.model, 'glm-5.3-flash'); f.dispose();
});
test('native DSH: GPT summary selection is isolated and default keeps native summary override', { skip }, async () => {
  const f = await setup({ config: { anthropicSummaryModel: 'factory-o/gpt-6-luna' } }); await f.run(); assert.equal(f.seen[0].provider, 'factory-o'); assert.equal(f.seen[0].model, 'gpt-6-luna'); f.dispose();
  const original = await setup({ nativeConfig: { summarizationProvider: 'factory-a', summarizationModel: 'claude-sonnet-5-5' } }); await original.run(); assert.equal(original.seen[0].model, 'claude-sonnet-5-5'); original.dispose();
});
test('native DSH: unavailable selection does not send or replace; enabling it permits retry', { skip }, async () => {
  const f = await setup({ config: { anthropicSummaryModel: 'factory-g/glm-5.3-flash', routes: ['anthropic'] } }); const before = [...f.session.surface.nodes];
  await f.run(); await f.run(); assert.equal(f.seen.length, 0); assert.deepEqual(f.session.surface.nodes, before);
  f.setConfig({ anthropicSummaryModel: 'factory-g/glm-5.3-flash', routes: ['anthropic', 'generic'] }); await f.run(); assert.equal(f.seen.length, 1); f.dispose();
});
test('native DSH: too-small summary context fails before any model request', { skip }, async () => { const f = await setup({ config: { anthropicSummaryModel: 'factory-g/glm-5.3-flash' }, capacities: { 'factory-g/glm-5.3-flash': 16000 } }); const before = [...f.session.surface.nodes]; await f.run(); assert.equal(f.seen.length, 0); assert.deepEqual(f.session.surface.nodes, before); assert.ok(f.diagnostics.some(e => e.code === 'SUMMARY_CONTEXT_TOO_SMALL')); f.dispose(); });
test('native DSH: a verified multimodal compaction model may summarise image history', { skip }, async () => {
  // glm-5.3-flash read a unique four-digit code out of a real image through the
  // generic route, so image-bearing checkpoints may go to it.
  const f = await setup({ image: true, config: { anthropicSummaryModel: 'factory-g/glm-5.3-flash' } });
  await f.run();
  assert.ok(f.seen.length > 0, 'the verified model is allowed to summarise');
  assert.ok(!f.diagnostics.some(e => e.code === 'UNSUPPORTED_SUMMARY_CONTENT'), 'no capability refusal');
  f.dispose();
});

test('native DSH: image history cannot silently go to an unverified generic model', { skip }, async () => {
  // An unverified non-Claude model must still be refused before a full-history
  // call is spent on a checkpoint it may not be able to read.
  const f = await setup({ image: true, config: { anthropicSummaryModel: 'factory-g/kimi-k3' } });
  const before = [...f.session.surface.nodes];
  await f.run();
  assert.equal(f.seen.length, 0);
  assert.deepEqual(f.session.surface.nodes, before);
  assert.ok(f.diagnostics.some(e => e.code === 'UNSUPPORTED_SUMMARY_CONTENT'));
  f.dispose();
});

test('native DSH alignment: Opus and Sonnet 5.5 leave 399999 intact and compact at 400000', { skip }, async () => {
  for (const model of ['claude-opus-5-5','claude-sonnet-5-5']) {
    const below=await setup({pressure:399999,model,output:128000,config:{factoryContextAlignment:true}});
    const before=[...below.session.surface.nodes];await below.run();assert.equal(below.seen.length,0);assert.deepEqual(below.session.surface.nodes,before);assert.equal(below.status.lastBudget.threshold,400000);below.dispose();
    const at=await setup({pressure:400000,model,output:128000,config:{factoryContextAlignment:true}});
    await at.run();assert.equal(at.seen.length,1);assert.equal(at.status.lastBudget.threshold,400000);assert.equal(at.seen[0].maxTokens,4096);assert(at.session.snapshotEvents().some(e=>e.type==='compaction/summary'));await at.run();assert.equal(at.seen.length,1);at.dispose();
  }
});
test('native DSH alignment: GPT and Core trigger at their CLI threshold on generic-only routes', { skip }, async () => {
  for(const [provider,model,threshold,output,route] of [
    ['factory-o','gpt-6-sol',250000,128000,'openai'],
    ['factory-g','glm-5.3-flash',250000,131072,'generic'],
    ['factory-g','inkling',250000,32768,'generic'],
    ['factory-g','nemotron-3-ultra',136464,65536,'generic'],
  ]) {
    const config={factoryContextAlignment:true,routes:[route]};
    const below=await setup({provider,model,pressure:threshold-1,output,config});await below.run();assert.equal(below.seen.length,0);assert.equal(below.status.lastBudget.threshold,threshold);below.dispose();
    const at=await setup({provider,model,pressure:threshold,output,config});await at.run();assert.equal(at.seen.length,1);assert.equal(at.seen[0].model,model);assert.equal(at.status.lastBudget.threshold,threshold);at.dispose();
  }
});
test('native DSH alignment: Haiku uses the actual requested thinking effort', { skip }, async () => {
  for(const [reasoningEffort,threshold] of [['low',153904],['medium',145712],['high',133424]]) {
    const f=await setup({model:'claude-haiku-4-5-20251001',reasoningEffort,output:32000,pressure:threshold-1,config:{factoryContextAlignment:true}});
    await f.run();assert.equal(f.status.lastBudget.threshold,threshold);assert.equal(f.seen.length,0);f.dispose();
  }
});
test('native DSH alignment: lowering custom threshold takes effect; disabling both hooks restores native behavior', { skip }, async () => {
  const f=await setup({pressure:310000,output:128000,config:{factoryContextAlignment:true}});await f.run();assert.equal(f.seen.length,0);
  f.setConfig({factoryContextAlignment:true,opus55CompactionTokens:300000});await f.run();assert.equal(f.seen.length,1);assert.equal(f.status.lastBudget.threshold,300000);f.dispose();
  const g=await setup({pressure:70905,config:{factoryContextAlignment:false,anthropicContextOptimization:false}});await g.run();assert(g.seen.length>0);assert.equal(g.seen[0].maxTokens,65536);g.dispose();
});
test('native DSH alignment: native scoped threshold override can lower the plugin threshold', { skip }, async () => {
  const f=await setup({pressure:199999,output:128000,config:{factoryContextAlignment:true},nativeConfig:{modelPolicies:[{provider:'factory-a',model:'claude-opus-5-5',thresholdRatio:0.2}]}});
  await f.run();assert.equal(f.seen.length,0);assert.equal(f.status.lastBudget.threshold,200000);f.dispose();
});

const oversizedFailure = { code: 'INVALID_REQUEST', message: '413 {"error":{"code":"413","message":"Request Entity Too Large"}}' };
async function recover413(f, failure = oversizedFailure, signal = new AbortController().signal) {
  const { agentEvents } = await host('dsh-agent');
  return agentEvents(f.ctx, f.agent).waterfall('agent/request-error', { failure, signal }, () => 'unhandled');
}
for (const [provider, model] of [['factory-a','claude-sonnet-5-5'], ['factory-a','claude-opus-5-5'], ['factory-g','glm-5.3-flash'], ['factory-o','gpt-6-sol']]) {
  test(`native 413 recovery: ${provider}/${model} compacts below token threshold once`, { skip }, async () => {
    const f = await setup({ provider, model, pressure:112000, output:128000, isolatedCompaction:true, config:{factoryContextAlignment:true} });
    await f.run(); assert.equal(f.seen.length,0);
    const before=[...f.session.surface.nodes], original=JSON.stringify(oversizedFailure);
    assert.deepEqual(await recover413(f),{kind:'retry'});
    assert.equal(f.seen.length,1); assert(f.session.surface.nodes.length<before.length);
    assert.equal(JSON.stringify(oversizedFailure),original);
    assert.equal(await recover413(f),'unhandled'); assert.equal(f.seen.length,1);
    assert(f.diagnostics.some(e=>e.action==='history-compacted'));
    f.dispose(); assert.equal(await recover413(f),'unhandled');
  });
}
test('native 413 recovery: image projection retains originals and newest visual context, then permits one compaction', {skip}, async()=>{
  const f=await setup({pressure:112000,output:128000,isolatedCompaction:true,imageProjection:true,imageEveryStep:true,config:{factoryContextAlignment:true}});
  await f.run(); const before=f.session.snapshotEvents();
  const images=before.filter(e=>e.type==='user/message');
  assert.deepEqual(await recover413(f),{kind:'retry'}); assert.equal(f.seen.length,0);
  assert.equal(f.session.snapshotEvents().filter(e=>e.type==='image/offload').length,1);
  assert.equal(f.session.deriveEventMessage(f.session.eventAt(images[0].seq)).content[1].offloaded,true);
  assert.equal(f.session.deriveEventMessage(f.session.eventAt(images.at(-1).seq)).content[1].offloaded,undefined);
  for(const e of images) assert.deepEqual(f.session.eventAt(e.seq),e);
  assert.deepEqual(await recover413(f),{kind:'retry'}); assert.equal(f.seen.length,1);
  assert.equal(await recover413(f),'unhandled'); assert.equal(f.seen.length,1); f.dispose();
});
test('native 413 recovery: cancellation, opt-out, unrelated errors and providers never alter history', {skip}, async()=>{
  const f=await setup({pressure:112000,isolatedCompaction:true,config:{factoryContextAlignment:true}});await f.run();
  const before=[...f.session.surface.nodes];const controller=new AbortController();controller.abort();
  assert.equal(await recover413(f,oversizedFailure,controller.signal),'unhandled');
  for(const message of ['400 bad request','401 unauthorized','429 rate limit','invalid field 413 value']) assert.equal(await recover413(f,{code:'INVALID_REQUEST',message}),'unhandled');
  f.setConfig({factoryRequestRecovery:false});assert.equal(await recover413(f),'unhandled');assert.deepEqual(f.session.surface.nodes,before);assert.equal(f.seen.length,0);f.dispose();
  const g=await setup({provider:'unrelated-provider',pressure:1000});assert.equal(await recover413(g),'unhandled');assert.equal(g.seen.length,0);g.dispose();
});
test('native summary 413: detached text is reduced, original history and tool definitions stay intact', {skip}, async()=>{
  const f=await setup({pressure:112000,isolatedCompaction:true,config:{factoryContextAlignment:true},streamImpl:async function*(request,count,llm){
    if(count===1) throw new llm.LlmError('413 Request Entity Too Large','INVALID_REQUEST',{status:413});
    yield {type:'block-end',index:0,block:{type:'text',text:'Checkpoint keeps constraints and next actions.'}};yield {type:'finish',reason:{kind:'stop'}};
  }});await f.run();const originals=f.session.snapshotEvents();
  assert.deepEqual(await recover413(f),{kind:'retry'});assert.equal(f.seen.length,2);
  assert(Buffer.byteLength(JSON.stringify(f.seen[1].messages))<Buffer.byteLength(JSON.stringify(f.seen[0].messages)));
  assert.deepEqual(f.seen[1].tools,f.seen[0].tools);assert.deepEqual(f.seen[1].messages[0],f.seen[0].messages[0]);
  assert(f.seen[1].messages.some(m=>m.content.some(b=>b.text?.includes('Middle of long text omitted'))));
  for(const e of originals) assert.deepEqual(f.session.eventAt(e.seq),e);f.dispose();
});
test('native summary 413: image recovery is synchronous, re-prepares projection and commits only a valid smaller summary', {skip}, async()=>{
  const f=await setup({pressure:112000,isolatedCompaction:true,imageProjection:true,imageEveryStep:true,config:{factoryContextAlignment:true},streamImpl:async function*(request,count,llm){
    if(count===1) throw new llm.LlmError('413 Request Entity Too Large','INVALID_REQUEST',{status:413});
    yield {type:'block-end',index:0,block:{type:'text',text:'Image captions and actions retained.'}};yield {type:'finish',reason:{kind:'stop'}};
  }});await f.run();assert.deepEqual(await recover413(f),{kind:'retry'}); // agent image offload
  assert.deepEqual(await recover413(f),{kind:'retry'});assert.equal(f.seen.length,2);
  assert(f.diagnostics.some(e=>e.action==='summary-images-offloaded'));
  assert.equal(f.session.snapshotEvents().filter(e=>e.type==='compaction/summary').length,1);f.dispose();
});
test('native summary 413: persistent rejection stops at three sends with no history replacement', {skip}, async()=>{
  const f=await setup({pressure:112000,isolatedCompaction:true,config:{factoryContextAlignment:true},streamImpl:async function*(request,count,llm){throw new llm.LlmError('413 Request Entity Too Large','INVALID_REQUEST',{status:413});}});
  await f.run();const before=[...f.session.surface.nodes];assert.equal(await recover413(f),'unhandled');
  assert.equal(f.seen.length,3);assert.deepEqual(f.session.surface.nodes,before);
  assert.equal(f.session.snapshotEvents().filter(e=>e.type==='compaction/summary').length,0);
  assert.equal(await recover413(f),'unhandled');assert.equal(f.seen.length,3);f.dispose();
});

test('native end-to-end: oversized main request and summary become smaller requests through the actual gateway', {skip}, async t=>{
  const forwarded=[];
  const gateway=createGateway({gatewayPrefix:'/e2e',resolver:{resolve:async()=>({token:'offline-fixture'})},fetchImpl:async(url,options)=>{
    forwarded.push(Buffer.byteLength(options.body));return new Response('{}',{headers:{'content-type':'application/json'}});
  }});
  const server=http.createServer((req,res)=>{const route=gateway.routes.find(r=>r.path===req.url);void route.handler(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const post=async messages=>{
    const body={model:'claude-sonnet-5-5',max_tokens:32,system:messages.filter(m=>m.role==='system').flatMap(m=>m.content),messages:messages.filter(m=>m.role!=='system')};
    const response=await fetch(`http://127.0.0.1:${server.address().port}/e2e/a/v1/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const text=await response.text();return {status:response.status,text,bytes:Buffer.byteLength(JSON.stringify(body))};
  };
  const f=await setup({model:'claude-sonnet-5-5',pressure:112000,output:128000,isolatedCompaction:true,textRepeat:30000,config:{factoryContextAlignment:true},streamImpl:async function*(request,count,llm){
    const result=await post(request.messages);if(result.status===413)throw new llm.LlmError(`413 ${result.text}`,'INVALID_REQUEST',{status:413});
    assert.equal(result.status,200);yield {type:'block-end',index:0,block:{type:'text',text:'Constraints, current progress, next actions retained.'}};yield {type:'finish',reason:{kind:'stop'}};
  }});
  t.after(f.dispose);(await host('dsh-agent')).agentEvents(f.ctx,f.agent).emit('agent/status',{status:'running'});assert.equal(f.seen.length,0);
  const messages=()=>f.session.surface.nodes.map(seq=>f.session.deriveEventMessage(f.session.eventAt(seq))).filter(Boolean);
  const first=await post(messages());assert.equal(first.status,413);assert(first.bytes>4194304);assert.equal(forwarded.length,0);
  assert.deepEqual(await recover413(f),{kind:'retry'});assert.equal(f.seen.length,2,'oversized summary is bounded before successful mock forwarding');
  const retry=await post(messages());assert.equal(retry.status,200);assert(retry.bytes<first.bytes);assert.equal(forwarded.length,2);assert(forwarded.every(bytes=>bytes<=4194304));
});
