import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {enableGeminiArgumentStreaming,adaptGeminiArgumentStream} from '../lib/google-arguments.js';
import {createGateway} from '../lib/gateway.js';
import {streamGoogleNative} from '../lib/google-stream.js';
import {scopeGoogleSdk} from '../lib/google.js';
process.env.DSH_FACTORY_JOURNAL=path.join(os.tmpdir(),`factory-gemini-stream-test-${process.pid}.jsonl`);
const frame=(call,extra={})=>({candidates:[{content:{role:'model',parts:[{functionCall:call,...extra}]}}]});
const end={candidates:[{content:{role:'model',parts:[{text:''}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:77,candidatesTokenCount:12,totalTokenCount:89}};
const encode=frames=>frames.map(f=>`data: ${JSON.stringify(f)}\r\n\r\n`).join('');
const response=(frames,split=0)=>{
 const bytes=new TextEncoder().encode(encode(frames));
 const body=split?new ReadableStream({start(c){for(let n=0;n<bytes.length;n+=split)c.enqueue(bytes.slice(n,n+split));c.close();}}):bytes;
 return new Response(body,{headers:{'content-type':'text/event-stream','content-length':String(bytes.length)}});
};
const parse=text=>text.split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
const calls=frames=>frames.flatMap(f=>f.candidates??[]).flatMap(c=>c.content?.parts??[]).filter(p=>p.functionCall);
const simple=[frame({name:'echo',id:'call1',partialArgs:[{jsonPath:'$.message',stringValue:'你好',willContinue:true}],willContinue:true},{thoughtSignature:'exact-signature'}),frame({partialArgs:[{jsonPath:'$.message',stringValue:'，世界'}],willContinue:true}),frame({}),end];

test('enables only Argon tools, preserving mode/allow-list, explicit opt-out and generation config',()=>{
 for(const model of ['gemini-3.8-flash','gemini-3.1-pro-preview','unrelated']){const p={model,tools:[{functionDeclarations:[{}]}]};enableGeminiArgumentStreaming(p);assert.equal(p.toolConfig,undefined);}
 const base={model:'gemini-4-argon',tools:[{functionDeclarations:[{}]}],generationConfig:{maxOutputTokens:65536,thinkingConfig:{thinkingLevel:'HIGH'}},toolConfig:{functionCallingConfig:{mode:'ANY',allowedFunctionNames:['echo']}}};
 const p=structuredClone(base);enableGeminiArgumentStreaming(p);assert.equal(p.toolConfig.functionCallingConfig.streamFunctionCallArguments,true);assert.deepEqual(p.generationConfig,base.generationConfig);assert.deepEqual(p.toolConfig.functionCallingConfig.allowedFunctionNames,['echo']);
 for(const config of [{mode:'NONE'},{streamFunctionCallArguments:false}]){const q={...base,toolConfig:{functionCallingConfig:config}};enableGeminiArgumentStreaming(q);assert.notEqual(config.streamFunctionCallArguments,true);}
 const noTools={model:'gemini-4-argon'};enableGeminiArgumentStreaming(noTools);assert.equal(noTools.toolConfig,undefined);
});

test('UTF-8 split at every byte: one completed call, exact string/signature/id, empty progress, usage',async()=>{
 const r=adaptGeminiArgumentStream(response(simple,1));assert.equal(r.headers.get('content-length'),null);
 const frames=parse(await r.text());const got=calls(frames);assert.equal(got.length,1);assert.deepEqual(got[0],{thoughtSignature:'exact-signature',functionCall:{name:'echo',id:'call1',args:{message:'你好，世界'}}});
 assert.deepEqual(frames[0].candidates[0].content.parts,[{text:''}]);assert.deepEqual(frames.at(-1).usageMetadata,end.usageMetadata);
});

test('arrays, nested objects, quoted keys, empty containers, false/zero/null and prototype-like JSON keys',async()=>{
 const fragments=[
  {jsonPath:'$.items[0].value',numberValue:0},{jsonPath:'$.items[1].value',boolValue:false},{jsonPath:'$.items[]'},
  {jsonPath:'$.empty[]'},{jsonPath:'$.object'},{jsonPath:'$["quoted.key"][\'escaped\\\'key\']',stringValue:'v'},
  {jsonPath:'$.__proto__.polluted',stringValue:'data'},{jsonPath:'$.constructor.prototype',nullValue:null}
 ];
 const frames=parse(await adaptGeminiArgumentStream(response([frame({name:'nested',partialArgs:fragments}),end])).text());
 const args=calls(frames)[0].functionCall.args;
 assert.deepEqual(args.items,[{value:0},{value:false}]);assert.deepEqual(args.empty,[]);assert.deepEqual(args.object,{});
 assert.equal(args['quoted.key']["escaped'key"],'v');assert.equal(Object.getPrototypeOf({}).polluted,undefined);assert.equal(args.__proto__.polluted,'data');assert.equal(args.constructor.prototype,null);
});

test('sequential calls and candidate isolation do not merge arguments or duplicate calls',async()=>{
 const frames=[frame({name:'a',id:'a',partialArgs:[{jsonPath:'$.x',stringValue:'A'}],willContinue:true}),
  {candidates:[{index:1,content:{parts:[{functionCall:{name:'b',id:'b',partialArgs:[{jsonPath:'$.x',stringValue:'B'}]}}]}}]},frame({}),
  frame({name:'c',args:{ready:true}}),end];
 const out=calls(parse(await adaptGeminiArgumentStream(response(frames)).text()));
 assert.deepEqual(out.map(p=>[p.functionCall.name,p.functionCall.args]),[['b',{x:'B'}],['a',{x:'A'}],['c',{ready:true}]]);
});

test('unfinished calls, invalid paths and interleaved call identities fail closed',async()=>{
 const start=frame({name:'a',id:'a',partialArgs:[{jsonPath:'$.s',stringValue:'unfinished',willContinue:true}],willContinue:true});
 for(const frames of [[start],[start,end],[start,frame({})],[start,frame({name:'b',id:'b',willContinue:true})],
  [frame({name:'a',partialArgs:[{jsonPath:'$..x',numberValue:1}]})],
  [frame({name:'a',partialArgs:[{jsonPath:'$.x[100001]',numberValue:1}]})]]){
  await assert.rejects(adaptGeminiArgumentStream(response(frames)).text(),/invalid or incomplete/);
 }
});

test('HTTP errors/JSON pass through; source failures and caller cancellation propagate',async()=>{
 for(const r of [new Response('denied',{status:403}),new Response('{}',{headers:{'content-type':'application/json'}})])assert.equal(adaptGeminiArgumentStream(r),r);
 let cancelled=false;
 const source=new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode(encode([simple[0]])));},cancel(){cancelled=true;}});
 const reader=adaptGeminiArgumentStream(new Response(source,{headers:{'content-type':'text/event-stream'}})).body.getReader();
 await reader.read();await reader.cancel();await new Promise(r=>setImmediate(r));assert.equal(cancelled,true);
 const broken=new ReadableStream({start(c){c.error(new Error('upstream closed'));}});
 await assert.rejects(adaptGeminiArgumentStream(new Response(broken,{headers:{'content-type':'text/event-stream'}})).text(),/upstream closed/);
});


async function fixture(t, reply = () => response(simple), forceRefresh = async () => undefined) {
  const seen=[];
  const gateway=createGateway({gatewayPrefix:'/fixture',enabledRoutes:['google'],apiBaseURL:'https://offline.invalid',
    resolver:{resolve:async()=>({token:'offline-fixture'}),forceRefresh},
    fetchImpl:async(url,init)=>{seen.push({url,body:JSON.parse(init.body),signal:init.signal});return reply();}});
  const server=http.createServer((req,res)=>{
    const route=gateway.routes.find(r=>r.path===new URL(req.url,'http://localhost').pathname);
    if(route)void route.handler(req,res);else{res.statusCode=404;res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const model={id:'gemini-4-argon',name:'fixture',provider:'factory-google',api:'google-generative-ai',reasoning:true,
    input:['text'],contextWindow:1000000,maxTokens:65536,baseUrl:`http://127.0.0.1:${server.address().port}/fixture/google`,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  return{seen,model};
}
const tools=[{name:'echo',description:'fixture',parameters:{type:'object',properties:{message:{type:'string'}},required:['message']}}];
const context={messages:[{role:'user',content:'fixture',timestamp:1}],tools};
const collect=async stream=>{const events=[];for await(const event of stream)events.push(event);return events;};

test('gateway and native transport: one complete signed call, unchanged limits/effort, exact replay and progress',async t=>{
 const f=await fixture(t);
 const events=await collect(streamGoogleNative(f.model,context,{reasoning:'high',maxTokens:4096}));
 assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).reason,'toolUse');
 assert.equal(events.filter(e=>e.type==='toolcall_end').length,1);assert(events.filter(e=>e.type==='text_delta'&&e.delta==='').length>=2);
 const call=events.at(-1).message.content.find(b=>b.type==='toolCall');
 assert.deepEqual(call.arguments,{message:'你好，世界'});assert.equal(call.thoughtSignature,'exact-signature');assert.equal(call.id,'call1');
 assert.deepEqual(f.seen[0].body.generationConfig,{maxOutputTokens:4096,thinkingConfig:{includeThoughts:true,thinkingLevel:'HIGH'}});
 assert.equal(f.seen[0].body.toolConfig.functionCallingConfig.streamFunctionCallArguments,true);
 await collect(streamGoogleNative(f.model,{...context,messages:[...context.messages,events.at(-1).message,
   {role:'toolResult',toolCallId:call.id,toolName:'echo',content:[{type:'text',text:'OK'}],isError:false,timestamp:2}]}));
 const replay=f.seen[1].body.contents.flatMap(c=>c.parts).find(p=>p.functionCall);
 assert.deepEqual(replay,{functionCall:{name:'echo',args:{message:'你好，世界'},id:'call1'},thoughtSignature:'exact-signature'});
});

test('gateway: incomplete argument stream is an error and cannot emit a tool call',async t=>{
 const f=await fixture(t,()=>response([simple[0]]));
 const events=await collect(streamGoogleNative(f.model,context));
 assert.equal(events.at(-1).type,'error');assert(!events.some(e=>e.type==='done'||e.type.startsWith('toolcall_')));
});

test('gateway: 401 without refreshed credentials passes through without exposing partial calls',async t=>{
 let attempts=0;
 const f=await fixture(t,()=>{attempts++;return new Response('unauthorized',{status:401});});
 const events=await collect(streamGoogleNative(f.model,context));
 assert.equal(events.at(-1).type,'error');assert.equal(attempts,1);assert(!events.some(e=>e.type.startsWith('toolcall_')));
});

test('gateway: credential refresh retries an identical streaming request and yields one complete call',async t=>{
 let attempts=0,refreshes=0;
 const f=await fixture(t,()=>++attempts===1?new Response('unauthorized',{status:401}):response(simple),
   async()=>{refreshes++;return{token:'refreshed-fixture'};});
 const events=await collect(streamGoogleNative(f.model,context));
 assert.equal(refreshes,1);assert.equal(attempts,2);assert.equal(events.at(-1).type,'done');
 assert.deepEqual(f.seen[1].body,f.seen[0].body);
 assert.equal(f.seen[1].body.toolConfig.functionCallingConfig.streamFunctionCallArguments,true);
 const emitted=events.filter(e=>e.type==='toolcall_end');assert.equal(emitted.length,1);
 assert.deepEqual(emitted[0].toolCall.arguments,{message:'你好，世界'});
 assert.equal(emitted[0].toolCall.thoughtSignature,'exact-signature');
});

test('real DSH adapter: argument progress resets idle timeout until one complete call arrives',{skip:!process.env.DSH_FACTORY_HOST_ROOT},async t=>{
 const root=process.env.DSH_FACTORY_HOST_ROOT;
 const {PiAiAdapter}=await import(pathToFileURL(path.join(root,'@deepseek-ai/dsh-llm-pi-ai/lib/index.js')));
 const frames=[simple[0],...Array.from({length:12},()=>frame({partialArgs:[{jsonPath:'$.message',stringValue:'.',willContinue:true}],willContinue:true})),simple[1],simple[2],end];
 const f=await fixture(t,()=>new Response(new ReadableStream({async start(c){for(const item of frames){c.enqueue(new TextEncoder().encode(encode([item])));await new Promise(r=>setTimeout(r,30));}c.close();}}),{headers:{'content-type':'text/event-stream'}}));
 const profiles=new Map([['factory-google',{modelErrors:new Map(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:150}]]);
 const base={profiles,models:{getModel:()=>f.model,streamSimple(){throw new Error('Unscoped protocol invoked');}}};
 const snapshot=scopeGoogleSdk(base,{provider:'factory-google'});
 const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>undefined});adapter.snapshot=snapshot;
 const started=performance.now();
 const chunks=await collect(adapter.stream({provider:'factory-google',model:'gemini-4-argon',messages:[{role:'user',content:[{type:'text',text:'fixture'}]}],tools}));
 assert(performance.now()-started>400);assert(chunks.filter(c=>c.type==='text-delta'&&c.text==='').length>=12);
 assert.equal(chunks.at(-1).type,'finish');assert.notEqual(chunks.at(-1).reason.kind,'error');
 const calls=chunks.filter(c=>c.type==='block-end'&&c.block.type==='tool-call');assert.equal(calls.length,1);
 assert.equal(JSON.parse(calls[0].block.arguments).message,'你好'+'.'.repeat(12)+'，世界');
});
