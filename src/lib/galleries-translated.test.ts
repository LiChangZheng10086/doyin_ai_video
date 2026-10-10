import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GalleryService } from './galleries.js';
import { LocalStorage } from './storage.js';
import type { JobRecord } from '../types.js';
import type { GalleryImage, GalleryTranslationCue } from './gallery-types.js';

async function fixture(fn: (s: GalleryService, storage: LocalStorage, fail: { value: boolean }) => Promise<void>) {
 const root = await mkdtemp(path.join(tmpdir(), 'gallery-translated-'));
 try {
  const storage = new LocalStorage(root); await storage.ensureBaseDirs();
  const videoPath = storage.resolve('raw/videos/job.mp4'); await writeFile(videoPath, 'safevideo');
  await storage.writeJsonAtomic('raw/transcripts/job.json', { transcript: 'Keep going. Believe in yourself.', segments: [{start:0,end:2,text:'Keep going.'},{start:2,end:4,text:'Believe in yourself.'}] });
  const fail = { value: false };
  const service = new GalleryService({ storage, jobs: { get: async () => ({id:'job',sourceUrl:'https://www.youtube.com/watch?v=abc',videoPath,topic:'测试'} as JobRecord) },
   translator: { translate: async (cues: GalleryTranslationCue[]) => { if(fail.value) throw new Error('translation failed'); return cues.map(c => ({...c,text:c.segmentIndex===0?'继续前行。':'相信自己。'})); } },
   media: {probe:async()=>({width:640,height:360,duration:10}),frame:async()=>Buffer.from('frame'),render:async(_v:string,image:GalleryImage,out:string)=>{await writeFile(out,JSON.stringify(image));}} });
  await fn(service, storage, fail);
 } finally {await rm(root,{recursive:true,force:true});}
}

test('translated gallery preserves originals, confirms Chinese plan and invalidates it when edited',async()=>fixture(async(s,storage)=>{
 const created=await s.create('job'); assert.equal(created.mode,'translated');
 await assert.rejects(s.render(created.id,created.version),/方案|译文/);
 const translated=await s.translate(created.id,{version:created.version,start:0,end:4});
 assert.equal(translated.translation?.cues[0]?.original,'Keep going.');
 await assert.rejects(s.update(translated.id,{...translated,translation:{...translated.translation!,cues:translated.translation!.cues.map(c=>({...c,original:'forged'}))}}),/原文|译文/);
 const planned=await s.plan(translated.id,{version:translated.version,targetLines:8,fullVideo:false});
 assert.equal(planned.plan?.mode,'translated'); assert.equal(planned.plan?.images[0]?.quotes[0]?.originalText,'Keep going.');
 assert.deepEqual(planned.plan?.images[0]?.image.translatedCaptions,['继续前行。','相信自己。']);
 await assert.rejects(s.renderPlan(planned.id,{version:planned.version,planId:planned.plan!.id,subtitlesConfirmed:false}),/核对/);
 const ready=await s.renderPlan(planned.id,{version:planned.version,planId:planned.plan!.id,subtitlesConfirmed:true});
 assert.equal((await s.preview(ready.id,ready.version)).imageCount,1);
 const edited=await s.update(ready.id,{...ready,translation:{...ready.translation!,cues:ready.translation!.cues.map((c,i)=>({...c,text:i===0?'坚持向前。':c.text}))}});
 assert.equal(edited.plan,undefined); assert.equal(edited.status,'draft');
 await assert.rejects(s.preview(edited.id,edited.version),/重新生成|方案/);
 assert.equal(edited.generated?.id,ready.generated?.id);
 await storage.writeJsonAtomic('raw/transcripts/job.json',{transcript:'changed',segments:[{start:0,end:2,text:'changed'}]});
 await assert.rejects(s.plan(edited.id,{version:edited.version}),/重新翻译|转录/);
}));

test('translation failure, bad ranges, stale version and foreign captions cannot replace drafts',async()=>fixture(async(s,_storage,fail)=>{
 const native=await s.create('job','native');
 await assert.rejects(s.update(native.id,{...native,images:native.images.map(i=>({...i,translatedCaptions:['伪造字幕']}))}),/译文/);
 const g=await s.create('job');
 await assert.rejects(s.translate(g.id,{version:g.version,start:5,end:4}),/范围/);
 const translated=await s.translate(g.id,{version:g.version,start:0,end:4});
 fail.value=true;
 await assert.rejects(s.translate(g.id,{version:translated.version,start:0,end:2}),/translation failed/);
 assert.deepEqual((await s.get(g.id)).translation,translated.translation);
 await assert.rejects(s.translate(g.id,{version:g.version,start:0,end:4}),/版本/);
 await assert.rejects(s.update(g.id,{...translated,images:translated.images.map(i=>({...i,translatedCaptions:['任意注入']}))}),/方案|译文/);
}));
