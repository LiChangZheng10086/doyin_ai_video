import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient } from './api.js';
test('research requests propagate abort, deadlines, selection hashes and article version',async()=>{
  const client=new ApiClient();const calls:any[]=[];
  client.getClient=async()=>({request:async(config:any)=>{calls.push(config);return {data:{result:{},article:{},item:{}}};}}) as any;
  const controller=new AbortController();await client.searchResearch('测试',controller.signal);await client.readResearch({url:'https://news.example.com/a'},controller.signal);await client.importResearchSources('id',3,[{readId:'r',hash:'h'}]);
  assert.equal(calls[0].timeout,40000);assert.equal(calls[0].signal,controller.signal);assert.equal(calls[1].timeout,65000);assert.equal(calls[1].signal,controller.signal);
  assert.deepEqual(calls[2].data,{version:3,selections:[{readId:'r',hash:'h'}]});
});
