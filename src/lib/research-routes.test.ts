import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../app.js';
test('research routes require session, report config without requests and reflect live changes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'research-api-'));const config={jinaEnabled:false,exaEnabled:false};
  const app=await createExpressApp({rootDir:root,storagePath:root,resolveResearchConfig:async()=>config});
  const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;let token='';
  const call=async(url:string,data?:unknown)=>fetch(base+url,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Local-Session':token},...(data?{body:JSON.stringify(data)}:{})});
  try{
    const status=await(await call('/api/research/status')).json();assert.equal(status.config.exaEnabled,false);assert.equal(status.providers.exa.state,'unverified');
    assert.equal((await call('/api/research/search',{query:'资料'})).status,401);
    token=(await(await call('/api/local-sessions/auto',{})).json()).session.token;
    assert.equal((await call('/api/research/search',{query:'资料'})).status,422);
    assert.equal((await call('/api/research/read',{url:'https://127.0.0.1/a'})).status,400);
    config.jinaEnabled=true;assert.equal((await(await call('/api/research/status')).json()).config.jinaEnabled,true);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
