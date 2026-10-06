import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function render(config, which = 'config') {
  let registration;
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    .replace('exports.apply = apply;', 'exports.apply = apply; exports.testConfigCard = ConfigCard; exports.testContextCard = ContextCard;');
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: entry => { registration = entry; } } } });
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const component = registration.factory(() => react)[which === 'context' ? 'testContextCard' : 'testConfigCard'];
  const changes = [];
  const tree = component({ t: key => key, config, routes: {
    anthropic: { providerKey: 'factory-a', models: [{ id: 'opus', name: 'Opus' }] },
    generic: { providerKey: 'factory-g', models: [{ id: 'glm-5.3-flash', name: 'GLM Flash', cost: '0.06x' }] },
    openai: { providerKey: 'factory-o', models: [{ id: 'gpt', name: 'GPT' }] },
  }, dirty: false, saving: false, saved: false, onSave: () => {}, onDiscard: () => {},
  patchConfig: (field, value) => changes.push({ field, value }) });
  const nodes = [];
  function walk(node) { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; nodes.push(node); node.children?.forEach(walk); }
  walk(tree);
  return { nodes, changes };
}

test('context UI: summary selector lists enabled visible models and emits a model change', () => {
  const f = render({ routes: ['anthropic', 'generic'], modelAllowlist: ['opus', 'glm-5.3-flash'] }, 'context');
  const select = f.nodes.find(node => node.type === 'select');
  const options = select.children.flat().filter(node => node?.type === 'option');
  assert.deepEqual(options.map(node => node.props.value), ['', 'factory-a/opus', 'factory-g/glm-5.3-flash']);
  select.props.onChange({ target: { value: 'factory-g/glm-5.3-flash' } });
  assert.deepEqual(f.changes, [{ field: 'anthropicSummaryModel', value: 'factory-g/glm-5.3-flash' }]);
});
test('context UI: unavailable selection stays visible, optimization checkbox sends a boolean', () => {
  const f = render({ routes: ['anthropic'], anthropicSummaryModel: 'factory-g/glm-5.3-flash' }, 'context');
  assert.ok(f.nodes.some(node => node.type === 'option' && node.props.value === 'factory-g/glm-5.3-flash' && node.props.disabled));
  const checkbox = f.nodes.find(node => node.type === 'label' && node.children.includes('configContextOptimization')).children[0];
  checkbox.props.onChange({ target: { checked: false } });
  assert.deepEqual(f.changes, [{ field: 'anthropicContextOptimization', value: false }]);
});

test('context UI: alignment can be switched and thresholds live in the Models card', () => {
  const f=render({routes:['anthropic']},'context');
  const toggle=f.nodes.find(n=>n.type==='label'&&n.children.includes('configContextAlignment')).children[0];
  assert.equal(toggle.props.checked,true);toggle.props.onChange({target:{checked:false}});
  assert.deepEqual(f.changes,[{field:'factoryContextAlignment',value:false}]);
  assert(!f.nodes.some(n=>n.type==='input'&&[872000,904504].includes(n.props.max)));
});

test('request recovery UI: switch and byte budget are editable',()=>{
 const f=render({routes:['anthropic']});const toggle=f.nodes.find(n=>n.type==='label'&&n.children.includes('configRequestRecovery')).children[0];
 assert.equal(toggle.props.checked,true);toggle.props.onChange({target:{checked:false}});
 const budget=f.nodes.find(n=>n.type==='input'&&n.props.max===33554432);assert.equal(budget.props.value,'4194304');budget.props.onChange({target:{value:'0'}});
 assert.deepEqual(f.changes,[{field:'factoryRequestRecovery',value:false},{field:'factoryRequestMaxBytes',value:'0'}]);
});

test('image UI: adaptive compression defaults on and emits a boolean setting',()=>{
 const f=render({routes:['anthropic']});const toggle=f.nodes.find(n=>n.type==='label'&&n.children.includes('configAdaptiveImages')).children[0];
 assert.equal(toggle.props.checked,true);toggle.props.onChange({target:{checked:false}});assert.deepEqual(f.changes,[{field:'factoryAdaptiveImages',value:false}]);
});

test('quota float: registered on the overlay slot, gated by a config field', () => {
  // The window is registered on shell.overlay like the reference plugin, but its
  // visibility comes from the plugin config so it can be toggled without a page
  // reload, and it is off by default.
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(src, /ctx\.slots\.inject\("shell\.overlay"/, 'registered on the overlay slot');
  assert.match(src, /name: "shell\.overlay", id: "factory-provider-quota"/);
  assert.match(src, /if \(!enabled \|\| dismissed\) return null;/, 'renders nothing while disabled or dismissed');
  assert.match(src, /setDismissed\(true\)/, 'the close button hides it');
  assert.match(src, /floatClose/, 'close label exists');
  assert.match(src, /configRes\?\.value\?\.config\?\.quotaFloat === true/, 'visibility read from the live config');
  assert.match(src, /FLOAT_POS_KEY/, 'position persisted');
  // The ring moved into its own component during the restyle.
  assert.match(src, /onDoubleClick: onExpand/, 'the ring wires double-click to expand');
  assert.match(src, /onExpand: \(\) => setCollapsed\(false\)/, 'double-click expands');
  // Visual parity with the reference card.
  assert.match(src, /fp-fill-danger\{background:linear-gradient/, 'gradient bars');
  assert.match(src, /@keyframes fp-pulse/, 'pulsing status dot');
  assert.match(src, /fp-ring-danger/, 'gradient ring stroke');
  assert.match(src, /后重置/, 'reset countdown');
  assert.match(src, /floatRefresh/, 'refresh action');
  const index = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(index, /quotaFloat: z\.boolean\(\)\.default\(false\)/, 'defaults to off');
  const yaml = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(yaml, /quotaFloat: false/, 'shipped default matches');
});

test('quota float: takes t as a prop and is registered through a wrapper', () => {
  // It used to call the free variable t from module scope, so every render threw
  // ReferenceError and ticking the box did nothing.
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(src, /function QuotaFloat\(\{ t \}\)/, 't comes from props');
  assert.match(src, /react\.createElement\(QuotaFloat, \{ t \}\)/, 'registration passes t explicitly');
  assert.ok(!/id: "factory-provider-quota", order: 10, inject:/.test(src), 'no longer relies on slot inject');
});

test('quota float: the toggle lives in the quota card, not the advanced card', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const quotaCard = src.slice(src.indexOf('function QuotaCard'), src.indexOf('function AccountsCard'));
  assert.match(quotaCard, /patchConfig\("quotaFloat"/, 'toggle rendered inside QuotaCard');
  const configCard = src.slice(src.indexOf('function ConfigCard'), src.indexOf('function JournalCard'));
  assert.ok(!configCard.includes('quotaFloat'), 'and gone from ConfigCard');
  assert.match(src, /createElement\(QuotaCard, \{ t, quota, onRefresh: refreshQuota, config, patchConfig \}\)/, 'props passed at the call site');
});

test('tool clear: UI exposes the switch and both parameters', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(src, /patchConfig\("anthropicToolClear"/, 'checkbox wired');
  assert.match(src, /patchConfig\("anthropicToolClearKeep"/);
  assert.match(src, /patchConfig\("anthropicToolClearTrigger"/);
  assert.match(src, /"anthropicToolClear", "anthropicToolClearKeep", "anthropicToolClearTrigger"/, 'fields are saved');
  const index = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(index, /anthropicToolClear: z\.boolean\(\)\.default\(false\)/, 'user opts in');
  const yaml = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(yaml, /anthropicToolClear: false/);
  // Controls belong in ContextCard, not the collapsed Advanced card.
  const context = src.slice(src.indexOf('function ContextCard'), src.indexOf('function ConfigCard'));
  assert.match(context, /patchConfig\("anthropicToolClear"/, 'switch is in ContextCard');
  const cfg = src.slice(src.indexOf('function ConfigCard'), src.indexOf('function JournalCard'));
  assert.ok(!cfg.includes("anthropicToolClear"), 'and gone from ConfigCard');
});

test('settings: cost settings live in one visible card, not the collapsed one', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const card = src.slice(src.indexOf('function ConfigCard'), src.indexOf('function JournalCard'));
  const order = [...card.matchAll(/t\("(section[A-Za-z]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(
    order,
    ['sectionConnection', 'sectionCache', 'sectionRequests', 'sectionOther'],
    'the Advanced card keeps the non-context groups, in order',
  );
  // Everything that decides what a turn costs sits in ContextCard, which is
  // rendered at the top level rather than inside the collapsed Advanced card.
  const context = src.slice(src.indexOf('function ContextCard'), src.indexOf('function ConfigCard'));
  for (const field of [
    'anthropicToolClear', 'anthropicToolClearKeep', 'anthropicToolClearTrigger', 'anthropicToolClearBatchTokens',
    'factoryContextAlignment',
    'anthropicContextOptimization', 'anthropicSummaryModel', 'anthropicSummaryMaxTokens',
    'anthropicCompactionHeadroomTokens',
  ]) {
    assert.ok(context.includes(field), `${field} is in ContextCard`);
    assert.ok(!card.includes(field), `${field} is gone from ConfigCard`);
  }
  // Both cards can save, so the moved settings are not unreachable.
  assert.match(context, /createElement\(SaveBar,/, 'ContextCard has its own save bar');
  assert.match(card, /createElement\(SaveBar,/, 'ConfigCard still has one');
  // The summary dropdown must keep filtering by enabled route and allowlist.
  assert.match(context, /routesEnabled\.includes\(route\)/, 'still filters by enabled route');
  assert.match(context, /modelAllowlist\.includes\(model\.id\)/, 'still filters by allowlist');
  // Hints stay short enough to read at a glance.
  const zh = src.slice(src.indexOf('const zh = {'), src.indexOf('const en = {'));
  const hints = [...zh.matchAll(/\w*[Hh]int\w*:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const longest = Math.max(...hints.map((h) => h.length));
  assert.ok(longest <= 60, `no hint longer than 60 chars (longest ${longest})`);
  assert.match(src, /fp-budgetDetails/, 'budget details can be folded rather than crowding the card');
});

test('model table: one name column, route suffix dropped', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const table = src.slice(
    src.indexOf('react.createElement("table", { className: "fp-table" }'),
    src.indexOf("tbody", src.indexOf('react.createElement("table", { className: "fp-table" }')),
  );
  assert.equal([...table.matchAll(/fp-th/g)].length, 4, 'four header columns');
  // The id column is gone; the readable name carries the id as a hover title.
  assert.match(src, /react\.createElement\("td", \{ className: "fp-td", title: m\.id \}, shortModelName\(m\)\)/);
  assert.ok(
    !/react\.createElement\("td", \{ className: "fp-td fp-mono" \}, m\.id\)/.test(src),
    'the duplicate id column is removed',
  );
  // And the route parenthetical is stripped, because the heading states it.
  assert.match(src, /function shortModelName\(model\)/);
  assert.ok(
    src.includes(String.raw`replace(/\s*\((?:Droid Core|Factory)\)\s*$/, "")`),
    "the route parenthetical is stripped from the display name",
  );
});

test('quota float runtime: collapsed percent names its real pool and missing data remains unknown', async () => {
  for (const [standard, label, percent] of [
    [{ fiveHour: { usedPercent: 5 }, weekly: { usedPercent: 90 }, monthly: { usedPercent: 20 } }, 'floatWeekly', 90],
    [{ fiveHour: { usedPercent: 80 }, weekly: { usedPercent: 50 } }, 'floatFiveHour', 80],
    [{ monthly: { usedPercent: 95 } }, 'floatMonthly', 95],
    [{}, 'floatTitle', undefined],
  ]) {
    let registration, hook = 0; const state = [], effects = [];
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState(initial) { const i = hook++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
        return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
      useRef(initial) { const i = hook++; return state[i] ??= { current: initial }; },
      useEffect(fn) { effects.push(fn); },
    };
    const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
      .replace('exports.apply = apply;', 'exports.apply = apply; exports.testQuotaFloat = QuotaFloat;');
    vm.runInNewContext(source, {
      window: { innerWidth: 1400, __ModuleLoader__: { load: entry => { registration = entry; } } },
      localStorage: { getItem: () => null, setItem() {} }, setInterval: () => 1, clearInterval() {},
      fetch: async url => ({ json: async () => ({ ok: true,
        value: String(url).endsWith('/config') ? { config: { quotaFloat: true } } : { standard },
      }) }),
    });
    const component = registration.factory(() => react).testQuotaFloat;
    component({ t: key => key }); const cleanup = effects[0]();
    await new Promise(resolve => setImmediate(resolve));
    hook = 0; const expanded = component({ t: key => key }); const nodes = [];
    function walk(value) { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') { nodes.push(value); walk(value.children); } }
    walk(expanded); nodes.find(n => n.type === 'button' && n.props.title === 'floatCollapse').props.onClick();
    hook = 0; const collapsed = component({ t: key => key }); const ring = collapsed.children[0];
    assert.equal(ring.props.label, label); assert.equal(ring.props.percent, percent); cleanup();
  }
});

test('settings: the poll never re-subscribes on dirty, so the first click sticks', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  // Regression: `dirty` in the poll effect's dependency array made the first edit
  // re-run the effect, which called load() and replaced the config state with the
  // server's copy — undoing the click. The second click stuck because dirty was
  // already true.
  const pollAt = src.indexOf('if (!dirtyRef.current) load();');
  assert.ok(pollAt > 0, 'the poll reads dirty through a ref');
  const effectStart = src.lastIndexOf('react.useEffect(() => {', pollAt);
  const deps = src.slice(pollAt, src.indexOf('}, [', pollAt));
  const depsEnd = src.indexOf(']);', pollAt);
  const depList = src.slice(src.indexOf('}, [', pollAt) + 4, depsEnd);
  assert.ok(!/\bdirty\b/.test(depList), `dirty is not a dependency of the poll effect (got: ${depList})`);
  assert.ok(/dirtyRef\.current = dirty/.test(src), 'the ref is kept in sync');
  assert.ok(effectStart > 0 && deps.length >= 0);
});

test('settings: every top-level card collapses and shares one chevron', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  for (const name of ['ConnectionCard', 'AccountsCard', 'QuotaCard', 'TokenStatsCard', 'ContextCard']) {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} exists`);
    const body = src.slice(at, src.indexOf('\n    function ', at + 10));
    assert.ok(
      /CollapsibleCard|fp-details/.test(body),
      `${name} can be folded away`,
    );
    assert.ok(
      !/createElement\("section", \{ className: "fp-card"/.test(body),
      `${name} is no longer a plain, unfoldable section`,
    );
  }
  // One disclosure marker for every card, and the native one suppressed, so the
  // icon cannot differ between browsers.
  // The CSS lives inside a JS string literal, so the quotes are escaped there.
  assert.ok(src.includes(String.raw`.fp-summary::before{content:\"▸\"`), "one chevron glyph");
  assert.ok(src.includes(String.raw`.fp-details[open] .fp-summary::before{transform:rotate(90deg)}`), "it rotates when open");
  assert.ok(src.includes(".fp-summary::-webkit-details-marker{display:none}"), "the browser marker is suppressed");
  assert.ok(/\.fp-summary\{[^}]*list-style:none/.test(src), "and so is the list marker");
});

test('settings: a checkbox in a grid starts its own row', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  // Without this the "use per-model context" checkbox rendered beside the batch
  // size input instead of on its own line.
  assert.match(src, /\.fp-grid>\.fp-check\{flex:1 1 100%\}/);
});
