import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FACTORY_MODEL_LIMITS, FACTORY_LIMITS_VERSION, factoryModelLimits, clampFactoryOutputTokens } from '../lib/model-limits.js';
import { ROUTES, buildModelEntries } from '../lib/catalog.js';
import { alignedCompactionBudget } from '../lib/context.js';
const evidence = JSON.parse(fs.readFileSync(new URL('./fixtures/droid-0.233.0-budgets.json', import.meta.url)));

test('limits: all 38 models match the independently collected CLI snapshot', () => {
  assert.equal(FACTORY_LIMITS_VERSION, evidence.version);
  assert.equal(Object.keys(FACTORY_MODEL_LIMITS).length, 38);
  for (const expected of evidence.models) {
    const l = factoryModelLimits(expected.provider, expected.id, 'off');
    assert.equal(l.maxInputTokens, expected.maxInputTokens, expected.id);
    assert.equal(l.maxOutputTokens, expected.maxOutputTokens, expected.id);
    assert.equal(l.defaultCompactionLimit, expected.threshold, expected.id);
    const model = Object.values(ROUTES).flatMap(r=>r.models).find(m=>m.id===expected.id);
    assert.equal(model.maxTokens, expected.maxOutputTokens, expected.id);
    if (expected.explicitTotal) assert.equal(model.contextWindow, expected.explicitTotal, expected.id);
  }
});
test('limits: profiles keep per-model budgets and region gates, without unknown SDK fields', () => {
  for (const route of Object.keys(ROUTES)) {
    for (const e of buildModelEntries(route)) {
      const l = FACTORY_MODEL_LIMITS[e.id];
      assert.equal(e.contextWindow, l.contextWindow); assert.equal(e.maxTokens, l.maxOutputTokens);
      assert(!Object.hasOwn(e, 'maxInputTokens')); assert(!Object.hasOwn(e, 'defaultCompactionLimit'));
    }
  }
  assert(!buildModelEntries('anthropic').some(m=>m.id==='claude-opus-5-5-fast'));
  assert.equal(FACTORY_MODEL_LIMITS['claude-opus-4-8'].capacityKind,'cli-budget-envelope');
});
test('limits: Haiku changes with effort and an unknown effort chooses the conservative budget', () => {
  const id='claude-haiku-4-5-20251001';
  for(const [e,input] of Object.entries({off:180000,low:153904,medium:145712,high:133424})) {
    assert.equal(factoryModelLimits('factory-a',id,e).maxInputTokens,input);
  }
  assert.equal(factoryModelLimits('factory-a',id).maxInputTokens,133424);
  assert.equal(factoryModelLimits('factory-a',id,'unsupported').maxInputTokens,133424);
});
test('limits: unknown model or mismatched provider never receives another model budget', () => {
  assert.equal(factoryModelLimits('factory-g','claude-opus-5-5'),undefined);
  assert.equal(factoryModelLimits('other-provider','gpt-6-sol'),undefined);
  assert.equal(factoryModelLimits('factory-a','unknown'),undefined);
});
test('limits: 400K overrides apply without raising the CLI input budget', () => {
  const limits=factoryModelLimits('factory-a','claude-opus-5-5');
  assert.deepEqual(alignedCompactionBudget({limits,contextWindow:1000000,maxTokens:128000,thresholdTokens:400000}),{threshold:400000,target:260000,inputBudget:872000});
  assert.equal(alignedCompactionBudget({limits,contextWindow:1000000,maxTokens:64000,thresholdTokens:999999}).threshold,872000);
  assert.equal(alignedCompactionBudget({limits,contextWindow:200000,maxTokens:128000,thresholdTokens:400000}).threshold,72000);
  assert.equal(alignedCompactionBudget({limits,contextWindow:1000000,maxTokens:800000,thresholdTokens:400000}).threshold,200000);
  assert.throws(()=>alignedCompactionBudget({limits,contextWindow:128000,maxTokens:128000,thresholdTokens:400000}),/safe input budget/);
});
test('limits: each remaining model uses its CLI threshold with its own output reserve', () => {
  for(const e of evidence.models) {
    if(['claude-opus-5-5','claude-sonnet-5-5','claude-haiku-4-5-20251001'].includes(e.id))continue;
    const l=factoryModelLimits(e.provider,e.id);
    assert.equal(alignedCompactionBudget({limits:l,contextWindow:l.contextWindow,maxTokens:l.maxOutputTokens,thresholdTokens:l.defaultCompactionLimit}).threshold,e.threshold,e.id);
  }
});
test('limits: output ceilings preserve smaller requests and apply to each wire protocol', () => {
  for(const [provider,model,field,cap] of [
    ['factory-a','claude-opus-5-5','max_tokens',128000],
    ['factory-o','gpt-6-sol','max_output_tokens',128000],
    ['factory-g','inkling','max_tokens',32768],
    ['factory-g','kimi-k3','max_completion_tokens',65536],
  ]) {
    const payload={model,[field]:1000000};clampFactoryOutputTokens(provider,payload);assert.equal(payload[field],cap);
    payload[field]=16;clampFactoryOutputTokens(provider,payload);assert.equal(payload[field],16);
    delete payload[field];clampFactoryOutputTokens(provider,payload);assert(!Object.hasOwn(payload,field));
  }
  const p={model:'custom',max_tokens:200000};clampFactoryOutputTokens('factory-a',p);assert.equal(p.max_tokens,200000);
});
