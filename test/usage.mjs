import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenUsageStore, tokenStatsWindow, createTokenStatsHandler, tokenUsageDirectory } from '../lib/usage.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-05T04:00:00Z');
function fixture(t, initial = NOW) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-stats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = initial;
  const options = { directory: path.join(root, 'usage'), legacyPath: path.join(root, 'journal.jsonl'), now: () => clock };
  return { ...options, root, store: createTokenUsageStore(options), advance: ms => { clock += ms; }, restart: () => createTokenUsageStore(options) };
}
const event = (id, ms = NOW, model = 'opus', counts = {}) => ({ t: new Date(ms).toISOString(), event: 'usage', requestId: id, model,
  input: 10, output: 5, read: 100, write: 20, ...counts });
const read = (store, range = '30d') => store.read({ range, timeZone: 'Asia/Shanghai' });

test('token statistics: local today differs from rolling 24 hours; DST uses local midnight', () => {
  assert.equal(tokenStatsWindow('today', 'Asia/Shanghai', NOW).start, Date.parse('2026-10-04T16:00:00Z'));
  assert.equal(tokenStatsWindow('24h', 'Asia/Shanghai', NOW).start, NOW - DAY);
  const dst = Date.parse('2026-03-09T03:59:59.999Z');
  assert.equal(tokenStatsWindow('today', 'America/New_York', dst).start, Date.parse('2026-03-08T05:00:00Z'));
  assert.equal(tokenStatsWindow('24h', 'America/New_York', dst).start, dst - DAY);
  assert.throws(() => tokenStatsWindow('year', 'Asia/Shanghai', NOW), RangeError);
  assert.throws(() => tokenStatsWindow('7d', 'not-a-zone', NOW), RangeError);
});

test('token statistics: five windows filter exact boundaries and retain older history for all-time totals', t => {
  const f = fixture(t);
  [0, 12 * 3600000, DAY, 7 * DAY, 30 * DAY].forEach((age, i) => f.store.record(event(String(i), NOW - age)));
  assert.equal(f.store.record(event('older', NOW - 30 * DAY - 1)), true);
  assert.equal(f.store.record(event('future', NOW + 1)), false);
  for (const [range, expected] of [['today', 2], ['24h', 3], ['7d', 4], ['30d', 5], ['all', 6]]) {
    const data = read(f.store, range); assert.equal(data.rows[0].requests, expected); assert.equal(data.rows[0].total, expected * 135);
  }
});

test('token statistics: models aggregate separately, unknown fields stay unknown, duplicates do not add', t => {
  const f = fixture(t);
  assert.equal(f.store.record(event('one')), true); assert.equal(f.store.record(event('one')), false);
  f.store.record(event('two', NOW, 'opus', { input: 0, write: null }));
  f.store.record(event('three', NOW, 'glm', { input: 200, output: 8, read: 800, write: null }));
  const [glm, opus] = read(f.store).rows;
  assert.deepEqual(glm, { model: 'glm', input: 200, output: 8, read: 800, write: null, total: 1008, requests: 1, partial: true });
  assert.deepEqual(opus, { model: 'opus', input: 10, output: 10, read: 200, write: 20, total: 240, requests: 2, partial: true });
  assert.equal(f.store.record(event('bad', NOW, 'bad', { input: -1, output: NaN, read: '20', write: null })), false);
  f.store.record(event('ttl', NOW, 'ttl', { write: null, write5m: 50, write1h: 60 }));
  assert.equal(read(f.store).rows.find(row => row.model === 'ttl').write, 110);
});

test('token statistics: durable import occurs once, survives journal clearing and restart, stores no content', t => {
  const f = fixture(t), older = event('older', NOW - DAY);
  fs.writeFileSync(f.legacyPath, [older, older, event('older-history', NOW - 31 * DAY), { event: 'forward', key: 'secret' },
    { ...event('new'), prompt: 'private prompt', response: 'private reply', key: 'private key' }].map(JSON.stringify).join('\n') + '\ninvalid\nnull\n[]\n');
  let data = read(f.store); assert.equal(data.importedRecords, 3); assert.equal(data.rows[0].requests, 2);
  assert.equal(data.availableSince, new Date(NOW - 31 * DAY).toISOString());
  assert.equal(read(f.store, 'all').rows[0].requests, 3);
  fs.writeFileSync(f.legacyPath, ''); f.store.record(event('after'));
  data = read(f.restart()); assert.equal(data.rows[0].requests, 3); assert.equal(data.importedRecords, 3);
  assert.equal(read(f.restart(), 'all').rows[0].requests, 4);
  const persisted = fs.readdirSync(f.directory).map(name => fs.readFileSync(path.join(f.directory, name), 'utf8')).join('');
  assert.doesNotMatch(persisted, /private|secret|prompt|response/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(f.directory)) assert.equal(fs.statSync(path.join(f.directory, name)).mode & 0o777, 0o600);
  }
});

test('token statistics: no-id legacy entries have deterministic deduplication, empty ids are not shared', t => {
  const f = fixture(t); const first = event('', NOW, 'opus'), second = event('', NOW - 1, 'sonnet');
  delete first.requestId;
  fs.writeFileSync(f.legacyPath, [first, first, second].map(JSON.stringify).join('\n'));
  assert.equal(read(f.store).rows.reduce((n, row) => n + row.requests, 0), 2);
});

test('token statistics: malformed rows are skipped; 30-day filtering and restart never delete older data', t => {
  const f = fixture(t); f.store.record(event('keep'));
  fs.appendFileSync(path.join(f.directory, '2026-10-05.jsonl'), '\ninvalid\nnull\n[]\n');
  fs.writeFileSync(path.join(f.directory, 'notes.txt'), 'keep');
  assert.equal(read(f.store).rows[0].requests, 1);
  f.advance(31 * DAY); assert.equal(read(f.store).rows.length, 0);
  assert.equal(fs.existsSync(path.join(f.directory, '2026-10-05.jsonl')), true);
  assert.equal(fs.existsSync(path.join(f.directory, 'notes.txt')), true);
  f.store.record(event('fresh', NOW + 31 * DAY)); assert.equal(read(f.restart()).rows[0].requests, 1);
  const all = read(f.restart(), 'all'); assert.equal(all.rows[0].requests, 2); assert.equal(all.rows[0].total, 270);
  assert.equal(all.retentionDays, null); assert.equal(all.availableSince, new Date(NOW).toISOString());
  f.advance(365 * DAY); assert.equal(read(f.restart(), 'all').rows[0].requests, 2);
});

test('token statistics: handler validates requests and hides filesystem error details', t => {
  const f = fixture(t); f.store.record(event('request'));
  const invoke = (handler, method, query = '') => {
    let result;
    handler({ method, url: '/api/dsh-factory-provider/token-stats' + query }, { capture(status, body) { result = { status, body }; } });
    return result;
  };
  const handler = createTokenStatsHandler({ read: options => f.store.read(options), reply: (res, status, body) => res.capture(status, body) });
  for (const method of ['GET', 'HEAD']) {
    const r = invoke(handler, method, '?range=7d&timeZone=Asia%2FShanghai');
    assert.equal(r.status, 200); assert.equal(r.body.value.rows[0].total, 135); assert.equal(r.body.value.range, '7d');
  }
  assert.equal(invoke(handler, 'POST').status, 405);
  assert.equal(invoke(handler, 'GET', '?range=year').status, 400);
  assert.equal(invoke(handler, 'GET', '?timeZone=bad').status, 400);
  fs.writeFileSync(path.join(f.directory, 'metadata.json'), '{"schema":1,"availableSince":"bad","imported":0}');
  const broken = createTokenStatsHandler({ read: options => f.restart().read(options), reply: (res, status, body) => res.capture(status, body) });
  const r = invoke(broken, 'GET'); assert.equal(r.status, 500); assert.doesNotMatch(JSON.stringify(r.body), /factory-stats-|metadata/);
});

test('token statistics: storage override isolates test journals and default stays outside the package', () => {
  const saved = { journal: process.env.DSH_FACTORY_JOURNAL, directory: process.env.DSH_FACTORY_USAGE_DIR };
  try {
    delete process.env.DSH_FACTORY_USAGE_DIR; process.env.DSH_FACTORY_JOURNAL = '/tmp/test-journal';
    assert.equal(tokenUsageDirectory(), '/tmp/test-journal.usage');
    process.env.DSH_FACTORY_USAGE_DIR = '/tmp/custom-statistics'; assert.equal(tokenUsageDirectory(), '/tmp/custom-statistics');
    delete process.env.DSH_FACTORY_USAGE_DIR; delete process.env.DSH_FACTORY_JOURNAL;
    assert.equal(tokenUsageDirectory(), path.join(os.homedir(), '.dsh-factory-provider', 'token-usage'));
  } finally {
    for (const [key, value] of [['DSH_FACTORY_JOURNAL', saved.journal], ['DSH_FACTORY_USAGE_DIR', saved.directory]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
