import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBoundedResponse, validateResearchUrl } from './research-http.js';
import { boundedNodeBody } from './research-http.js';
import { PassThrough } from 'node:stream';
import { createResearchFetch } from './research-http.js';
test('SDK transport pins the validated socket address, rejects redirects and propagates body cancellation',async()=>{
  let redirected=false;let response:PassThrough;let checked=false;
  const fetcher=createResearchFetch({resolveAddress:async input=>({url:new URL(input),address:'8.8.8.8',family:4}),request:((_url:any,options:any,onResponse:any)=>{
    options.lookup('news.example.com',{all:true},(error:any,rows:any)=>{assert.equal(error,null);assert.deepEqual(rows,[{address:'8.8.8.8',family:4}]);checked=true;});
    const req=new PassThrough();req.once('finish',()=>{
      response=new PassThrough();Object.assign(response,{statusCode:redirected?302:200,headers:{'content-type':'text/plain'}});onResponse(response);
      if(!redirected)response.write('正文');
    });return req;
  }) as any});
  const res=await fetcher('https://news.example.com/a');assert.equal(checked,true);const reader=res.body!.getReader();assert.ok((await reader.read()).value);await reader.cancel();assert.equal(response!.destroyed,true);
  redirected=true;await assert.rejects(fetcher('https://news.example.com/a'),/重定向/);
});
test('DNS rejection prevents opening a socket',async()=>{
  let opened=false;const fetcher=createResearchFetch({resolveAddress:async()=>{throw Error('公网验证失败');},request:(()=>{opened=true;}) as any});
  await assert.rejects(fetcher('https://news.example.com/a'),/公网/);assert.equal(opened,false);
});
test('cancelling an SDK stream prevents later native data/end events from enqueueing to a closed controller',async()=>{
  const source=new PassThrough();const body=boundedNodeBody(source,new AbortController().signal,8);
  await body.cancel();source.emit('data',Buffer.from('late'));source.emit('end');source.emit('error',new Error('late error'));
  await new Promise(r=>setImmediate(r));assert.equal(source.destroyed,true);
});
test('native response body enforces bytes and abort after headers',async()=>{
  const source=new PassThrough();const controller=new AbortController();const body=boundedNodeBody(source,controller.signal,8);
  const reader=body.getReader();source.write('123');assert.equal((await reader.read()).value?.length,3);
  const pending=reader.read();controller.abort();await assert.rejects(pending);assert.equal(source.destroyed,true);
  const tooLarge=new PassThrough();const bounded=boundedNodeBody(tooLarge,new AbortController().signal,8);tooLarge.write('123456789');await assert.rejects(bounded.getReader().read(),/过大/);
});
test('bounded responses cancel oversized streams and distinguish abort from successful completion',async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(9));},cancel(){cancelled=true;}}));
  await assert.rejects(readBoundedResponse(response,8),/过大/);assert.equal(cancelled,true);
  assert.equal(await readBoundedResponse(new Response('正文'),20),'正文');
});
test('research validates public DNS and rejects access tokens without forwarding them',async()=>{
  await assert.rejects(validateResearchUrl('https://news.example.com/a',async()=>[{address:'127.0.0.1',family:4}]),/公网/);
  await assert.rejects(validateResearchUrl('https://news.example.com/a?access_token=secret'),/凭据/);
  const result=await validateResearchUrl('https://news.example.com/a',async()=>[{address:'8.8.8.8',family:4}]);assert.equal(result.url.hostname,'news.example.com');
});
