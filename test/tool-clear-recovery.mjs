import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../lib/gateway.js';
import { FACTORY_REQUEST_PURPOSE_HEADER, FACTORY_REQUEST_SESSION_HEADER } from '../lib/request-purpose.js';
import { readJournal } from '../lib/journal.js';
process.env.DSH_FACTORY_JOURNAL = path.join(os.tmpdir(), `factory-clear-recovery-${process.pid}.jsonl`);
const BETA = 'context-management-2025-06-27';
const BODY = { model: 'claude-sonnet-5-5', max_tokens: 64,
  messages: [{ role: 'user', content: 'Local regression fixture.' }] };
async function fixture(t, config = {}, respond) {
  const seen = []; let resolves = 0, refreshes = 0;
  const gateway = createGateway({ gatewayPrefix: '/fixture', enabledRoutes: ['anthropic'],
    resolver: { resolve: async () => { resolves++; return { token: 'offline-fixture' }; },
      forceRefresh: async () => { refreshes++; return { token: 'offline-refreshed' }; } },
    ...config, fetchImpl: async (_url, init) => {
      seen.push({ body: JSON.parse(init.body), wire: init.body, headers: init.headers });
      return respond?.(seen.at(-1), seen.length) ?? new Response('{}', { headers: { 'content-type': 'application/json' } });
    } });
  const server = http.createServer((req, res) => { void gateway.routes.find(route => route.path === req.url).handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { seen, gateway, counters: () => ({ resolves, refreshes }),
    async send(body = BODY, headers = {}) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/fixture/a/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
      await res.text(); return res.status;
    } };
}
test('clear recovery: 401 retains identical prepared body and required betas on retry', async t => {
  const f = await fixture(t, { toolClear: true }, (sent, count) => {
    if (count === 1) return new Response('{}', { status: 401 });
    return new Response('{}', { status: sent.headers['anthropic-beta']?.includes(BETA) ? 200 : 400 });
  });
  assert.equal(await f.send(BODY, { 'anthropic-beta': `existing-beta, ${BETA}` }), 200);
  assert.equal(f.seen.length, 2); assert.equal(f.seen[0].wire, f.seen[1].wire);
  for (const sent of f.seen) {
    assert.equal(sent.body.context_management.edits.length, 1);
    assert.equal(sent.headers['anthropic-beta'].split(',').filter(v => v === BETA).length, 1);
    assert(sent.headers['anthropic-beta'].includes('existing-beta'));
  }
  assert.deepEqual(f.counters(), { resolves: 1, refreshes: 1 });
});
test('clear recovery: beta is generated again when the original caller sent no beta', async t => {
  const f = await fixture(t, { toolClear: true }, (sent, count) => new Response('{}', {
    status: count === 1 ? 401 : sent.headers['anthropic-beta'] === BETA ? 200 : 400,
  }));
  assert.equal(await f.send(), 200); assert.equal(f.seen[1].headers['anthropic-beta'], BETA);
});
test('clear recovery: inserted policy is included in final UTF-8 budget before credentials', async t => {
  const off = await fixture(t); assert.equal(await off.send(), 200);
  const exactLimit = Buffer.byteLength(off.seen[0].wire);
  const on = await fixture(t, { toolClear: true, requestMaxBytes: exactLimit });
  assert.equal(await on.send(), 413); assert.equal(on.seen.length, 0);
  assert.deepEqual(on.counters(), { resolves: 0, refreshes: 0 });
});
test('clear recovery: summary purpose suppresses only automatic policy; header never reaches upstream', async t => {
  const f = await fixture(t, { toolClear: true });
  assert.equal(await f.send(BODY, { [FACTORY_REQUEST_PURPOSE_HEADER]: 'compaction' }), 200);
  assert.equal(f.seen[0].body.context_management, undefined);
  assert.equal(f.seen[0].headers[FACTORY_REQUEST_PURPOSE_HEADER], undefined);
  assert.equal(f.seen[0].headers['anthropic-beta'], undefined);
  assert.equal(await f.send(), 200); assert.equal(f.seen[1].body.context_management.edits.length, 1);
  const mine = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
  assert.equal(await f.send({ ...BODY, context_management: mine }, { [FACTORY_REQUEST_PURPOSE_HEADER]: 'compaction' }), 200);
  assert.deepEqual(f.seen[2].body.context_management, mine); assert.equal(f.seen[2].headers['anthropic-beta'], BETA);
});
test('clear recovery: no selected policy means no editing body/header by default', async t => {
  const f = await fixture(t); assert.equal(await f.send(), 200);
  assert.equal(f.seen[0].body.context_management, undefined); assert.equal(f.seen[0].headers['anthropic-beta'], undefined);
});
test('clear diagnostics: streaming edits are counted once without recording cleared content', async t => {
  const edit = { context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919',
    cleared_tool_uses: 8, cleared_input_tokens: 35001, private_content: 'DO-NOT-LOG-THIS-FIXTURE' }] } };
  const f = await fixture(t, {}, () => new Response([
    { type: 'message_start', message: { usage: { input_tokens: 82, cache_read_input_tokens: 14620, cache_creation_input_tokens: 4513 } } },
    { type: 'message_delta', usage: { output_tokens: 81 }, ...edit },
    { type: 'message_delta', ...edit },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(await f.send(), 200);
  const usage = readJournal(100).filter(row => row.event === 'usage').at(-1);
  assert.deepEqual(usage.contextEditing, { clearedToolUses: 8, clearedInputTokens: 35001 });
  assert.equal(usage.read, 14620); assert.equal(usage.write, 4513); assert.equal(usage.output, 81);
  assert(!JSON.stringify(readJournal(100)).includes('DO-NOT-LOG-THIS-FIXTURE'));
});
function batchBody(count) {
  return { ...BODY, messages: [{ role: 'user', content: 'Begin.' }, ...Array.from({ length: count }, (_, index) => [
    { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${index}`, name: 'read', input: { index } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${index}`, content: 'x'.repeat(5000) }] },
  ]).flat()] };
}
test('batch gateway: non-streaming statistics establish a stable boundary; local metadata is not forwarded', async t => {
  const f = await fixture(t, { toolClear: true }, () => new Response(JSON.stringify({ usage: {
    input_tokens: 4, cache_read_input_tokens: 23290, cache_creation_input_tokens: 0, output_tokens: 4,
  }, context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: 5, cleared_input_tokens: 21955 }] } }),
  { headers: { 'content-type': 'application/json' } }));
  const headers = { [FACTORY_REQUEST_SESSION_HEADER]: 'a'.repeat(64) };
  for (let count = 10; count <= 12; count++) {
    assert.equal(await f.send(batchBody(count), headers), 200);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(f.seen.map(row => row.body.context_management.edits[0].keep.value), [3,6,7]);
  for (const sent of f.seen) {
    assert.equal(sent.body.context_management.edits[0].clear_at_least.value, 20000);
    assert.equal(sent.headers[FACTORY_REQUEST_SESSION_HEADER], undefined);
  }
  assert(readJournal(100).some(row => row.event === 'tool-clear-batch' && row.mode === 'pinned'));
});
test('batch gateway: explicit strategy and summary requests remain outside automatic batching', async t => {
  const f = await fixture(t, { toolClear: true });
  const headers = { [FACTORY_REQUEST_SESSION_HEADER]: 'a'.repeat(64), [FACTORY_REQUEST_PURPOSE_HEADER]: 'compaction' };
  assert.equal(await f.send(batchBody(10), headers), 200); assert.equal(f.seen[0].body.context_management, undefined);
  const policy = { edits: [{ type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 2 } }] };
  assert.equal(await f.send({ ...batchBody(10), context_management: policy }, headers), 200);
  assert.deepEqual(f.seen[1].body.context_management, policy);
});
test('batch gateway: streaming statistics pin the next request and disabling the batch restores the original policy', async t => {
  const f = await fixture(t, { toolClear: true }, () => new Response([
    { type: 'message_start', message: { usage: { input_tokens: 4, cache_read_input_tokens: 23290, cache_creation_input_tokens: 0 } } },
    { type: 'message_delta', usage: { output_tokens: 4 }, context_management: { applied_edits: [
      { type: 'clear_tool_uses_20250919', cleared_tool_uses: 5, cleared_input_tokens: 21955 } ] } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
  const headers = { [FACTORY_REQUEST_SESSION_HEADER]: 'a'.repeat(64) };
  assert.equal(await f.send(batchBody(10), headers), 200);
  assert.equal(await f.send(batchBody(11), headers), 200);
  assert.equal(f.seen[1].body.context_management.edits[0].keep.value, 6);
  f.gateway.configure({ toolClearBatchTokens: 0 }); assert.equal(await f.send(batchBody(12), headers), 200);
  assert.equal(f.seen[2].body.context_management.edits[0].keep.value, 3);
  assert.equal(f.seen[2].body.context_management.edits[0].clear_at_least, undefined);
});
test('batch gateway: a larger pinned keep value is checked against the final byte budget', async t => {
  const headers = { [FACTORY_REQUEST_SESSION_HEADER]: 'a'.repeat(64) };
  const baseline = await fixture(t, { toolClear: true }); assert.equal(await baseline.send(batchBody(15), headers), 200);
  const limit = Buffer.byteLength(baseline.seen[0].wire);
  const f = await fixture(t, { toolClear: true }, () => new Response(JSON.stringify({ usage: {
    input_tokens: 4, cache_read_input_tokens: 23290, cache_creation_input_tokens: 0,
  }, context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: 5, cleared_input_tokens: 21955 }] } }),
  { headers: { 'content-type': 'application/json' } }));
  assert.equal(await f.send(batchBody(10), headers), 200); await new Promise(resolve => setImmediate(resolve));
  f.gateway.configure({ requestMaxBytes: limit });
  assert.equal(await f.send(batchBody(15), headers), 413); assert.equal(f.seen.length, 1);
});
test.after(() => { try { fs.unlinkSync(process.env.DSH_FACTORY_JOURNAL); } catch {} });
