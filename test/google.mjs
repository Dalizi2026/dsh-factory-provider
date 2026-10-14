import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGateway } from '../lib/gateway.js';
import { buildProviderEntry, ROUTES } from '../lib/catalog.js';
import { normalizeGooglePayload, scopeGoogleSdk } from '../lib/google.js';
import { clampFactoryOutputTokens } from '../lib/model-limits.js';
import { modelMultiplier } from '../lib/model-presets.js';
import { sessionKeyParts } from '../lib/session.js';
import { requestSizeBreakdown } from '../lib/request-size.js';
import { googleRequest, streamGoogleNative } from '../lib/google-stream.js';
import { installAdaptiveImages } from '../lib/images.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-google-'));
process.env.DSH_FACTORY_JOURNAL = path.join(directory, 'journal.jsonl');
test.after(() => fs.rmSync(directory, {recursive:true,force:true}));
const root = process.env.DSH_FACTORY_HOST_ROOT;
const host = name => import(pathToFileURL(path.join(root, '@deepseek-ai', name, 'lib/index.js')));

async function nativeServer(t, reply) {
  const server=http.createServer(reply);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  return {id:'gemini-4-argon',provider:'factory-google',api:'google-generative-ai',maxTokens:64,
    baseUrl:`http://127.0.0.1:${server.address().port}/fixture/google`};
}
test('Google native: fragmented UTF-8 frames preserve separate signed text and thinking blocks', async t => {
  const frames=[{candidates:[{content:{parts:[{thought:true,text:'思考',thoughtSignature:'c2lnMQ=='}]}}]},
    {candidates:[{content:{parts:[{text:'你好',thoughtSignature:'c2lnMg=='}]}}]},
    {candidates:[{content:{parts:[{text:'世界',thoughtSignature:'c2lnMw=='}]},finishReason:'STOP'}]}];
  const bytes=Buffer.from(frames.map(f=>`data: ${JSON.stringify(f)}\r\n\r\n`).join('')+'data: [DONE]');
  const model=await nativeServer(t,(_req,res)=>{res.setHeader('content-type','text/event-stream');
    for(let i=0;i<bytes.length;i+=3)res.write(bytes.subarray(i,i+3));res.end();});
  const events=[];for await(const event of streamGoogleNative(model,{messages:[]}))events.push(event);
  assert.equal(events.at(-1).type,'done');
  assert.deepEqual(events.at(-1).message.content,[{type:'thinking',thinking:'思考',thinkingSignature:'c2lnMQ=='},
    {type:'text',text:'你好',textSignature:'c2lnMg=='},{type:'text',text:'世界',textSignature:'c2lnMw=='}]);
});
test('Google native: premature EOF and malformed JSON never become successful completions', async t => {
  for(const reply of ['data: {bad}\n\n','data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n']){
    const model=await nativeServer(t,(_req,res)=>{res.setHeader('content-type','text/event-stream');res.end(reply);});
    const events=[];for await(const event of streamGoogleNative(model,{messages:[]}))events.push(event);
    assert.equal(events.at(-1).type,'error');assert.equal(events.at(-1).error.stopReason,'error');
  }
});
test('Google native: HTTP errors and cancellations surface once without automatic retries', async t => {
  let requests=0;
  const model=await nativeServer(t,(_req,res)=>{requests++;res.statusCode=503;res.end('Unavailable');});
  const events=[];for await(const event of streamGoogleNative(model,{messages:[]}))events.push(event);
  assert.equal(requests,1);assert.match(events.at(-1).error.errorMessage,/503 Unavailable/);
  const signal=AbortSignal.abort();
  for await(const event of streamGoogleNative(model,{messages:[]},{signal}))assert.equal(event.reason,'aborted');
  assert.equal(requests,1);
});
test('Google native: signed replay stays model-scoped; deterministic tool ids and image tool results survive', () => {
  const model={id:'gemini-4-argon',provider:'factory-google',api:'google-generative-ai',maxTokens:64};
  const context={messages:[{role:'assistant',provider:model.provider,model:model.id,api:model.api,
    content:[{type:'toolCall',name:'inspect',id:'stable',arguments:{target:1},thoughtSignature:'c2lnMQ=='}]},
    {role:'toolResult',toolName:'inspect',toolCallId:'stable',content:[{type:'text',text:'found'},{type:'image',mimeType:'image/png',data:'AA=='}]}]};
  const body=googleRequest(model,context);
  assert.equal(body.contents[0].parts[0].thoughtSignature,'c2lnMQ==');
  assert.equal(body.contents[1].parts[0].functionResponse.id,'stable');
  assert.equal(body.contents[1].parts[0].functionResponse.parts[0].inlineData.data,'AA==');
  assert.equal(googleRequest({...model,id:'gemini-3.8-flash'},context).contents[0].parts[0].thoughtSignature,undefined);
});

test('Gemini 4: native defaults preserve signed parts, images, function results and explicit limits', () => {
  const contents = [{role:'user',parts:[{text:'Compare'},{inlineData:{mimeType:'image/png',data:'AA=='}}]},
    {role:'model',parts:[{functionCall:{name:'inspect',args:{x:1}},thoughtSignature:'b3BhcXVlLXNpZ25hdHVyZQ=='}]},
    {role:'user',parts:[{functionResponse:{name:'inspect',response:{result:7}}}]}];
  const original = JSON.stringify(contents);
  const body = {model:'gemini-4-argon',contents,generationConfig:{temperature:0.2,topP:0.5,topK:1,maxOutputTokens:999999}};
  normalizeGooglePayload(body);clampFactoryOutputTokens('factory-google',body);
  assert.equal(body.generationConfig.maxOutputTokens,65536);
  assert.deepEqual(body.generationConfig.thinkingConfig,{includeThoughts:true,thinkingLevel:'MEDIUM'});
  for(const field of ['temperature','topP','topK'])assert.equal(body.generationConfig[field],undefined);
  assert.equal(JSON.stringify(body.contents),original);
  const before = JSON.stringify(body);normalizeGooglePayload(body);assert.equal(JSON.stringify(body),before);
  body.generationConfig.maxOutputTokens=64;clampFactoryOutputTokens('factory-google',body);assert.equal(body.generationConfig.maxOutputTokens,64);
  assert(requestSizeBreakdown(body).messagesBytes>0);
  assert.equal(sessionKeyParts('google',body).firstUser,'Compare\n');
  assert.equal(modelMultiplier('gemini-4-argon',Date.parse('2026-10-14T00:00:00Z')),0.8);
  assert.equal(modelMultiplier('gemini-4-argon',Date.parse('2026-12-01T08:00:00Z')),1.6);
});

test('Google native scope is per request and leaves the host registry untouched', () => {
  const models={streamSimple(){throw new Error('Host OpenAI protocol must not be invoked');}};
  const original={models}, scoped=scopeGoogleSdk(original,{provider:'factory-google'});
  assert.equal(original.models,models);assert.notEqual(scoped.models,models);
  const payload=googleRequest({id:'gemini-4-argon',maxTokens:65536},{messages:[{role:'user',content:'hello'}]}, {reasoning:'low',maxTokens:64,temperature:1});
  assert.deepEqual(payload.generationConfig.thinkingConfig,{includeThoughts:true,thinkingLevel:'LOW'});
  assert.equal(payload.generationConfig.temperature,undefined);
  assert.equal(scopeGoogleSdk(original,{provider:'unrelated'}),original);
});

// The real host adapter and native transport send requests only to this local mock
// gateway. Synthetic Factory responses retain signed tool calls across turns.
test('Gemini native: real DSH adapter / native transport / gateway round-trip signatures, tools, images and usage', {skip:!root}, async t => {
  const [{Context},{PiAiAdapter,Config}]=await Promise.all([host('cordis'),host('dsh-llm-pi-ai')]);
  const seen=[], localPaths=[];
  const gateway=createGateway({resolver:{resolve:async()=>({token:'fk-offline',source:'api-key'}),state:()=>({source:'api-key'})},
    enabledRoutes:['google'],gatewayPrefix:'/fixture',apiBaseURL:'https://offline.invalid',
    fetchImpl:async(url,init)=>{
      seen.push({url,headers:init.headers,body:JSON.parse(init.body)});
      const parts=seen.length===1
        ? [{functionCall:{name:'inspect',args:{target:'fixture'}},thoughtSignature:'b3BhcXVlLXNpZ25hdHVyZQ=='}]
        : [{text:'OK',thoughtSignature:'YW5zd2VyLXNpZ25hdHVyZQ=='}];
      const frame={candidates:[{index:0,content:{role:'model',parts},finishReason:'STOP'}],
        usageMetadata:{promptTokenCount:100,candidatesTokenCount:2,thoughtsTokenCount:3,cachedContentTokenCount:80,totalTokenCount:105}};
      return new Response(`data: ${JSON.stringify(frame)}\n\n`,{headers:{'content-type':'text/event-stream'}});
    }});
  const server=http.createServer((req,res)=>{
    localPaths.push(req.url);
    const handler=gateway.routes.find(r=>r.path===new URL(req.url,'http://localhost').pathname)?.handler;
    if(handler)void handler(req,res);else{res.statusCode=404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const profile=buildProviderEntry('google',{port:server.address().port,gatewayPrefix:'/fixture'});
  assert.doesNotThrow(()=>Config({providers:{'factory-google':profile}}));
  const profiles=new Map([['factory-google',{...profile,modelErrors:new Map(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:60000}]]);
  const model={...profile.models.find(m=>m.id==='gemini-4-argon'),provider:'factory-google',api:profile.api,
    baseUrl:profile.baseURL,reasoning:true,thinkingLevelMap:{low:'low',medium:'medium',high:'high'},
    headers:profile.headers,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const models={getModel:(_provider,id)=>({...model,id}),streamSimple(){throw new Error('Host protocol invoked');}};
  const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>undefined,resolveAttachments:()=>({})});
  adapter.snapshot={profiles,models};
  const ctx=new Context();ctx.provide('llm',{registration:()=>({adapter})});
  const dispose=installAdaptiveImages(ctx,()=>({enabledRoutes:['google'],factoryAdaptiveImages:false}),{},()=>{});
  t.after(dispose);await new Promise(resolve=>setImmediate(resolve));
  const tools=[{name:'inspect',description:'Inspect fixture',parameters:{type:'object',properties:{target:{type:'string'}},required:['target']}}];
  const messages=[{role:'system',content:[{type:'text',text:'Stable instructions.'}]},
    {role:'user',content:[{type:'text',text:'Inspect fixture.'}]}];
  const args={provider:'factory-google',model:'gemini-4-argon',sessionId:'offline-thread',messages,tools,maxTokens:256};
  const chunks=[];for await(const chunk of adapter.stream(args))chunks.push(chunk);
  assert(!chunks.some(chunk=>chunk.type==='error'),JSON.stringify(chunks));
  assert.equal(seen.length,1,JSON.stringify(chunks));
  assert.match(localPaths[0],/\/google\/models\/gemini-4-argon:streamGenerateContent\?alt=sse$/);
  assert(seen[0].url.endsWith('/api/llm/g/v1/generate'));
  assert.equal(seen[0].body.model,'gemini-4-argon');
  assert.equal(seen[0].body.generationConfig.thinkingConfig.thinkingLevel,'MEDIUM');
  assert.equal(seen[0].body.generationConfig.temperature,undefined);
  assert.equal(seen[0].body.tools[0].functionDeclarations[0].name,'inspect');
  const call=chunks.find(chunk=>chunk.type==='block-end'&&chunk.block.type==='tool-call')?.block;assert(call,JSON.stringify(chunks));
  // Replay a native signed assistant tool call through the SDK and gateway.
  const nextMessages=[...messages,{role:'assistant',content:[call],source:{provider:'factory-google',model:'gemini-4-argon',replayState:chunks.find(chunk=>chunk.type==='finish').replayState}},
    {role:'tool',toolCallId:call.id,content:[{type:'text',text:'7'}]}];
  const reply=[];
  for await(const chunk of adapter.stream({...args,messages:nextMessages,reasoningEffort:'low'}))reply.push(chunk);
  assert(reply.some(chunk=>chunk.type==='finish'),JSON.stringify(reply));
  const signed=seen[1].body.contents.flatMap(c=>c.parts).find(p=>p.functionCall);
  assert.equal(signed.thoughtSignature,'b3BhcXVlLXNpZ25hdHVyZQ==');
  assert(seen[1].body.contents.some(c=>c.parts.some(p=>p.functionResponse)));
  assert.equal(seen[1].body.generationConfig.thinkingConfig.thinkingLevel,'LOW');
  assert.equal(seen[1].headers['x-session-id'],seen[0].headers['x-session-id']);
  assert.equal(seen[1].headers['x-provider-routing-source'],'session_lock');
  // All Gemini models keep the native image parts and named effort values.
  const scoped=scopeGoogleSdk({models},args);
  const imageContext={messages:[{role:'user',content:[{type:'text',text:'Inspect'},{type:'image',mimeType:'image/png',data:'AA=='}],timestamp:1}]};
  const imageReply=[];
  for await(const chunk of scoped.models.streamSimple({...model,id:'gemini-3.8-flash'},imageContext,{reasoning:'high',maxTokens:16,maxRetries:0}))imageReply.push(chunk);
  assert.equal(imageReply.at(-1).type,'done',JSON.stringify(imageReply));
  assert.equal(seen[2].body.contents[0].parts[1].inlineData.data,'AA==');
  assert.equal(seen[2].body.generationConfig.thinkingConfig.thinkingLevel,'HIGH');
  const usage=fs.readFileSync(process.env.DSH_FACTORY_JOURNAL,'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.event==='usage'&&e.model==='gemini-4-argon');
  assert(usage.length>=2);assert.equal(usage.at(-1).input,20);assert.equal(usage.at(-1).read,80);assert.equal(usage.at(-1).output,5);
  assert.equal(ROUTES.google.models[0].id,'gemini-4-argon');
});
