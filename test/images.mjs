import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { collectRequestImages, imageBudgetPlan, prepareAdaptiveImages, installAdaptiveImages } from '../lib/images.js';
import { createGateway } from '../lib/gateway.js';
process.env.DSH_FACTORY_JOURNAL=path.join(os.tmpdir(),`factory-image-test-${process.pid}.jsonl`);
const root=process.env.DSH_FACTORY_HOST_ROOT;
const host=name=>import(pathToFileURL(path.join(root,'@deepseek-ai',name,'lib/index.js')));
const skip=!root;
const ref=i=>({attachmentId:`sha256:${String(i).padStart(64,'0')}`,mediaType:'image/png',width:2400,height:1600,bytes:1048576});
const message=(count,start=0)=>({role:'user',content:[{type:'text',text:'Compare these images.'},...Array.from({length:count},(_,i)=>({type:'image',attachment:ref(i+start)}))]});
const options=(count)=>({provider:'factory-a',model:'claude-sonnet-5-5',messages:[message(count)]});
const profile={maxRequestImageBytes:3145728,requestImageMaxBytes:1048576,requestImagePixelBudget:4194304};
function store(size=target=>Math.min(target.maxBytes,180000)) { let active=0,maxActive=0;const calls=[];return {calls,get maxActive(){return maxActive;},async readImageRequest(ref,target,signal){signal?.throwIfAborted();calls.push({ref,target});active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setImmediate(resolve));active--;const bytes=size(target,ref);return {variantId:'sha256:'+String(target.maxBytes).padStart(64,'0'),attachment:ref,mediaType:'image/jpeg',width:target.width,height:target.height,bytes:1,data:new Uint8Array(bytes)};}}; }

test('multi-image plan: 3/20/50/100 occurrences count base64, fit lower targets and reserve text/tools',()=>{
 const targets=[3,20,50,100].map(n=>imageBudgetPlan(options(n),profile));
 assert.equal(targets[0].maxBytes,204800);assert(targets[1].maxBytes<targets[0].maxBytes);assert(targets[2].maxBytes<targets[1].maxBytes);
 for(const p of targets)assert(p.budget<=3145728&&p.maxEdge<=1024);
 const rich=options(20);rich.messages.unshift({role:'system',content:[{type:'text',text:'资料'.repeat(450000)}]});
 assert(imageBudgetPlan(rich,profile).budget<targets[1].budget);
 assert.equal(imageBudgetPlan(options(3),profile,{factoryRequestMaxBytes:0}).budget,3145728);
});
test('multi-image preparation: preserve a fresh batch, measure real bytes, deduplicate references and bound encoders',async()=>{
 const request=options(20);request.messages[0].content.push({type:'image',attachment:ref(0)});const original=JSON.stringify(request),native=store();
 const result=await prepareAdaptiveImages(request,profile,native);assert.equal(result.failure,undefined);assert.equal(result.plan.count,21);assert.equal(result.versions.size,20);assert.equal(native.calls.length,20);assert(native.maxActive<=4);
 assert.equal(JSON.stringify(request),original);assert([...result.versions.values()].every(v=>v.bytes===v.data.byteLength));
 const large=await prepareAdaptiveImages(options(50),profile,store());assert.equal(large.failure,undefined);assert.equal(large.versions.size,50);
});
test('multi-image preparation: codec returning too-large output is resized again from the original source',async()=>{
 const native=store((target)=>target.width>750?400000:100000);const result=await prepareAdaptiveImages(options(3),profile,native);
 assert.equal(result.failure,undefined);assert.equal(native.calls.length,6);assert(native.calls.some(c=>c.target.width<750));assert([...result.versions.values()].every(v=>v.bytes===100000));
});
test('multi-image preparation: historical overload requests only old-image offload; impossible fresh batch is explicit',async()=>{
 const request={...options(1),messages:[...Array.from({length:5},(_,i)=>message(20,i*20))]};
 const result=await prepareAdaptiveImages(request,profile,store(()=>40000));assert.equal(result.failure.reason.failure.code,'IMAGE_OFFLOAD_REQUIRED');assert(result.failure.reason.failure.offloadImages<=80);
 const fresh=await prepareAdaptiveImages(options(20),profile,store(()=>300000));assert.equal(fresh.failure.reason.failure.code,'MULTI_IMAGE_BUDGET_EXCEEDED');assert.equal(fresh.failure.reason.failure.offloadImages,undefined);
});
test('multi-image preparation: long text triggers history recovery; abort stops before image access',async()=>{
 const request=options(3);request.messages.unshift({role:'system',content:[{type:'text',text:'x'.repeat(4000000)}]});const result=await prepareAdaptiveImages(request,profile,store());assert.equal(result.failure.reason.failure.status,413);
 const controller=new AbortController();controller.abort();const native=store();await assert.rejects(prepareAdaptiveImages({...options(3),signal:controller.signal},profile,native));assert.equal(native.calls.length,0);
});

async function nativeFixture({config={},storeImpl=store()}={}){
 const [{Context},{PiAiAdapter}]=await Promise.all([host('cordis'),host('dsh-llm-pi-ai')]);
 const ctx=new Context(),seen=[],headers=[],profiles=new Map();let settings=config;
 for(const provider of ['factory-a','factory-g','factory-o','unrelated'])profiles.set(provider,{...profile,modelErrors:new Map(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:60000});
 const model={id:'claude-sonnet-5-5',name:'fixture',api:'anthropic-messages',provider:'offline',input:['text','image'],contextWindow:1000000,maxTokens:128000,reasoning:false};
 const models={getModel:(_provider,id)=>({...model,id}),streamSimple:async function*(_model,context,sdk){seen.push(context);headers.push(sdk.headers);yield {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'ok'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2},api:'anthropic-messages',provider:'offline',model:'fixture'}};}};
 const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>undefined,resolveAttachments:()=>storeImpl});
 adapter.snapshot={profiles,models};ctx.provide('llm',{registration:()=>({adapter})});const state={},records=[];
 const dispose=installAdaptiveImages(ctx,()=>settings,state,r=>records.push(r));await new Promise(resolve=>setImmediate(resolve));
 return {ctx,adapter,profiles,seen,headers,state,records,store:storeImpl,dispose,setConfig:c=>{settings=c;}};
}
async function consume(stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return chunks;}
test('real native adapter: summary metadata is scoped to text/image compaction, including image opt-out', {skip}, async()=>{
 const f=await nativeFixture({config:{factoryAdaptiveImages:false}});try{
  f.profiles.get('factory-a').headers={'x-existing':'fixture'};
  const request={...options(1),messages:[{role:'user',content:[{type:'text',text:'Summarize.'}]}],purpose:'compaction'};
  const call=await f.adapter.prepareCall(request.provider,request.model);await consume(call.stream(request));
  assert.equal(f.headers[0]['x-dsh-factory-purpose'],'compaction');assert.equal(f.headers[0]['x-existing'],'fixture');
  assert.equal(f.profiles.get('factory-a').headers['x-dsh-factory-purpose'],undefined);
  await consume(f.adapter.stream({...request,purpose:'chat'}));assert.equal(f.headers[1]['x-dsh-factory-purpose'],undefined);
  await consume(f.adapter.stream({...options(1),purpose:'compaction'}));assert.equal(f.headers[2]['x-dsh-factory-purpose'],'compaction');
  assert.equal(f.store.calls.at(-1).target.maxBytes,1048576);
  await consume(f.adapter.stream({...request,purpose:'chat',sessionId:'native-session-a'}));
  assert.match(f.headers[3]['x-dsh-factory-session'],/^[a-f0-9]{64}$/);
  assert(!f.headers[3]['x-dsh-factory-session'].includes('native-session-a'));
  await consume(f.adapter.stream({...request,purpose:'chat',sessionId:'native-session-b'}));
  assert.notEqual(f.headers[3]['x-dsh-factory-session'],f.headers[4]['x-dsh-factory-session']);
  assert.equal(f.profiles.get('factory-a').headers['x-dsh-factory-session'],undefined);
 }finally{f.dispose();}
});
for(const [provider,model]of [['factory-a','claude-sonnet-5-5'],['factory-a','claude-opus-5-5'],['factory-g','glm-5.3-flash'],['factory-o','gpt-6-sol']])test(`real native PiAiAdapter: ${provider}/${model} sends all 20 fresh images with smaller prepared versions`,{skip},async()=>{
 const f=await nativeFixture();try{
  const request={...options(20),provider,model};const original=JSON.stringify(request);const call=await f.adapter.prepareCall(provider,model);const chunks=await consume(call.stream(request));
  assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(f.seen.length,1);const images=f.seen[0].messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='image');assert.equal(images.length,20);
  assert(images.every(b=>Buffer.byteLength(b.data)<204800*4/3));assert.equal(JSON.stringify(request),original);assert.equal(f.profiles.get(provider).requestImageMaxBytes,1048576);assert.equal(f.state.state,'active');
 }finally{f.dispose();}
});
test('real native adapter: calls are isolated; disabling, unrelated route, HMR and unload preserve behavior',{skip},async()=>{
 const f=await nativeFixture();try{
  await Promise.all([consume(f.adapter.stream(options(3))),consume(f.adapter.stream(options(20)))]);
  assert.equal(f.seen[0].messages[0].content.filter(b=>b.type==='image').length,3);assert.equal(f.seen[1].messages[0].content.filter(b=>b.type==='image').length,20);
  assert(f.store.calls.some(c=>c.target.maxBytes===204800));assert(f.store.calls.some(c=>c.target.maxBytes<204800));
  f.setConfig({factoryAdaptiveImages:false});await consume(f.adapter.stream(options(3)));assert.equal(f.store.calls.at(-1).target.maxBytes,1048576);
  f.setConfig({});await consume(f.adapter.stream({...options(3),provider:'unrelated'}));assert.equal(f.store.calls.at(-1).target.maxBytes,1048576);
  f.ctx.emit('llm/adapters-updated');assert.equal(f.state.adapters,1);f.dispose();assert.equal(Object.hasOwn(f.adapter,'streamWithSnapshot'),false);
  f.ctx.emit('llm/adapters-updated');assert.equal(Object.hasOwn(f.adapter,'streamWithSnapshot'),false);
 }finally{f.dispose();}
});
test('real native adapter: excessive fresh batch fails before SDK dispatch and original image budget remains unchanged',{skip},async()=>{
 const f=await nativeFixture({storeImpl:store(()=>300000)});try{const chunks=await consume(f.adapter.stream(options(20)));assert.equal(chunks.at(-1).reason.failure.code,'MULTI_IMAGE_BUDGET_EXCEEDED');assert.equal(f.seen.length,0);assert.equal(f.profiles.get('factory-a').maxRequestImageBytes,3145728);}finally{f.dispose();}
});

test('real image codec + native adapter + gateway: 3/20 fresh and 50 cumulative noisy images fit, alpha is retained, originals unchanged', {skip}, async t=>{
 const [{Context},{LocalAttachmentStore}]=await Promise.all([host('cordis'),host('dsh-attachment-local')]);
 const req=createRequire(path.join(root,'@deepseek-ai/dsh-attachment-local/lib/index.js'));const sharp=req('sharp');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'factory-real-image-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const nativeStore=new LocalAttachmentStore(new Context(),{dshHome:temp});
 let state=123456;const pixels=Buffer.alloc(1280*960*3);for(let i=0;i<pixels.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;pixels[i]=state&255;}
 const opaque=await sharp(pixels,{raw:{width:1280,height:960,channels:3}}).png().toBuffer();
 const rgba=await sharp(opaque).ensureAlpha(0.7).png().toBuffer();
 const inputs=[{data:new Uint8Array(rgba),mediaType:'image/png',name:'alpha'}];
 for(let i=1;i<20;i++){const unique=Buffer.from(pixels);unique[i*31]=(unique[i*31]+i)&255;inputs.push({data:new Uint8Array(await sharp(unique,{raw:{width:1280,height:960,channels:3}}).png().toBuffer()),mediaType:'image/png',name:`opaque-${i}`});}
 const refs=await nativeStore.saveImages(inputs);assert.equal(new Set(refs.map(r=>r.attachmentId)).size,20);const evidence=[];
 const originals=await Promise.all(refs.map(ref=>nativeStore.readImage(ref)));const snapshots=originals.map(image=>Buffer.from(image.data));
 const forwarded=[];const gateway=createGateway({gatewayPrefix:'/image-e2e',resolver:{resolve:async()=>({token:'offline-fixture'})},fetchImpl:async(url,init)=>{forwarded.push(JSON.parse(init.body));return new Response('{}',{headers:{'content-type':'application/json'}});}});
 const server=http.createServer((req,res)=>{void gateway.routes.find(r=>r.path===req.url).handler(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const f=await nativeFixture({storeImpl:nativeStore});t.after(f.dispose);
 for(const count of [3,20,50]){
  const request={...options(count),messages:Array.from({length:Math.ceil(count/20)},(_,batch)=>({role:'user',content:[{type:'text',text:'Compare all images.'},...Array.from({length:Math.min(20,count-batch*20)},(_,i)=>({type:'image',attachment:refs[(batch*20+i)%refs.length]}))]}))};
  const chunks=await consume(f.adapter.stream(request));assert.equal(chunks.at(-1).reason.kind,'stop');
  const context=f.seen.at(-1);const blocks=context.messages.flatMap(m=>m.content).filter(b=>b.type==='image');assert.equal(blocks.length,count);
  const body={model:request.model,max_tokens:32,messages:context.messages.map(m=>({role:'user',content:m.content.map(b=>b.type==='image'?{type:'image',source:{type:'base64',media_type:b.mimeType,data:b.data}}:b)}))};
  const response=await fetch(`http://127.0.0.1:${server.address().port}/image-e2e/a/v1/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);await response.text();
  const wire=forwarded.at(-1);assert(Buffer.byteLength(JSON.stringify(wire))<4194304);assert.equal(wire.messages.flatMap(m=>m.content).filter(b=>b.type==='image').length,count);
  const alpha=blocks.find(b=>b.mimeType==='image/webp');assert(alpha);const meta=await sharp(Buffer.from(alpha.data,'base64')).metadata();assert(meta.hasAlpha);assert(meta.width<=1024);
  evidence.push({images:count,uniqueImages:new Set(request.messages.flatMap(m=>m.content).filter(b=>b.type==='image').map(b=>b.attachment.attachmentId)).size,finalBodyBytes:Buffer.byteLength(JSON.stringify(wire)),imageBase64Bytes:blocks.reduce((sum,b)=>sum+Buffer.byteLength(b.data),0),alphaWidth:meta.width});
 }
 if(process.env.DSH_FACTORY_IMAGE_EVIDENCE)fs.writeFileSync(process.env.DSH_FACTORY_IMAGE_EVIDENCE,JSON.stringify(evidence,null,2));
 for(let i=0;i<refs.length;i++)assert.deepEqual(Buffer.from((await nativeStore.readImage(refs[i])).data),snapshots[i]);
});

test('native image admission: upload limit is separate from model-request compression', {skip},async()=>{
 const {DEFAULT_MAX_IMAGES_PER_MESSAGE}=await host('dsh-attachment-local');assert.equal(DEFAULT_MAX_IMAGES_PER_MESSAGE,20);
});

test('real native adapter: unsupported image model is rejected before compression', {skip},async()=>{
 const f=await nativeFixture();try{f.adapter.snapshot.models.getModel=(_provider,id)=>({id,input:['text'],api:'anthropic-messages',contextWindow:1000000,maxTokens:128000});
 await assert.rejects(consume(f.adapter.stream(options(3))),/does not support image input/);assert.equal(f.store.calls.length,0);
 }finally{f.dispose();}
});
test('real native adapter: compaction images use the same preparation; cancellation during encoding never dispatches SDK',{skip},async()=>{
 const f=await nativeFixture();try{await consume(f.adapter.stream({...options(20),purpose:'compaction'}));assert.equal(f.records.at(-1).purpose,'compaction');assert.equal(f.records.at(-1).images,20);}finally{f.dispose();}
 const controller=new AbortController();const native={async readImageRequest(_ref,_target,signal){await new Promise(resolve=>setImmediate(resolve));controller.abort();signal.throwIfAborted();}};
 const cancelled=await nativeFixture({storeImpl:native});try{await assert.rejects(consume(cancelled.adapter.stream({...options(20),signal:controller.signal})));assert.equal(cancelled.seen.length,0);}finally{cancelled.dispose();}
});
test('adaptive hook: unknown adapters are visibly unsupported and never patched',{skip},async()=>{
 const {Context}=await host('cordis');const ctx=new Context(),adapter={streamWithSnapshot(){}};
 const original=adapter.streamWithSnapshot;ctx.provide('llm',{registration:()=>({adapter})});const status={};const dispose=installAdaptiveImages(ctx,()=>({}),status);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(status.state,'unsupported');assert.equal(adapter.streamWithSnapshot,original);dispose();
});
test('image budget: offloaded image handles still reserve request space',()=>{
 const request=options(3),baseline=imageBudgetPlan(request,profile);
 request.messages.unshift({role:'user',content:Array.from({length:2000},(_,i)=>({type:'image',attachment:ref(i+100),offloaded:true}))});
 const next=imageBudgetPlan(request,profile);assert.equal(next.count,3);assert(next.budget<baseline.budget);assert(next.estimatedOtherBytes>baseline.estimatedOtherBytes);
});
test('image resizing: preview dimensions do not additionally change the derived affinity key or rewrite prompts',async()=>{
 const {sessionKeyParts,createSessionIdMap}=await import('../lib/session.js');
 const id='a'.repeat(64),body=edge=>({messages:[{role:'user',content:[{type:'text',text:`Compare. Image "picture" (sha256:${id}); request preview ${edge}x512px. It may be resized or re-encoded.`}]}]});
 const a=body(1024),b=body(717),original=JSON.stringify(b);const first=sessionKeyParts('anthropic',a),second=sessionKeyParts('anthropic',b);assert.deepEqual(first,second);
 assert.equal(JSON.stringify(b),original);const ids=createSessionIdMap();assert.equal(ids.derive({model:'claude-sonnet-5-5',...first}),ids.derive({model:'claude-sonnet-5-5',...second}));
 const different=body(1024);different.messages[0].content[0].text=different.messages[0].content[0].text.replace(id,'b'.repeat(64));assert.notDeepEqual(sessionKeyParts('anthropic',different),first);
});

test('image compression buckets: nearby image counts reuse the same target and long-edge limit',()=>{
 const a=imageBudgetPlan(options(20),profile),b=imageBudgetPlan(options(21),profile);
 assert.equal(a.maxBytes,b.maxBytes);assert.equal(a.maxEdge,b.maxEdge);assert.equal(a.maxBytes,102400);
});
