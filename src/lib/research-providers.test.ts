import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResearchProviders } from './research-providers.js';
test('MCP adapter calls only search with observed schema and closes its session',async()=>{
  const methods:string[]=[];let args:any;
  const fetcher=async(_input:any,init:any={})=>{
    const body=JSON.parse(init.body??'{}');methods.push(body.method??init.method);
    if(init.method==='DELETE')return new Response(null,{status:204});
    let result:any={};
    if(body.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    if(body.method==='tools/list')result={tools:[{name:'web_search_exa',inputSchema:{type:'object',properties:{query:{type:'string'},objective:{type:'string'},numResults:{type:'number'}},required:['query','objective']}}]};
    if(body.method==='tools/call'){args=body.params;result={content:[{type:'text',text:'Title: 原始报道\nURL: https://news.example.com/a\nPublished: N/A\nAuthor: 测试\nHighlights:\n公开来源摘录。'}]};}
    if(body.id===undefined)return new Response(null,{status:202});
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'Content-Type':'application/json','Mcp-Session-Id':'fixture'}});
  };
  const p=createResearchProviders(fetcher as any,async()=>{});const rows=await p.search('技术',new AbortController().signal);
  assert.equal(rows[0].url,'https://news.example.com/a');assert.equal(rows[0].publishedAt,undefined);
  assert.equal(args.name,'web_search_exa');assert.equal(args.arguments.numResults,5);assert.ok(args.arguments.objective);
  assert.ok(methods.includes('DELETE'));assert.ok(!methods.includes('agent_run'));
});
test('Jina target 403 is unreadable even with HTTP 200; HTTP 429 remains explicit',async()=>{
  let limited=false;
  const p=createResearchProviders((async()=>limited?new Response('',{status:429}):new Response('Title: 新闻\nWarning: Target URL returned error 403: Forbidden\nMarkdown Content:\n未登录')) as any,async()=>{});
  const read=await p.readJina('https://news.example.com/a',new AbortController().signal);assert.equal(read.status,'needs_material');assert.equal(read.error?.code,'blocked');
  limited=true;await assert.rejects(p.readJina('https://news.example.com/a',new AbortController().signal),(e:any)=>e.status===429);
});
