import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import z from '@deepseek-ai/schemastery';
import { Config } from '../lib/index.js';
import { FACTORY_MODEL_LIMITS } from '../lib/model-limits.js';
import { modelCompactionPolicy, resolveModelCompactionPolicy, validateModelCompactionTokens } from '../lib/compaction-policy.js';
import { alignedCompactionBudget } from '../lib/context.js';

test('approved policies: defaults fit all 38 unchanged Factory input/output envelopes', () => {
  const expected = {
    'glm-5.3-flash':900000, 'glm-5.3':890000, 'qwen3.8-max':118000,
    'kimi-k3':190000, 'minimax-m3':420000, 'minimax-m2.7':185000,
    'claude-opus-4-8':850000, 'claude-opus-5':850000, 'claude-opus-4-7':850000,
    'claude-fable-5':850000, 'claude-fable-5.1':850000,
    'claude-sonnet-5':850000, 'claude-sonnet-4-6':910000,
    'deepseek-v4-pro':830000, 'deepseek-v4-flash-0731':830000,
    'claude-opus-5-5':400000, 'claude-sonnet-5-5':400000, 'claude-opus-5-5-fast':250000,
  };
  for (const [id, l] of Object.entries(FACTORY_MODEL_LIMITS)) {
    const p = resolveModelCompactionPolicy(id);
    const budget = alignedCompactionBudget({limits:l,contextWindow:l.contextWindow,maxTokens:l.maxOutputTokens,
      thresholdTokens:p.thresholdTokens,headroomTokens:p.headroomTokens});
    assert.equal(budget.threshold, expected[id] ?? modelCompactionPolicy(id).defaultThreshold, id);
    assert(budget.threshold+p.headroomTokens<=Math.min(l.maxInputTokens,l.contextWindow-l.maxOutputTokens),id);
    if(id.startsWith('gpt-'))assert.equal(budget.threshold,250000);
  }
});

test('saved thresholds: schema validates per model, serializes numeric overrides and preserves legacy choices', () => {
  const config=Config({opus55CompactionTokens:300000,modelCompactionTokens:{'glm-5.3':500000}});
  assert.equal(resolveModelCompactionPolicy('claude-opus-5-5',config).thresholdTokens,300000);
  assert.equal(resolveModelCompactionPolicy('glm-5.3',config).thresholdTokens,500000);
  for (const values of [{'qwen3.8-max':118073},{'kimi-k3':196609},{unknown:100000},{'glm-5.3':1},
    {'glm-5.3':500000.5},{'glm-5.3':'500000'},{'glm-5.3':null}]) {
    assert.throws(()=>validateModelCompactionTokens(values));
  }
  const persisted=JSON.parse(JSON.stringify(config.modelCompactionTokens.get()));
  assert.equal(resolveModelCompactionPolicy('glm-5.3',Config({modelCompactionTokens:persisted})).thresholdTokens,500000);
  assert.equal(resolveModelCompactionPolicy('claude-opus-5-5',{opus55CompactionTokens:300000,
    modelCompactionTokens:{'claude-opus-5-5':350000}}).thresholdTokens,350000);
});

test('published settings schema: round-trip serialization needs no plugin module closure', () => {
  const schema=z(JSON.parse(JSON.stringify(Config)));
  assert.equal(schema({modelCompactionTokens:{'glm-5.3':500000}}).modelCompactionTokens.get()['glm-5.3'],500000);
  assert.throws(()=>schema({modelCompactionTokens:{unknown:100000}}));
  assert.throws(()=>schema({modelCompactionTokens:{'glm-5.3':'500000'}}));
});

test('custom thresholds: smaller host windows, output room and headroom always take precedence', () => {
  const l=FACTORY_MODEL_LIMITS['glm-5.3'];
  const p=resolveModelCompactionPolicy('glm-5.3',{modelCompactionTokens:{'glm-5.3':895928}});
  assert.equal(alignedCompactionBudget({limits:l,contextWindow:200000,maxTokens:64000,
    thresholdTokens:p.thresholdTokens,headroomTokens:p.headroomTokens}).threshold,123000);
  assert.equal(resolveModelCompactionPolicy('glm-5.3',{modelCompactionTokens:{'glm-5.3':Infinity}}).thresholdTokens,890000);
  assert.equal(resolveModelCompactionPolicy('glm-5.3',{modelCompactionTokens:{'glm-5.3':9999999}}).thresholdTokens,895928);
  assert.equal(resolveModelCompactionPolicy('unknown'),undefined);
});

function ui(initial={}) {
  let registration, index=0, config=initial;
  const state=[];
  const react={createElement:(type,props,...children)=>({type,props:props??{},children}),
    useState(value){const i=index++;state[i]??=typeof value==='function'?value():value;return[state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];}};
  const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8')
    .replace('exports.apply = apply;','exports.apply = apply; exports.editor = ModelCompactionEditor; exports.ops = configOperations; exports.bar = SaveBar;');
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:entry=>{registration=entry;}}}});
  const api=registration.factory(()=>react);
  const models=['glm-5.3-flash','qwen3.8-max','kimi-k3','claude-opus-5-5'].map(id=>({id,name:id,compaction:modelCompactionPolicy(id)}));
  const draw=()=>{index=0;const tree=api.editor({config,routes:{generic:{models}},dirty:true,t:k=>k,
    patchConfig:(field,value)=>{config={...config,[field]:value};},onSave(){},onDiscard(){}});
    const nodes=[];function walk(n){if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=='object')return;nodes.push(n);walk(n.children);}walk(tree);return nodes;};
  return{api,draw,get config(){return config;}};
}

test('model editor: one threshold at a time, independent overrides, restore, and folded channel warning', () => {
  const f=ui({glmFlashCompactionTokens:250000});
  let nodes=f.draw();assert.equal(nodes.filter(n=>n.type==='input').length,1);
  assert.equal(nodes.find(n=>n.type==='input').props.value,'250000');
  nodes.find(n=>n.type==='input').props.onChange({target:{value:'500000'}});
  nodes=f.draw();nodes.find(n=>n.type==='select').props.onChange({target:{value:'qwen3.8-max'}});
  nodes=f.draw();assert.equal(nodes.find(n=>n.type==='input').props.value,'118000');
  assert.equal(nodes.find(n=>n.type==='input').props.max,118072);
  assert(nodes.some(n=>n.props.className==='fp-modelWarning'));
  assert.equal(nodes.find(n=>n.type==='details').props.open,undefined,'budget details start folded');
  nodes.find(n=>n.type==='input').props.onChange({target:{value:'200000'}});
  nodes=f.draw();assert.equal(nodes.find(n=>n.type==='input').props['aria-invalid'],true);
  const bar=nodes.find(n=>n.type===f.api.bar);assert.equal(bar.props.invalid,true);
  nodes.find(n=>n.type==='button'&&n.children.includes('modelThresholdReset')).props.onClick();
  assert.equal(f.config.modelCompactionTokens['qwen3.8-max'],undefined);
  assert.equal(f.config.modelCompactionTokens['glm-5.3-flash'],'500000');
  nodes=f.draw();nodes.find(n=>n.type==='select').props.onChange({target:{value:'glm-5.3-flash'}});
  nodes=f.draw();nodes.find(n=>n.type==='button').props.onClick();
  assert.equal(f.config.glmFlashCompactionTokens,900000);
  assert.equal(f.config.modelCompactionTokens['glm-5.3-flash'],undefined);
});

test('model editor: save turns typed values into numbers; blank input cannot become a saved zero', () => {
  const f=ui({modelCompactionTokens:{'glm-5.3': '500000','kimi-k3':'180000'}});
  const op=f.api.ops(f.config).find(op=>op.path[0]==='modelCompactionTokens');
  assert.equal(op.value['glm-5.3'],500000);assert.equal(op.value['kimi-k3'],180000);
  assert.doesNotThrow(()=>Config({modelCompactionTokens:op.value}));
  for(const raw of ['', ' ', '1.5', 'invalid',null]) assert.throws(()=>f.api.ops({modelCompactionTokens:{'glm-5.3':raw}}));
});
