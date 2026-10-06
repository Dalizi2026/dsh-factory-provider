import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createGateway } from '../lib/gateway.js';
import { readJournal } from '../lib/journal.js';
import { requestSizeBreakdown, smallerSummaryInput, isRequestTooLarge } from '../lib/request-size.js';
import { sanitizeAnthropicPayload, normalizeResponsesPayload } from '../lib/sanitize.js';
import { applyAnthropicCacheBreakpoints } from '../lib/cache.js';
process.env.DSH_FACTORY_JOURNAL=path.join(os.tmpdir(),`factory-size-test-${process.pid}.jsonl`);
async function fixture(t, options={}) {
  const seen=[];let credentials=0;
  const gateway=createGateway({gatewayPrefix:'/fixture',enabledRoutes:['anthropic','generic','openai'],
    resolver:{resolve:async()=>{credentials++;return {token:'offline-fixture'};}},
    fetchImpl:async(url,opts)=>{seen.push({url,body:JSON.parse(opts.body)});return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}});},...options});
  const server=http.createServer((req,res)=>{const route=gateway.routes.find(r=>r.kind==='exact'&&r.path===req.url);if(route) void route.handler(req,res);else res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  return {gateway,seen,get credentials(){return credentials;},async post(route,body){return fetch(`http://127.0.0.1:${server.address().port}/fixture/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}};
}
test('byte budget: UTF-8 serialized JSON is counted, including tools, envelope and escaping',()=>{
  const p={system:'系统',tools:[{name:'tool',description:'"\n'}],messages:[{role:'user',content:'汉字😀'.repeat(10)}]};
  const size=requestSizeBreakdown(p);assert.equal(size.bodyBytes,Buffer.byteLength(JSON.stringify(p)));assert(size.bodyBytes>JSON.stringify(p).length);
  assert.equal(size.largestMessageBytes,Buffer.byteLength(JSON.stringify(p.messages[0])));
});
test('summary input: reduce text without touching ids, signed blocks, tool pairs, system, final message or originals',()=>{
  const text='😀资料'.repeat(10000), signed={type:'thinking',thinking:text,signature:'signed'};
  const input={tools:[{name:'inspect'}],messages:[{role:'system',content:[{type:'text',text}]},{role:'user',content:[{type:'text',text}]},{role:'assistant',content:[signed,{type:'tool-call',id:'tc-keep',name:'inspect',input:{path:text}}]},{role:'tool',content:[{type:'text',text}],toolCallId:'tc-keep'},{role:'user',content:[{type:'text',text:'latest'}]}]};
  const snapshot=JSON.stringify(input),next=smallerSummaryInput(input);
  assert(requestSizeBreakdown(next).bodyBytes<requestSizeBreakdown(input).bodyBytes);assert.equal(JSON.stringify(input),snapshot);
  assert.deepEqual(next.messages[0],input.messages[0]);assert.deepEqual(next.messages[2],input.messages[2]);assert.deepEqual(next.messages.at(-1),input.messages.at(-1));assert.deepEqual(next.tools,input.tools);assert.equal(next.messages[3].toolCallId,'tc-keep');
  assert(next.messages[1].content[0].text.isWellFormed());assert.match(next.messages[1].content[0].text,/Middle of long text omitted/);assert.equal(smallerSummaryInput({messages:[]}),null);
});
test('error classification: recognize HTTP/provider 413 only, not arbitrary numeric text or other failures',()=>{
  for(const f of [{status:413},{code:'413'},{code:'INVALID_REQUEST',message:'413 {error}'},{message:'Request Entity Too Large'}])assert.equal(isRequestTooLarge(f),true);
  for(const f of [{status:400,message:'invalid value 413'},{status:429,message:'rate limit'},{message:'file line 413 failed'}])assert.equal(isRequestTooLarge(f),false);
});
for(const [route,body] of [
 ['a/v1/messages',{model:'claude-sonnet-5-5',messages:[{role:'user',content:[{type:'text',text:'x'.repeat(319083)},...Array.from({length:13},()=>({type:'image',source:{type:'base64',media_type:'image/png',data:'a'.repeat(322197)}}))]}]}],
 ['o/v1/chat/completions',{model:'glm-5.3-flash',messages:[{role:'user',content:'汉'.repeat(1500000)}]}],
 ['openai/v1/responses',{model:'gpt-6-sol',input:[{type:'function_call_output',call_id:'tc-keep',output:[{type:'input_image',image_url:'data:image/png;base64,'+'a'.repeat(4200000)}]}]}],
]) test(`gateway whole-body guard: ${route} rejects before credential resolution or upstream fetch`,async t=>{
 const f=await fixture(t);const response=await f.post(route,body);assert.equal(response.status,413);const error=await response.json();assert.match(error.message,/local budget/);assert.equal(f.credentials,0);assert.equal(f.seen.length,0);
 const record=readJournal(1)[0];assert.equal(record.source,'local-budget');assert(record.requestSize.bodyBytes>record.budgetBytes);
 if(route.includes('responses')){assert.equal(record.shape.imageBlocks,1);assert.equal(record.shape.imageBase64Bytes,4200000);}
 if(route.startsWith('a/'))assert(record.shape.imageBase64Bytes<4194304,'reproduces image-only guard missing envelope bytes');
});
test('gateway final bytes: includes fast mode and cache rewrite; budget can be changed without restart',async t=>{
 const body={model:'claude-opus-5-5-fast',max_tokens:32,messages:[{role:'user',content:'hello'}]};
 const normalized=structuredClone(body);sanitizeAnthropicPayload(normalized);applyAnthropicCacheBreakpoints(normalized,{mode:'auto',ttl:'5m'});
 const f=await fixture(t,{requestMaxBytes:Buffer.byteLength(JSON.stringify(normalized))});
 const rejected=await f.post('a/v1/messages',body);assert.equal(rejected.status,413);await rejected.text();assert.equal(f.seen.length,0);
 f.gateway.configure({requestMaxBytes:0});const accepted=await f.post('a/v1/messages',body);assert.equal(accepted.status,200);await accepted.text();assert.equal(f.seen[0].body.speed,'fast');
});
test('gateway upstream 413: preserves status and body, records sizes without prompts or response text',async t=>{
 const f=await fixture(t,{fetchImpl:async()=>new Response(JSON.stringify({error:{code:'413',message:'Request Entity Too Large; private upstream detail'}}),{status:413})});
 const response=await f.post('o/v1/chat/completions',{model:'glm-5.3-flash',messages:[{role:'user',content:'private user content'}]});assert.equal(response.status,413);assert.match(await response.text(),/Request Entity Too Large/);
 const records=readJournal(5).filter(r=>r.event==='upstream-error');assert(records.length);assert(!JSON.stringify(records).includes('private'));assert.equal(records.at(-1).source,'upstream');
});
test('payload rewrite: signed thinking, redaction, encrypted reasoning and identity ids remain byte-identical',()=>{
 const text='You are powered by the model named';
 const blocks=[{type:'thinking',thinking:text,signature:text},{type:'redacted_thinking',data:text},{type:'image',source:{type:'base64',data:text}},{type:'tool_use',id:text,name:'inspect',input:{text}}];
 const p={messages:[{role:'assistant',content:structuredClone(blocks)}]};sanitizeAnthropicPayload(p);
 for(let i=0;i<3;i++)assert.deepEqual(p.messages[0].content[i],blocks[i]);assert.equal(p.messages[0].content[3].id,text);assert.notEqual(p.messages[0].content[3].input.text,text);
 const reasoning={type:'reasoning',id:text,encrypted_content:text,summary:[{type:'summary_text',text}]};const r={model:'gpt-6-sol',input:[structuredClone(reasoning)]};normalizeResponsesPayload(r);assert.deepEqual(r.input[0],reasoning);
});

test('usage diagnostics: OpenAI cache reads are part of total input, Responses input detail is recognized',async t=>{
 for(const [route,usage] of [['o/v1/chat/completions',{prompt_tokens:1000,prompt_tokens_details:{cached_tokens:800},completion_tokens:10}],['openai/v1/responses',{input_tokens:1000,input_tokens_details:{cached_tokens:800},output_tokens:10}]]){
  const f=await fixture(t,{fetchImpl:async()=>new Response(`data: ${JSON.stringify({usage})}\n\n`,{headers:{'content-type':'text/event-stream'}})});
  const body=route.includes('responses')?{model:'gpt-6-sol',input:[{role:'user',content:'hello'}]}:{model:'glm-5.3-flash',messages:[{role:'user',content:'hello'}]};
  const response=await f.post(route,body);await response.text();const record=readJournal(100).findLast(entry=>entry.event==='usage');
  assert.equal(record.event,'usage');assert.equal(record.input,200);assert.equal(record.read,800);assert.equal(record.totalInput,1000);assert.equal(record.hitRatio,0.8);
 }
});
