import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function render(config) {
  let registration;
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    .replace('exports.apply = apply;', 'exports.apply = apply; exports.testConfigCard = ConfigCard;');
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: entry => { registration = entry; } } } });
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const component = registration.factory(() => react).testConfigCard;
  const changes = [];
  const tree = component({ t: key => key, config, routes: {
    anthropic: { providerKey: 'factory-a', models: [{ id: 'opus', name: 'Opus' }] },
    generic: { providerKey: 'factory-g', models: [{ id: 'glm-5.3-flash', name: 'GLM Flash', cost: '0.06x' }] },
    openai: { providerKey: 'factory-o', models: [{ id: 'gpt', name: 'GPT' }] },
  }, dirty: false, patchConfig: (field, value) => changes.push({ field, value }) });
  const nodes = [];
  function walk(node) { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; nodes.push(node); node.children?.forEach(walk); }
  walk(tree);
  return { nodes, changes };
}

test('context UI: summary selector lists enabled visible models and emits a model change', () => {
  const f = render({ routes: ['anthropic', 'generic'], modelAllowlist: ['opus', 'glm-5.3-flash'] });
  const select = f.nodes.find(node => node.type === 'select');
  const options = select.children.flat().filter(node => node?.type === 'option');
  assert.deepEqual(options.map(node => node.props.value), ['', 'factory-a/opus', 'factory-g/glm-5.3-flash']);
  select.props.onChange({ target: { value: 'factory-g/glm-5.3-flash' } });
  assert.deepEqual(f.changes, [{ field: 'anthropicSummaryModel', value: 'factory-g/glm-5.3-flash' }]);
});
test('context UI: unavailable selection stays visible, optimization checkbox sends a boolean', () => {
  const f = render({ routes: ['anthropic'], anthropicSummaryModel: 'factory-g/glm-5.3-flash' });
  assert.ok(f.nodes.some(node => node.type === 'option' && node.props.value === 'factory-g/glm-5.3-flash' && node.props.disabled));
  const checkbox = f.nodes.find(node => node.type === 'label' && node.children.includes('configContextOptimization')).children[0];
  checkbox.props.onChange({ target: { checked: false } });
  assert.deepEqual(f.changes, [{ field: 'anthropicContextOptimization', value: false }]);
});

test('context UI: alignment and independent 400K thresholds can be edited', () => {
  const f=render({routes:['anthropic']});
  const toggle=f.nodes.find(n=>n.type==='label'&&n.children.includes('configContextAlignment')).children[0];
  assert.equal(toggle.props.checked,true);toggle.props.onChange({target:{checked:false}});
  const thresholds=f.nodes.filter(n=>n.type==='input'&&n.props.max===872000);assert.equal(thresholds.length,2);assert(thresholds.every(n=>n.props.value==='400000'));
  thresholds[0].props.onChange({target:{value:'350000'}});thresholds[1].props.onChange({target:{value:'450000'}});
  assert.deepEqual(f.changes,[{field:'factoryContextAlignment',value:false},{field:'opus55CompactionTokens',value:'350000'},{field:'sonnet55CompactionTokens',value:'450000'}]);
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
