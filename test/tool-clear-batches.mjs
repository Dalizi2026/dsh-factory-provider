import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolClearBatches } from '../lib/tool-clear.js';
const session = 'a'.repeat(64);
const settings = { session, account: 'offline-account', keep: 3, trigger: 20000, batchTokens: 20000, maxInputTokens: 872000 };
const body = count => ({ model: 'claude-sonnet-5-5', system: 'Batch fixture.', tools: [{ name: 'read' }],
  messages: [{ role: 'user', content: 'Begin.' }, ...Array.from({ length: count }, (_, index) => [
    { role: 'assistant', content: [{ type: 'tool_use', id: `id-${index}`, name: 'read', input: { index } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `id-${index}`, content: 'x'.repeat(5000) }] },
  ]).flat()] });
const usage = { input: 4, read: 23290, write: 0, clearedToolUses: 5, clearedInput: 21955 };
function seeded(config = {}) {
  const batches = createToolClearBatches(config), first = batches.plan(body(10), settings);
  batches.commit(first, usage); return batches;
}
test('batch clearing: adding tools preserves the confirmed clearing boundary', () => {
  const batches = seeded();
  const second = batches.plan(body(11), settings);
  assert.equal(second.mode, 'pinned'); assert.equal(second.keep, 6);
  batches.commit(second, { ...usage, read: 27766 });
  const third = batches.plan(body(12), settings);
  assert.equal(third.mode, 'pinned'); assert.equal(third.keep, 7);
});
test('batch clearing: accumulated eligible output releases the boundary as a batch', () => {
  const plan = seeded().plan(body(30), settings);
  assert.equal(plan.mode, 'batch'); assert.equal(plan.keep, 3); assert(plan.addedEligibleTokens >= 20000);
});
test('batch clearing: large non-tool additions release the boundary before capacity pressure', () => {
  const request = body(11); request.messages.push({ role: 'user', content: 'y'.repeat(100000) });
  const plan = seeded().plan(request, settings); assert.equal(plan.mode, 'batch'); assert(plan.estimatedActive > 43000);
});
for (const [label, mutate] of [
  ['edited prefix', request => { request.messages[0].content = 'Changed.'; }],
  ['compacted history', request => { request.messages.splice(0, 2); }],
  ['system changes', request => { request.system = 'Changed.'; }],
  ['tool changes', request => { request.tools.push({ name: 'other' }); }],
]) test(`batch clearing: ${label} cannot reuse the old boundary`, () => {
  const request = body(11); mutate(request); const plan = seeded().plan(request, settings);
  assert(plan === undefined || plan.mode === 'batch');
});
test('batch clearing: accounts, sessions and policy settings are isolated', () => {
  const batches = seeded();
  for (const change of [{ account: 'other' }, { session: 'b'.repeat(64) }, { keep: 4 }, { trigger: 30000 }, { batchTokens: 30000 }])
    assert.equal(batches.plan(body(11), { ...settings, ...change }).mode, 'batch');
  for (const change of [{ session: undefined }, { session: 'unverified' }, { batchTokens: 0 }, { maxInputTokens: undefined }])
    assert.equal(batches.plan(body(11), { ...settings, ...change }), undefined);
});
test('batch clearing: incomplete or duplicate tool pairs are not inferred', () => {
  const batches = seeded(), pending = body(11); pending.messages.pop();
  assert.equal(batches.plan(pending, settings), undefined);
  const duplicate = body(11); duplicate.messages.push(duplicate.messages.at(-1));
  assert.equal(batches.plan(duplicate, settings), undefined);
});
test('batch clearing: unexpected backend statistics stop pinning', () => {
  const batches = seeded(), plan = batches.plan(body(11), settings);
  batches.commit(plan, { ...usage, clearedToolUses: 8 }); assert.equal(batches.size(), 0);
  assert.equal(batches.plan(body(12), settings).mode, 'batch');
});
test('batch clearing: failed/missing editing statistics never establish a boundary', () => {
  const batches = createToolClearBatches();
  for (const failure of [undefined, {}, { ...usage, clearedToolUses: 99 }, { ...usage, input: NaN }]) {
    batches.commit(batches.plan(body(10), settings), failure); assert.equal(batches.size(), 0);
  }
});
test('batch clearing: stale concurrent responses cannot overwrite the newer state', () => {
  const batches = seeded(), left = batches.plan(body(11), settings), right = batches.plan(body(12), settings);
  batches.commit(right, usage); batches.commit(left, { ...usage, clearedToolUses: 6 });
  assert.equal(batches.plan(body(13), settings).keep, 8);
});
test('batch clearing: state expires, is bounded, and is reset on configuration change', () => {
  let time = 0; const batches = seeded({ maxEntries: 1, ttlMs: 100, now: () => time });
  time = 101; assert.equal(batches.plan(body(11), settings).mode, 'batch');
  batches.commit(batches.plan(body(11), { ...settings, account: 'other' }), usage); assert.equal(batches.size(), 1);
  assert.equal(batches.plan(body(11), settings).mode, 'batch'); batches.clear(); assert.equal(batches.size(), 0);
});
test('batch clearing: cache marker movement does not edit the history prefix', () => {
  const request = body(11); request.messages[2].content[0].cache_control = { type: 'ephemeral' };
  assert.equal(seeded().plan(request, settings).mode, 'pinned');
});
test('batch clearing: pinning expires with the actual cache TTL', () => {
  let time = 0; const batches = seeded({ now: () => time });
  time = 300001;
  assert.equal(batches.plan(body(11), { ...settings, cacheTtlMs: 300000 }).mode, 'batch');
  assert.equal(batches.plan(body(11), { ...settings, cacheTtlMs: 3600000 }).mode, 'pinned');
});
