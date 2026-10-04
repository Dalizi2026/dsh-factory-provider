import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(initial, fetch = async () => ({ json: async () => ({ ok: true, value: { rows: [] } }) })) {
  let registration, hook = 0; const state = [...(initial ?? [])], effects = [], timers = new Map(); let timerId = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(value) { const i = hook++; if (!(i in state)) state[i] = typeof value === 'function' ? value() : value;
      return [state[i], next => { state[i] = typeof next === 'function' ? next(state[i]) : next; }]; },
    useEffect(fn) { effects.push(fn); }, useCallback(fn) { return fn; },
    // Real React provides this; FactoryProviderCard keeps the dirty flag in a ref
    // so the poll effect does not re-subscribe on every first edit.
    useRef(initial) { const i = hook++; return state[i] ??= { current: initial }; },
  };
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    .replace('exports.apply = apply;', 'exports.apply = apply; exports.stats = TokenStatsCard; exports.card = FactoryProviderCard;');
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: entry => { registration = entry; } },
    setInterval(fn) { timers.set(++timerId, fn); return timerId; }, clearInterval(id) { timers.delete(id); } }, fetch });
  const components = registration.factory(() => react);
  const props = { t: key => key, routes: { anthropic: { models: [{ id: 'opus', name: 'Opus 5.5 (Factory)' }] } } };
  return { state, effects, timers, render(component = components.stats) {
    hook = 0; effects.length = 0; const tree = component(props), nodes = [];
    function walk(value) { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') { nodes.push(value); walk(value.children); } }
    walk(tree); return { tree, nodes };
  }, components };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('token statistics UI: collapsed by default, no request until expanded', () => {
  const f = fixture(); const { tree } = f.render();
  // The card now goes through the shared collapsible component, so its fold state
  // is remembered. It is still closed on a first visit and inert until opened.
  assert.equal(tree.props.id, 'token-stats');
  assert.ok(!tree.props.defaultOpen, 'closed on a first visit');
  assert.equal(f.effects[0](), undefined); assert.equal(f.timers.size, 0);
  tree.props.onToggle(true); assert.equal(f.state[0], true);
});

test('token statistics UI: five ranges, each model gets the six requested columns and unknown fields show dash', () => {
  const f = fixture([true, 'today', { ok: true, value: { rows: [
    { model: 'opus', input: 10, output: 5, read: 100, write: 20, total: 135 },
    { model: 'unknown-model', input: 200, output: 8, read: 800, write: null, total: 1008, partial: true },
  ] } }, 0]);
  const { nodes } = f.render(), select = nodes.find(n => n.type === 'select');
  assert.deepEqual(select.children.map(n => n.props.value), ['today', '24h', '7d', '30d', 'all']);
  assert.equal(nodes.filter(n => n.type === 'th').length, 6);
  const rows = nodes.find(n => n.type === 'tbody').children;
  assert.deepEqual(rows[0].children.map(n => n.children[0]), ['Opus 5.5', '10', '5', '100', '20', '135']);
  assert.equal(rows[1].children[0].children[0], 'unknown-model'); assert.equal(rows[1].children[4].children[0], '—');
  assert.equal(rows[1].props.title, 'tokenStatsPartial');
  select.props.onChange({ target: { value: '7d' } }); assert.equal(f.state[1], '7d');
  select.props.onChange({ target: { value: 'all' } }); assert.equal(f.state[1], 'all');
  nodes.find(n => n.type === 'button').props.onClick(); assert.equal(f.state[3], 1);
});

test('token statistics UI: switching ranges cancels stale responses; polling stops on collapse', async () => {
  const pending = [];
  const f = fixture([true, 'today'], url => new Promise(resolve => pending.push({ url, resolve })));
  f.render(); const cleanupToday = f.effects[0](); assert.equal(pending.length, 1);
  assert.match(pending[0].url, /range=today&timeZone=/);
  cleanupToday(); f.state[1] = '24h'; f.render(); const cleanup24h = f.effects[0]();
  assert.match(pending[1].url, /range=24h&timeZone=/);
  pending[1].resolve({ json: async () => ({ ok: true, value: { rows: [], range: '24h' } }) }); await tick();
  pending[0].resolve({ json: async () => ({ ok: true, value: { rows: [], range: 'today' } }) }); await tick();
  assert.equal(f.state[2].value.range, '24h'); assert.equal(f.timers.size, 1);
  const { nodes } = f.render(); assert(nodes.some(n => n.children.includes('tokenStatsEmpty')));
  cleanup24h(); f.state[0] = false; f.render(); f.effects[0](); assert.equal(f.timers.size, 0);
});

test('token statistics UI: failed request shows an error and allows refresh', async () => {
  const f = fixture([true, 'today'], async () => { throw new Error('network'); });
  f.render(); const cleanup = f.effects[0](); await tick();
  const { nodes } = f.render(); assert(nodes.some(n => n.children.includes('tokenStatsUnavailable')));
  nodes.find(n => n.type === 'button').props.onClick(); assert.equal(f.state[3], 1); cleanup();
});

test('token statistics UI: new card follows quota and precedes model settings', () => {
  const f = fixture(), { nodes } = f.render(f.components.card);
  const components = nodes.filter(n => typeof n.type === 'function').map(n => n.type.name);
  assert.equal(components[components.indexOf('QuotaCard') + 1], 'TokenStatsCard');
  assert(components.indexOf('TokenStatsCard') < components.indexOf('CollapsibleCard'));
});

test('token statistics UI: numbers are compacted so six columns fit', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  // The table used to have min-width 650px and print 1,296,384, which pushed the
  // last columns outside the settings panel.
  assert.ok(!/\.fp-tokenTable\{min-width:650px\}/.test(src), 'the 650px floor is gone');
  assert.ok(src.includes('.fp-tokenTable{width:100%;table-layout:auto}'), 'the table fits its panel');
  const at = src.indexOf('const compact = (value) => {');
  assert.ok(at > 0, 'there is a compact formatter');
  const compact = eval(`(${src.slice(at, src.indexOf('const exact =', at)).replace('const compact = ', '').replace(/;\s*$/, '')})`);
  assert.equal(compact(3537), '3,537', 'small counts stay exact');
  assert.equal(compact(14060), '14.1K');
  assert.equal(compact(1296384), '1.3M');
  assert.equal(compact(12345678), '12.3M');
  assert.equal(compact(99999), '100K', 'rounding does not leave a trailing .0');
  assert.equal(compact(null), '—', 'an unreported field is not shown as zero');
  assert.equal(compact(undefined), '—');
  // The exact number stays reachable on hover.
  assert.match(src, /title: exact\(row\[field\]\)/);
});

test('token statistics UI: the fold state is remembered per card', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes('dsh-factory-provider.cardOpen'), 'one storage key holds every card');
  assert.match(src, /function storedCardOpen\(id, fallback\)/, 'the stored value is read back');
  assert.match(src, /typeof saved === "boolean" \? saved : fallback/, 'only a real boolean wins over the default');
  assert.match(src, /writeStored\(CARD_OPEN_KEY/, 'a toggle is persisted');
  // Every card that can fold must carry an id, or it would forget.
  for (const id of ['connection', 'quota', 'accounts', 'context', 'models', 'advanced', 'token-stats']) {
    assert.ok(src.includes('id: "' + id + '"'), id + ' is remembered');
  }
});
