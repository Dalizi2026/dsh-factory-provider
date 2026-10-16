import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { ROUTES, buildProviderEntry, buildModelEntries } from '../lib/catalog.js';
import { factoryModelLimits, clampFactoryOutputTokens } from '../lib/model-limits.js';
import { modelPreset, modelMultiplier, applyModelDefaults, adaptMistralResponse } from '../lib/model-presets.js';
import { PROVIDER_ROUTING_DATA, providerOrder, createProviderRouter, sanitizeRoutingConfig } from '../lib/provider-routing.js';
import { createGateway } from '../lib/gateway.js';
import { sessionKeyParts } from '../lib/session.js';
import { scopeFactoryRequest, FACTORY_REQUEST_SESSION_HEADER } from '../lib/request-purpose.js';
import { resolveModelCompactionPolicy } from '../lib/compaction-policy.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-model-refresh-'));
process.env.DSH_FACTORY_JOURNAL = path.join(temp, 'journal.jsonl');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/droid-0.241.0-models.json', import.meta.url)));
const refresh = JSON.parse(fs.readFileSync(new URL('./fixtures/droid-0.243.0-model-additions.json', import.meta.url)));
const evidence = { ...refresh, models: [...baseline.models, ...refresh.models] };

test('refresh: all models retain CLI defaults, pool and modalities; new families have separate profiles', () => {
  for (const [route, spec] of Object.entries(ROUTES)) for (const model of spec.models) {
    const expected = evidence.models.find(m => m.id === model.id);
    assert.equal(model.billingPool, expected.billingPool, model.id);
    assert.equal(model.defaultEffort, expected.defaultReasoningEffort, model.id);
    assert.equal(model.images, expected.images, model.id);
    assert.deepEqual(factoryModelLimits(spec.key, model.id, 'off'), expected.limits, model.id);
    const policy = resolveModelCompactionPolicy(model.id);
    assert(policy.thresholdTokens > 0 && policy.thresholdTokens <= expected.limits.maxInputTokens);
  }
  assert.equal(ROUTES.google.billingPool, 'standard'); assert.equal(ROUTES.xai.billingPool, 'standard');
  assert.equal(ROUTES.generic.billingPool, 'core');
  assert.equal(buildModelEntries('generic').find(m => m.id === 'glm-5.2').input.includes('image'), false);
  assert.equal(buildModelEntries('anthropic').find(m => m.id === 'claude-haiku-5-5').compat.forceAdaptiveThinking, true);
  assert.deepEqual(buildModelEntries('generic').find(m => m.id === 'mistral-large-4').reasoningEfforts, {off:'none',high:'high'});
  assert.equal(buildProviderEntry('google', {port:1,gatewayPrefix:'/fixture'}).api, 'openai-completions');
  assert.equal(buildProviderEntry('xai', {port:1,gatewayPrefix:'/fixture'}).api, 'openai-responses');
});

test('refresh: launch/promotional prices expire automatically at the exact documented instant', () => {
  const at = date => Date.parse(date);
  assert.equal(modelMultiplier('mistral-large-4', at('2026-10-14T00:00:00Z')), 0.272);
  assert.equal(modelMultiplier('mistral-large-4', at('2026-10-20T00:00:00Z')-1), 0.272);
  assert.equal(modelMultiplier('mistral-large-4', at('2026-10-20T00:00:00Z')), 0.544);
  assert.equal(modelMultiplier('gemini-3.8-flash', at('2027-01-01T08:00:00Z')), 0.6);
  assert.equal(modelMultiplier('gemini-3.8-flash', at('2026-10-14T00:00:00Z')), 0.3);
  assert.equal(modelMultiplier('gpt-5.6-sol', at('2026-11-22T00:00:00Z')), 2);
});

test('refresh: missing request efforts use CLI defaults; explicit efforts and disabled thinking survive', () => {
  const haiku = {model:'claude-haiku-5-5'}; applyModelDefaults('anthropic',haiku);
  assert.deepEqual(haiku.thinking,{type:'adaptive'});assert.equal(haiku.output_config.effort,'medium');
  const disabled={model:haiku.model,thinking:{type:'disabled'}};applyModelDefaults('anthropic',disabled);
  assert.deepEqual(disabled.thinking,{type:'disabled'});assert.equal(disabled.output_config,undefined);
  const explicit={model:haiku.model,thinking:{type:'adaptive'},output_config:{effort:'max'}};
  applyModelDefaults('anthropic',explicit);assert.equal(explicit.output_config.effort,'max');
  const gemini={model:'gemini-3.8-flash',reasoning_effort:'low',temperature:0.2};applyModelDefaults('google',gemini);
  assert.equal(gemini.reasoning_effort,'low');assert.equal(gemini.temperature,0.2);
  const grok={model:'grok-4.7',prompt_cache_key:'openai-cache',service_tier:'priority'};
  applyModelDefaults('xai',grok);assert.equal(grok.reasoning.effort,'high');assert.equal(grok.service_tier,undefined);
  for (const [provider,model,field,max] of [
    ['factory-google','gemini-3.8-flash','max_tokens',65536],['factory-xai','grok-4.7','max_output_tokens',63356],
    ['factory-a','claude-haiku-5-5','max_tokens',128000],['factory-g','mistral-large-4','max_completion_tokens',64000],
  ]) {
    const body={model,[field]:999999};clampFactoryOutputTokens(provider,body);assert.equal(body[field],max);
    body[field]=64;clampFactoryOutputTokens(provider,body);assert.equal(body[field],64);
  }
});

test('refresh: Mistral tool/reasoning history is append-stable and uses official content parts', () => {
  const body={model:'mistral-large-4',messages:[{role:'assistant',content:'answer',reasoning_content:'思考',
    tool_calls:[{id:'call_1',type:'function',function:{name:'inspect',arguments:'{}'}}]}]};
  applyModelDefaults('generic',body);
  assert.deepEqual(body.messages[0].content,[{type:'thinking',thinking:[{type:'text',text:'思考'}]},{type:'text',text:'answer'}]);
  assert.equal(body.messages[0].tool_calls[0].id,'call_1');assert.equal(body.messages[0].reasoning_content,undefined);
  const prefix=JSON.stringify(body);applyModelDefaults('generic',body);assert.equal(JSON.stringify(body),prefix);
});

test('refresh: Mistral SSE content parts survive fragmented UTF-8, tool deltas, usage and DONE', async () => {
  const frame = {choices:[{delta:{content:[{type:'thinking',thinking:[{type:'text',text:'思考'}]},{type:'text',text:'你好'}],tool_calls:[{index:0,id:'call_1'}]}}],usage:{prompt_tokens:100,completion_tokens:5}};
  const bytes = Buffer.from(`data: ${JSON.stringify(frame)}\r\n\r\ndata: [DONE]\r\n\r\n`);
  const body = new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.subarray(i,i+3));controller.close();}});
  const response=await adaptMistralResponse(new Response(body,{headers:{'content-type':'text/event-stream'}}),'mistral-large-4');
  const text=await response.text();const parsed=JSON.parse(text.split('\r\n')[0].slice(6));
  assert.equal(parsed.choices[0].delta.content,'你好');assert.equal(parsed.choices[0].delta.reasoning_content,'思考');
  assert.equal(parsed.choices[0].delta.tool_calls[0].id,'call_1');assert.equal(parsed.usage.prompt_tokens,100);assert.match(text,/data: \[DONE\]/);
  const untouched=new Response('error',{status:503});assert.equal(await adaptMistralResponse(untouched,'mistral-large-4'),untouched);
});

test('refresh: new model upstreams obey official eligibility, regional exclusions and session affinity', async () => {
  for(const id of ['claude-haiku-5-5','mistral-large-4','mistral-medium-3.5','glm-5.2','glm-5.2-fast','gpt-5.5-pro','gpt-5.3-codex-fast',...ROUTES.google.models.map(m=>m.id),...ROUTES.xai.models.map(m=>m.id)]) {
    const r=evidence.models.find(m=>m.id===id);assert.deepEqual(PROVIDER_ROUTING_DATA.models[id].providers,r.apiProviders,id);
    assert(providerOrder(id).length>0,id);assert.deepEqual(providerOrder(id,{route:'wrong'}),[]);
  }
  assert.deepEqual(providerOrder('mistral-large-4',{region:'eu'}),['mistral']);
  assert.deepEqual(providerOrder('mistral-large-4',{region:'us'}),[]);
  assert.deepEqual(providerOrder('glm-5.2',{region:'eu'}),['mistral']);
  assert.deepEqual(providerOrder('gemini-3.1-pro-preview',{region:'us'}),[]);
  const config=sanitizeRoutingConfig(PROVIDER_ROUTING_DATA.config);assert.deepEqual(config.defaults.google,['google']);assert.deepEqual(config.defaults.xai,['xai']);
  const router=createProviderRouter();
  for(const route of ['google','xai']) {
    const args={credential:{token:'fk-offline'},model:ROUTES[route].models[0].id,route,host:'https://offline.invalid',session:'stable'};
    const first=await router.select(args);first.success();assert.equal((await router.select(args)).source,'session_lock');
    const snapshot={profiles:new Map([[ROUTES[route].key,{}]])};
    assert(scopeFactoryRequest(snapshot,{provider:ROUTES[route].key,sessionId:'thread'}).profiles.get(ROUTES[route].key).headers[FACTORY_REQUEST_SESSION_HEADER]);
  }
  assert.deepEqual(sessionKeyParts('xai',{instructions:'system',input:[{role:'user',content:[{type:'input_text',text:'hello'}]}]}),{system:'system',firstUser:'hello'});
});

async function gatewayFixture(t) {
  const seen=[];
  const credential={token:'fk-offline',source:'api-key'};
  const gateway=createGateway({resolver:{resolve:async()=>credential,state:()=>credential},enabledRoutes:Object.keys(ROUTES),
    gatewayPrefix:'/fixture',apiBaseURL:'https://offline.invalid',requestMaxBytes:0,
    fetchImpl:async(url,init)=>{
      const body=JSON.parse(init.body);seen.push({url,headers:init.headers,body});
      if(url.endsWith('/responses'))return Response.json({id:'resp_fixture',object:'response',status:'completed',model:body.model,output:[],usage:{input_tokens:100,output_tokens:1}});
      if(url.endsWith('/messages'))return Response.json({id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'OK'}],usage:{input_tokens:100,output_tokens:1}});
      return Response.json({id:'chat_fixture',object:'chat.completion',model:body.model,choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:1}});
    }});
  const server=http.createServer((req,res)=>{const handler=gateway.routes.find(r=>r.path===req.url)?.handler;if(handler)void handler(req,res);else{res.statusCode=404;res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  return {seen,gateway,base:`http://127.0.0.1:${server.address().port}/fixture`};
}

test('refresh: all configured protocols/groups reach the right Factory path, tool/image body, provider and usage', async t => {
  const fixture=await gatewayFixture(t);
  for(const [route,model,provider,suffix] of [
    ['anthropic','claude-haiku-5-5','anthropic','/api/llm/a/v1/messages'],
    ['generic','mistral-large-4','mistral','/api/llm/o/v1/chat/completions'],
    ['standard','muse-spark-open','baseten','/api/llm/o/v1/chat/completions'],
    ['openai','gpt-5.5-pro','openai','/api/llm/o/v1/responses'],
    ['google','gemini-4-argon','google','/api/llm/g/v1/generate'],
    ['xai','grok-4.7','xai','/api/llm/o/v1/responses'],
  ]) {
    const spec=ROUTES[route],responses=spec.api==='openai-responses';
    const body=route==='google'?{model,contents:[{role:'user',parts:[{text:'Inspect'},{inlineData:{mimeType:'image/png',data:'AA=='}}]}],generationConfig:{maxOutputTokens:16},tools:[{functionDeclarations:[{name:'inspect',parameters:{type:'object'}}]}]}:responses?{model,input:[{role:'user',content:[{type:'input_text',text:'Inspect'},{type:'input_image',image_url:'data:image/png;base64,AA=='}]}],max_output_tokens:16,tools:[{type:'function',name:'inspect',parameters:{type:'object'}}]}:
      {model,messages:[{role:'user',content:route==='anthropic'?'Inspect':[{type:'text',text:'Inspect'},{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}],max_tokens:16,tools:route==='anthropic'?[{name:'inspect',input_schema:{type:'object'}}]:[{type:'function',function:{name:'inspect',parameters:{type:'object'}}}]};
    const tail=responses?'responses':route==='anthropic'?'messages':'chat/completions';
    for(let i=0;i<2;i++)assert.equal((await fetch(route==='google'?`${fixture.base}/google/models/${model}:streamGenerateContent`:`${fixture.base}/${spec.gatewaySub}/v1/${tail}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,200);
    const sent=fixture.seen.at(-1);assert(sent.url.endsWith(suffix));assert.equal(sent.headers['x-api-provider'],provider);
    assert.equal(sent.headers['x-session-id'],fixture.seen.at(-2).headers['x-session-id']);assert.equal(sent.headers['x-provider-routing-source'],'session_lock');
    assert.equal(sent.body.tools.length,1);assert.equal(sent.body.max_tokens??sent.body.max_output_tokens??sent.body.generationConfig?.maxOutputTokens,16);
    if(route==='xai')assert.equal(sent.headers['openai-platform'],undefined);
    if(route==='google')assert.equal(sent.body.contents[0].parts[1].inlineData.data,'AA==');
  }
  fixture.gateway.configure({routes:['anthropic']});
  assert.equal((await fetch(`${fixture.base}/google/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gemini-3.8-flash'})})).status,404);
});

test('refresh UI: route groups use human names, independent fold state and per-group selection', () => {
  let registration;
  const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8').replace('exports.apply = apply;','exports.apply = apply; exports.table = RouteTable; exports.strings = zh;');
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:r=>{registration=r;}}}});
  const react={createElement:(type,props,...children)=>({type,props:props??{},children})};
  const api=registration.factory(()=>react);const t=(key,data={})=>Object.entries(data).reduce((s,[k,v])=>s.replace(`{${k}}`,v),api.strings[key]??key);
  const calls=[];
  for(const [route,spec] of Object.entries(ROUTES)) {
    const group=api.table({t,routeKey:route,route:{providerKey:spec.key,models:spec.models.map(m=>({...m,efforts:Object.keys(m.efforts)}))},enabled:true,selected:[],onToggle:(...args)=>calls.push(args),onSelect(){},onSelectRoute:(...args)=>calls.push(args)});
    assert.equal(group.props.id,`model-group-${route}`);assert.equal(group.props.defaultOpen,false);assert(!group.props.title.includes('factory-'));
    group.props.actions[1].props.onClick();assert.equal(calls.at(-1)[0],route);
  }
  assert.match(source,/modelPoolCore/);assert.match(source,/modelPoolStandard/);
});

// The installed SDK itself parses synthetic upstream SSE. The custom fetch
// never contacts Factory (or any other server) and uses no saved credentials.
for (const [route, id] of [['anthropic','claude-haiku-5-5'],['generic','mistral-large-4'],['xai','grok-4.7']]) {
  test(`refresh SDK: ${id} parses the complete upstream stream`, {skip:!process.env.DSH_FACTORY_HOST_ROOT}, async () => {
    const profile = buildProviderEntry(route,{port:1,gatewayPrefix:'/fixture'});
    const entry = profile.models.find(m=>m.id===id);
    const source = ROUTES[route].models.find(m=>m.id===id);
    const sdk = await import(pathToFileURL(path.join(process.env.DSH_FACTORY_HOST_ROOT,'@earendil-works/pi-ai/dist/api',`${profile.api}.js`)));
    const msg = {id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK',annotations:[]}]};
    const full = {id:'resp_fixture',object:'response',status:'completed',model:id,output:[msg],usage:{input_tokens:100,output_tokens:2,total_tokens:102}};
    const events = profile.api==='openai-responses' ? [
      {type:'response.created',response:{...full,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...msg,status:'in_progress',content:[]}},
      {type:'response.content_part.added',output_index:0,content_index:0,item_id:msg.id,part:{type:'output_text',text:'',annotations:[]}},
      {type:'response.output_text.delta',output_index:0,content_index:0,item_id:msg.id,delta:'OK'},
      {type:'response.output_item.done',output_index:0,item:msg},
      {type:'response.completed',response:full},
    ] : profile.api==='anthropic-messages' ? [
      {type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:id,content:[],usage:{input_tokens:100,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
      {type:'message_stop'},
    ] : [
      {id:'chat_fixture',object:'chat.completion.chunk',model:id,choices:[{index:0,delta:{role:'assistant',content:id.startsWith('mistral-')?[{type:'thinking',thinking:[{type:'text',text:'Thought'}]},{type:'text',text:'OK'}]:'OK'},finish_reason:null}]},
      {id:'chat_fixture',object:'chat.completion.chunk',model:id,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:2,total_tokens:102}},
    ];
    const sse=events.map(event=>`${event.type?`event: ${event.type}\n`:''}data: ${JSON.stringify(event)}\n\n`).join('')+(profile.api==='openai-completions'?'data: [DONE]\n\n':'');
    const chunks=[];
    const model={...entry,provider:ROUTES[route].key,api:profile.api,baseUrl:profile.baseURL,reasoning:true,
      thinkingLevelMap:entry.reasoningEfforts,headers:profile.headers,compat:{...profile.compat,...entry.compat},
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    const request={systemPrompt:'Stable fixture.',messages:[{role:'user',content:[{type:'text',text:'Hello'}],timestamp:1}]};
    for await (const chunk of sdk.streamSimple(model,request,{apiKey:'offline-only',reasoning:source.defaultEffort,maxTokens:128,
      fetch:async()=>adaptMistralResponse(new Response(sse,{headers:{'content-type':'text/event-stream'}}),id)})) chunks.push(chunk);
    assert.equal(chunks.at(-1).type,'done',JSON.stringify(chunks.at(-1)));
    assert.equal(chunks.at(-1).message.content.filter(block=>block.type==='text').map(block=>block.text).join(''),'OK');
    if(id.startsWith('mistral-'))assert.equal(chunks.at(-1).message.content.find(block=>block.type==='thinking').thinking,'Thought');
  });
}
