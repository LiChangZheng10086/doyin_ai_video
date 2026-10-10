import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ActorSnapshot, PublishingPackageDetail, PublishTask } from '../types.js';
import { LocalStorage } from './storage.js';
import { articlePublicUrl, readArticleSource, type ArticleSourceRead } from './article-sources.js';
import { articleWritingFailure, validateWritingResult, type ArticleWritingService } from './article-writing.js';
import {parseArticleInput,recommendArticleLayout} from './article-input.js';
import { ARTICLE_STEPS, type ArticleRecord, type ArticleStep, type ArticlePreview, type ArticleMaterial, type ArticleAutoStage } from './article-types.js';
import { renderWechatArticleHtml } from './wechat-article.js';
import { wechatLayout, MODERN_WECHAT_LAYOUTS, FACTORY_WECHAT_LAYOUT, modernWechatLayout, validateWechatLayoutOptions, type WechatLayoutDefaults } from './wechat-templates.js';
import type { ResolvedAssetFile } from './assets-store.js';

const INDEX = 'cache/articles.json';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class ArticleError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'article_failed') { super(message); }
}
const field = (value: unknown, max: number, required = false): string => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ArticleError(422, '文字字段为空或超限');
  return value.trim();
};
const publicUrl = (value: string) => {try {return articlePublicUrl(value);}catch(e) {throw new ArticleError(422,(e as Error).message);}};
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArticleError(400, '参数应为对象');
  return value as Record<string, any>;
};
export type ArticlePackageInput = { article: ArticleRecord; draft: NonNullable<ArticleRecord['draft']>; html: string; cover: ResolvedAssetFile; images: ResolvedAssetFile[]; hashes: string[]; actor: ActorSnapshot };
type Deps = {
  storage: LocalStorage; writer: Pick<ArticleWritingService, 'run'>;
  readSource?: typeof readArticleSource;
  readResearchSource?: (actorId:string,url:string) => Promise<ArticleSourceRead>;
  resolveResearchSelections?: (actorId:string,selections:unknown) => Promise<ArticleSourceRead[]>;
  resolveHotspot?: (sourceId: string, itemId: string) => Promise<ArticleRecord['hotspot']>;
  resolveAsset?: (id: string) => Promise<ResolvedAssetFile | null>;
  createPackage?: (input: ArticlePackageInput) => Promise<PublishingPackageDetail>;
  previewDraftUpdate?: (taskId: string, input: ArticlePackageInput, articlePreviewRevision: string) => Promise<{ previewRevision: string; mediaId: string }>;
  updateDraft?: (taskId: string, input: ArticlePackageInput, articlePreviewRevision: string, previewRevision: unknown) => Promise<PublishTask>;
  resolveBenchmark?: (id: string) => Promise<{domain:string;audience:string;styleSample:string}>;
  checkAi?:()=>Promise<boolean>;
  illustrate?:(article:ArticleRecord,signal:AbortSignal)=>Promise<Pick<ArticleRecord,'coverAssetId'|'bodyImageAssetIds'|'bodyImagePlacements'>>;
  discardIllustrations?:(ids:string[])=>Promise<void>;
  verifyWechat?:()=>Promise<{ok:boolean;credentials:{message:string};draftPermission:{message:string}}>;
  submitWechat?:(taskId:string,actor:ActorSnapshot)=>Promise<PublishTask>;
  getWechatTask?:(taskId:string)=>Promise<PublishTask|undefined|null>;
};
const autoActive=(a:ArticleRecord)=>!!a.automation&&['queued','running','cancelling'].includes(a.automation.status);

export class ArticleService {
  private loaded?: Promise<Record<string, ArticleRecord>>;
  private tail: Promise<unknown> = Promise.resolve();
  private automatic=new Map<string,{runId:string;controller:AbortController}>();
  constructor(private readonly deps: Deps) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action); this.tail = result.catch(() => undefined); return result;
  }
  private index(): Promise<Record<string, ArticleRecord>> {
    return this.loaded ??= (async () => {
      let records: Record<string, ArticleRecord>;
      try { records = await this.deps.storage.readJson(INDEX); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ArticleError(500, '文章索引损坏，未覆盖原文件'); records = {}; }
      if (!records || Array.isArray(records) || typeof records !== 'object' || Object.entries(records).some(([id, a]) => !a || a.id !== id || !Number.isInteger(a.version) || !a.steps || !Array.isArray(a.sources) || !Array.isArray(a.topics) || !a.requirements)) throw new ArticleError(500, '文章索引损坏，未覆盖原文件');
      let recovered = false;
      for (const a of Object.values(records)) if (a.running||autoActive(a)) {
        if (ARTICLE_STEPS.includes(a.running as ArticleStep)) a.steps[a.running as ArticleStep] = 'failed';
        delete a.running; a.error = '上次操作被中断，请重新执行'; a.version++; recovered = true;
        if(a.automation){a.automation.status='interrupted';a.automation.error={code:'interrupted',message:'上次自动创作被中断，已有成果保留，可继续',retryable:true};}
      }
      if (recovered) await this.deps.storage.writeJsonAtomic(INDEX, records);
      return records;
    })();
  }
  private async record(id: string): Promise<ArticleRecord> {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ArticleError(400, '文章标识不合法');
    const records = await this.index();
    if (!Object.hasOwn(records, id)) throw new ArticleError(404, '文章不存在或已删除');
    return structuredClone(records[id]!);
  }
  private editable(a: ArticleRecord, version: unknown,runId?:string) {
    if(runId&&a.automation?.status==='cancelling')throw new ArticleError(409,'自动创作正在停止');
    if(autoActive(a)&&a.automation?.runId!==runId)throw new ArticleError(409,'文章正在自动创作，请先停止或等待完成');
    if (a.running) throw new ArticleError(409, '文章正在处理，请等待完成');
    if (!Number.isInteger(version) || a.version !== version) throw new ArticleError(409, '文章版本已变化，请刷新后重试');
  }
  private async persist(a: ArticleRecord): Promise<ArticleRecord> {
    a.version++; a.updatedAt = new Date().toISOString();
    const next = { ...await this.index(), [a.id]: a };
    await this.deps.storage.writeJsonAtomic(INDEX, next); this.loaded = Promise.resolve(next); return structuredClone(a);
  }
  private invalidate(a: ArticleRecord, from: ArticleStep) {
    if(a.automation){for(const step of ARTICLE_STEPS.slice(ARTICLE_STEPS.indexOf(from)))delete a.automation.checkpoints[step];delete a.automation.checkpoints.assets;delete a.automation.checkpoints.preview;if(!autoActive(a)){a.automation.status='interrupted';delete a.automation.error;}}
    const fields: Record<ArticleStep, Array<keyof ArticleRecord>> = { diagnose: ['topics', 'selectedTopic'], evidence: ['facts', 'issues'], outline: ['outline'], draft: ['draft'], review: ['revision', 'reviewNotes'], illustrations: ['illustrations'] };
    for (const step of ARTICLE_STEPS.slice(ARTICLE_STEPS.indexOf(from))) {
      const previous = Object.fromEntries(fields[step].filter(key => a[key] !== undefined).map(key => [key, a[key]]));
      if (a.steps[step] !== 'pending' && Object.keys(previous).length) a.reference[step] = previous;
      a.steps[step] = 'pending';
      for (const key of fields[step]) {
        if (['topics','facts','issues','reviewNotes','illustrations'].includes(key)) (a as any)[key] = []; else delete (a as any)[key];
      }
    }
    a.reviewed = false; if (ARTICLE_STEPS.indexOf(from) <= 4) a.adopted = 'draft';
    if (ARTICLE_STEPS.indexOf(from) <= 1) a.materialConfirmed = false;
    if (ARTICLE_STEPS.indexOf(from) <= 2) a.outlineConfirmed = false;
  }
  private async readLayoutDefaults():Promise<WechatLayoutDefaults> {
    try {
      const value = await this.deps.storage.readJson<WechatLayoutDefaults>('cache/article-layout-defaults.json');
      if (!Number.isSafeInteger(value.version) || value.version < 0 || value.layoutVersion !== 2) throw new Error('默认排版版本无效');
      modernWechatLayout(value.layoutTemplate); validateWechatLayoutOptions(value.layoutOptions);
      return structuredClone(value);
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {version:0,...structuredClone(FACTORY_WECHAT_LAYOUT)};
      throw new ArticleError(500,'默认排版设置损坏，未覆盖原设置');
    }
  }
  async layoutDefaults() { return this.serial(() => this.readLayoutDefaults()); }
  async saveLayoutDefaults(input:unknown):Promise<WechatLayoutDefaults> {
    return this.serial(async () => {
      const p=object(input), current=await this.readLayoutDefaults();
      if(Object.keys(p).some(k=>!['version','layoutTemplate','layoutOptions','reset'].includes(k)))throw new ArticleError(400,'默认排版包含未知字段');
      if(p.version!==current.version)throw new ArticleError(409,'默认排版版本已变化，请重新读取');
      if(p.reset!==undefined&&typeof p.reset!=='boolean')throw new ArticleError(400,'恢复选项无效');
      let selection;
      try {selection=p.reset?structuredClone(FACTORY_WECHAT_LAYOUT):{layoutTemplate:modernWechatLayout(p.layoutTemplate).id,layoutVersion:2 as const,layoutOptions:validateWechatLayoutOptions(p.layoutOptions ?? {})};}
      catch(e){throw new ArticleError(422,(e as Error).message);}
      const next={version:current.version+1,...selection};
      await this.deps.storage.writeJsonAtomic('cache/article-layout-defaults.json',next);return next;
    });
  }
  private applyLayout(a:ArticleRecord,p:Record<string,any>) {
    try {
      if(p.layoutTemplate!==undefined) {
        a.layoutTemplate=wechatLayout(field(p.layoutTemplate,100,true)).id;
        if(p.layoutVersion===undefined) {delete a.layoutVersion;delete a.layoutOptions;}
        if(!['default','minimal-read','business-brief','tutorial-steps','daily-news'].includes(a.layoutTemplate))a.layoutVersion=2;
      }
      if(p.layoutVersion!==undefined) {
        if(p.layoutVersion!==2&&p.layoutVersion!==null)throw new Error('排版版本无效');
        if(p.layoutVersion===null)delete a.layoutVersion;else a.layoutVersion=2;
      }
      if(a.layoutVersion===2)modernWechatLayout(a.layoutTemplate ?? 'default');
      if(p.layoutOptions!==undefined){if(a.layoutVersion!==2)throw new Error('选择新版模板后才能调整排版参数');a.layoutOptions=validateWechatLayoutOptions(p.layoutOptions);}
      else if(p.layoutVersion===null)delete a.layoutOptions;
    } catch(e){throw new ArticleError(422,(e as Error).message);}
  }
  private applyImagePlacements(a:ArticleRecord,p:Record<string,any>) {
      if (p.bodyImagePlacements !== undefined) {
        const sections = a[a.adopted]?.sections.length ?? 0;
        if (!Array.isArray(p.bodyImagePlacements) || p.bodyImagePlacements.length !== a.bodyImageAssetIds.length) throw new ArticleError(422,'配图位置须与正文图片一一对应');
        a.bodyImagePlacements = p.bodyImagePlacements.map((placement: unknown) => {
          const value = object(placement);
          if (!Number.isInteger(value.section) || value.section < 0 || value.section >= sections) throw new ArticleError(422,'配图章节无效');
          return { section: value.section, ...(value.caption !== undefined ? { caption:field(value.caption,200) } : {}) };
        });
      } else if (p.bodyImageAssetIds !== undefined || p.draft !== undefined || p.revision !== undefined || p.adopted !== undefined) delete a.bodyImagePlacements;
  }
  private layoutHtml(a:ArticleRecord,draft:NonNullable<ArticleRecord['draft']>) {
    const references=a.sources.filter(s=>s.included&&a.facts.some(f=>f.sourceId===s.id)).map(s=>`${s.title}${s.url?`：${s.url}`:'（用户提供）'}`);
    return renderWechatArticleHtml(draft,{layoutTemplate:a.layoutTemplate,layoutVersion:a.layoutVersion,layoutOptions:a.layoutOptions,references,
      images:a.bodyImageAssetIds.map((_,i)=>({slot:i+1,...(a.bodyImagePlacements?.[i]?{afterSection:a.bodyImagePlacements[i]!.section,caption:a.bodyImagePlacements[i]!.caption}:{})}))});
  }
  async previewLayout(id:string,input:unknown) {
    return this.serial(async()=>{
      const p=object(input),a=await this.record(id);this.editable(a,p.version);
      if(Object.keys(p).some(k=>!['version','layoutTemplate','layoutVersion','layoutOptions','draft','bodyImageAssetIds','bodyImagePlacements'].includes(k)))throw new ArticleError(400,'预览包含未知字段');
      this.applyLayout(a,p);
      const chosen=p.draft ?? a[a.adopted] ?? a.draft;
      if(!chosen)throw new ArticleError(422,'先完成文章初稿，再查看当前文章排版');
      let draft;
      try {draft=validateWritingResult('draft',chosen,a);}catch(e){throw new ArticleError(422,(e as Error).message);}
      if(p.bodyImageAssetIds!==undefined){if(!Array.isArray(p.bodyImageAssetIds)||p.bodyImageAssetIds.length>10)throw new ArticleError(422,'正文图片最多10张');a.bodyImageAssetIds=p.bodyImageAssetIds.map((v:unknown)=>field(v,100,true));}
      this.applyImagePlacements(a,p);
      return {version:a.version,title:draft.title,html:this.layoutHtml(a,draft)};
    });
  }
  async list(): Promise<ArticleRecord[]> { return this.serial(async () => structuredClone(Object.values(await this.index()).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)))); }
  async get(id: string): Promise<ArticleRecord> { return this.serial(() => this.record(id)); }
  async create(input: unknown, actorId?:string,automaticInput?:{parsed:ReturnType<typeof parseArticleInput>;requestId:string}): Promise<ArticleRecord> {
    const request=object(input);
    const materials=request.researchSelections===undefined?[]:await this.researchMaterials(actorId,request.researchSelections);
    return this.serial(async () => {
      const data = object(input); let hotspot: ArticleRecord['hotspot'];
      if(automaticInput){
        const same=Object.values(await this.index()).find(a=>a.automation&&a.automation.actorId===actorId&&a.automation.requestId===automaticInput.requestId);
        if(same){if(same.automation!.inputHash!==hash(automaticInput.parsed.raw))throw new ArticleError(409,'重复请求标识对应不同输入，请重新提交');return structuredClone(same);}
      }
      if (data.hotspot) { const h = object(data.hotspot); hotspot = await this.deps.resolveHotspot?.(field(h.sourceId,100,true), field(h.itemId,2048,true)); if (!hotspot) throw new ArticleError(404, '热榜线索已失效，请刷新或从收藏创建'); }
      let benchmark: {domain:string;audience:string;styleSample:string}|undefined;
      if (data.benchmarkId !== undefined) {
        if (!this.deps.resolveBenchmark) throw new ArticleError(422,'对标服务不可用');
        try { benchmark = await this.deps.resolveBenchmark(field(data.benchmarkId,100,true)); }
        catch(e) { throw new ArticleError(422,e instanceof Error ? e.message : '对标资料不可用'); }
      }
      const now = new Date().toISOString();
      const defaults=await this.readLayoutDefaults();
      const a: ArticleRecord = { layoutTemplate:defaults.layoutTemplate,layoutVersion:2,layoutOptions:structuredClone(defaults.layoutOptions), id: randomUUID(), version: 0, keyword: field(data.keyword ?? hotspot?.title, 500, true), createdAt: now, updatedAt: now,
        requirements: { audience: '', purpose: '帮助读者理解事件与影响', viewpoint: '', styleSample: '', domain: '', structure: '', length: '1500～2500字' }, ...(hotspot ? { hotspot } : {}),
        topics: [], sources: [], facts: [], issues: [], reviewNotes: [], illustrations: [], reference: {},
        adopted: 'draft', reviewed: false, materialConfirmed: false, outlineConfirmed: false,
        author: '', digest: '', coverAssetId: '', bodyImageAssetIds: [], steps: Object.fromEntries(ARTICLE_STEPS.map(s => [s,'pending'])) as ArticleRecord['steps'] };
      if (hotspot && !materials.some(material=>material.url===publicUrl(hotspot.url).href)) a.sources.push(this.newUrl(hotspot.url));
      if(materials.length)this.appendMaterials(a,materials);
      if (benchmark) Object.assign(a.requirements,benchmark);
      if(automaticInput){
        const {parsed,requestId}=automaticInput;
        a.workflowMode='auto';a.input={kind:parsed.kind,raw:parsed.raw,hash:hash(parsed.raw)};
        if(parsed.text&&parsed.kind!=='idea')a.sources.push({id:randomUUID(),title:'用户提供的文字资料',text:parsed.text,url:'',status:'readable',hash:hash(parsed.text),readAt:now,included:true,kind:'text',depth:0,links:[],truncated:false});
        for(const url of parsed.urls)a.sources.push(this.newUrl(url));
        if(data.requirements!==undefined){for(const [key,value]of Object.entries(object(data.requirements))){if(!Object.hasOwn(a.requirements,key))throw new ArticleError(400,'写作要求字段无效');(a.requirements as any)[key]=field(value,key==='styleSample'?10000:2000);}}
        let templateReason='沿用已保存的新文章默认排版';
        if(data.layoutTemplate!==undefined){this.applyLayout(a,{layoutTemplate:data.layoutTemplate,layoutVersion:2});templateReason='采用你选择的模板';}
        else if(defaults.version===0){const recommended=recommendArticleLayout(parsed.text);a.layoutTemplate=recommended.id;a.layoutOptions={};templateReason=recommended.reason;}
        a.automation={runId:randomUUID(),requestId,actorId:actorId!,inputHash:a.input.hash,status:'queued',stage:'config',startedAt:now,checkpoints:{},templateReason};
      }
      return this.persist(a);
    });
  }
  async capabilities(){return {aiReady:!!await this.deps.checkAi?.(),automaticImages:!!this.deps.illustrate};}
  async createAuto(input:unknown,actorId:string):Promise<ArticleRecord>{
    const p=object(input);if(Object.keys(p).some(k=>!['input','requestId','requirements','layoutTemplate','hotspot'].includes(k)))throw new ArticleError(400,'自动创作包含未知字段');
    let parsed;try{parsed=parseArticleInput(p.input);}catch(e){throw new ArticleError(422,(e as Error).message,'article_input_invalid');}
    const requestId=field(p.requestId,100,true);if(!/^[a-zA-Z0-9_-]+$/.test(requestId))throw new ArticleError(400,'请求标识无效');
    const a=await this.create({keyword:parsed.keyword,requirements:p.requirements,layoutTemplate:p.layoutTemplate,hotspot:p.hotspot},actorId,{parsed,requestId});
    if(a.automation?.status==='queued')this.startAuto(a);
    return a;
  }
  async resumeAuto(id:string,version:unknown,actorId?:string){
    const a=await this.serial(async()=>{
      const a=await this.record(id);this.editable(a,version);
      if(!a.automation)throw new ArticleError(422,'这篇文章没有自动创作记录');
      if(actorId&&actorId!==a.automation.actorId)throw new ArticleError(403,'只能继续自己的自动创作');
      if(a.automation.status==='ready'&&ARTICLE_STEPS.every(s=>a.steps[s]==='succeeded'))throw new ArticleError(409,'文章已完成，请直接编辑和预览');
      a.automation.runId=randomUUID();a.automation.status='queued';a.automation.startedAt=new Date().toISOString();delete a.automation.finishedAt;delete a.automation.error;delete a.error;
      return this.persist(a);
    });this.startAuto(a);return a;
  }
  async cancelAuto(id:string,runId:unknown,actorId?:string){
    const a=await this.serial(async()=>{
      const a=await this.record(id);if(!a.automation||a.automation.runId!==runId)throw new ArticleError(409,'自动创作任务已变化，请刷新后停止');
      if(actorId&&actorId!==a.automation.actorId)throw new ArticleError(403,'只能停止自己的自动创作');
      if(!autoActive(a))return a;
      a.automation.status='cancelling';return this.persist(a);
    });this.automatic.get(id)?.controller.abort();return a;
  }
  private startAuto(a:ArticleRecord){
    if(this.automatic.get(a.id)?.runId===a.automation?.runId)return;
    const controller=new AbortController(),runId=a.automation!.runId;
    this.automatic.set(a.id,{controller,runId});
    void this.executeAuto(a.id,runId,controller.signal).catch(()=>{/* executeAuto persists the safe terminal error. */}).finally(()=>{if(this.automatic.get(a.id)?.runId===runId)this.automatic.delete(a.id);});
  }
  private async autoCheckpoint(id:string,runId:string,stage:ArticleAutoStage,status:'running'|'succeeded',signal:AbortSignal){
    return this.serial(async()=>{signal.throwIfAborted();const a=await this.record(id);if(a.automation?.runId!==runId||!autoActive(a))throw new ArticleError(409,'自动创作任务已变化');
      a.automation.status='running';a.automation.stage=stage;a.automation.checkpoints[stage]={status,updatedAt:new Date().toISOString()};return this.persist(a);});
  }
  private async executeAuto(id:string,runId:string,signal:AbortSignal){
    let stage:ArticleAutoStage='config';
    try{
      await this.autoCheckpoint(id,runId,stage,'running',signal);
      if(!await this.deps.checkAi?.())throw new ArticleError(422,'请先在设置中配置可用的 AI，再继续；输入已保存','ai_missing');
      await this.autoCheckpoint(id,runId,stage,'succeeded',signal);
      stage='read';let a=await this.autoCheckpoint(id,runId,stage,'running',signal);
      const unread=a.sources.filter(s=>s.included&&s.kind==='web'&&s.status!=='readable');
      for(let i=0;i<unread.length;i+=3){signal.throwIfAborted();a=await this.readSources(id,a.version,unread.slice(i,i+3).map(s=>s.id),a.automation!.actorId,runId,signal);}
      const missing=a.sources.filter(s=>s.included&&s.status!=='readable');
      if(missing.length)throw new ArticleError(422,'未读到正文：'+missing.map(s=>s.title).join('、')+'。请换公开链接，或粘贴正文后继续','source_unreadable');
      if(!a.sources.some(s=>s.included&&s.status==='readable'&&s.text.trim()))throw new ArticleError(422,'灵感已保存。请补充事实资料、完整正文或公开链接，系统不会按关键词编造来源','needs_material');
      await this.autoCheckpoint(id,runId,stage,'succeeded',signal);
      for(const step of ARTICLE_STEPS){
        signal.throwIfAborted();stage=step;a=await this.get(id);
        if(a.steps[step]!=='succeeded'){await this.autoCheckpoint(id,runId,step,'running',signal);a=await this.get(id);a=await this.run(id,step,a.version,runId,signal);}
        if(step==='diagnose'&&!a.selectedTopic)a=await this.update(id,{version:a.version,selectedTopic:a.topics[0]?.id},runId);
        await this.autoCheckpoint(id,runId,step,'succeeded',signal);
      }
      stage='assets';a=await this.get(id);const assetsReady=a.automation?.checkpoints.assets?.status==='succeeded';a=await this.autoCheckpoint(id,runId,stage,'running',signal);
      if(!a.coverAssetId||!a.bodyImageAssetIds.length||!assetsReady){
        if(!this.deps.illustrate)throw new ArticleError(422,'自动配图未就绪，正文已保存；可在高级编辑选择封面与正文图','asset_failed');
        const images=await this.deps.illustrate(a,signal);
        try{signal.throwIfAborted();a=await this.update(id,{version:a.version,...images},runId);}
        catch(error){await this.deps.discardIllustrations?.([images.coverAssetId,...images.bodyImageAssetIds].filter(Boolean)).catch(()=>{});throw error;}
      }
      if(this.deps.resolveAsset)for(const assetId of [a.coverAssetId,...a.bodyImageAssetIds]){const asset=await this.deps.resolveAsset(assetId);if(!asset||asset.record.kind!=='image')throw new ArticleError(422,'文章配图已失效，请在高级编辑重新选择图片','asset_failed');}
      await this.autoCheckpoint(id,runId,stage,'succeeded',signal);stage='preview';a=await this.autoCheckpoint(id,runId,stage,'running',signal);
      const chosen=a[a.adopted];if(!chosen)throw new ArticleError(422,'尚无当前有效稿件','ai_output_invalid');this.layoutHtml(a,chosen);
      await this.autoCheckpoint(id,runId,stage,'succeeded',signal);
      await this.serial(async()=>{signal.throwIfAborted();const a=await this.record(id);a.automation!.status='ready';a.automation!.finishedAt=new Date().toISOString();delete a.running;delete a.error;await this.persist(a);});
    }catch(error){
      await this.serial(async()=>{const a=await this.record(id);if(a.automation?.runId!==runId)return;
        delete a.running;const known=error instanceof ArticleError?error:stage==='assets'?new ArticleError(422,'本地配图未完成，请检查内置浏览器与图片存储；正文已保留，可重试配图或在高级编辑选图','asset_failed'):articleWritingFailure(error);
        const code=signal.aborted?'cancelled':known.code,message=signal.aborted?'自动创作已停止，已有成果保留，可继续':known.message;
        a.automation.status=signal.aborted?'cancelled':['ai_missing','source_unreadable','needs_material'].includes(code)?'needs_input':'failed';
        a.automation.stage=stage;a.automation.error={code,message,retryable:!signal.aborted};a.automation.checkpoints[stage]={status:'failed',updatedAt:new Date().toISOString()};a.error=message;await this.persist(a);
      });
    }
  }
  private newUrl(url: string, depth: 0 | 1 = 0): ArticleMaterial {
    return { id: randomUUID(), url: publicUrl(url).href, title: new URL(url).hostname, text: '', included: true, kind: 'web', depth, status: 'needs_material', readAt: '', hash: '', links: [], truncated: false, error: '尚未读取' };
  }
  private async researchMaterials(actorId:string|undefined,selections:unknown){
    if(!actorId||!this.deps.resolveResearchSelections)throw new ArticleError(422,'资料导入服务不可用');
    return this.deps.resolveResearchSelections(actorId,selections);
  }
  private appendMaterials(a:ArticleRecord,materials:ArticleSourceRead[]){
    if(a.sources.length+materials.length>10)throw new ArticleError(422,'每篇最多10份资料');
    const urls=new Set(a.sources.map(s=>s.url).filter(Boolean));
    for(const m of materials){
      const url=publicUrl(m.url).href;
      if(m.status!=='readable'||!m.text||m.hash!==hash(m.text)||m.sourceKind==='topic'||m.sourceKind==='unreadable')throw new ArticleError(422,'资料正文无效，请重新读取');
      if(urls.has(url))throw new ArticleError(422,'资料链接已存在');urls.add(url);
      a.sources.push({...structuredClone(m),url,id:randomUUID(),kind:'web',included:true,depth:0});
    }
  }
  async importResearchSources(id:string,version:unknown,selections:unknown,actorId:string):Promise<ArticleRecord>{
    await this.serial(async()=>this.editable(await this.record(id),version));
    const materials=await this.researchMaterials(actorId,selections);
    return this.serial(async()=>{const a=await this.record(id);this.editable(a,version);this.appendMaterials(a,materials);this.invalidate(a,'evidence');return this.persist(a);});
  }
  async update(id: string, input: unknown,runId?:string): Promise<ArticleRecord> {
    return this.serial(async () => {
      const p = object(input); const a = await this.record(id); this.editable(a,p.version,runId);
      const allowed = ['layoutVersion','layoutOptions','bodyImagePlacements','layoutTemplate','editSourceText','version','keyword','requirements','selectedTopic','addText','addUrl','sourceEdits','removeSourceId','facts','outline','draft','revision','adopted','reviewed','materialConfirmed','outlineConfirmed','author','digest','coverAssetId','bodyImageAssetIds'];
      if (Object.keys(p).some(k => !allowed.includes(k))) throw new ArticleError(400, '存在未知编辑字段');
      if (p.keyword !== undefined) { a.keyword = field(p.keyword,500,true); this.invalidate(a,'diagnose'); }
      if (p.requirements !== undefined) {
        const req = object(p.requirements);
        for (const k of Object.keys(req)) { if (!Object.hasOwn(a.requirements,k)) throw new ArticleError(400, '写作要求字段无效'); (a.requirements as any)[k] = field(req[k], k === 'styleSample' ? 10000 : 2000); }
        this.invalidate(a,'diagnose');
      }
      if (p.selectedTopic !== undefined) {
        if (a.steps.diagnose !== 'succeeded' || !a.topics.some(t => t.id === p.selectedTopic)) throw new ArticleError(422, '请先选择有效的诊断方向');
        this.invalidate(a,'evidence'); a.selectedTopic = p.selectedTopic;
      }
      if (p.addText !== undefined) {
        const t = object(p.addText); const text = field(t.text,30000,true);
        a.sources.push({ id: randomUUID(), title: field(t.title,500,true), text, url: '', status: 'readable', hash: hash(text), readAt: new Date().toISOString(), included: true, kind: 'text', depth: 0, links: [], truncated: false }); this.invalidate(a,'evidence');
      }
      if (p.editSourceText !== undefined) {
        const edit = object(p.editSourceText); const source = a.sources.find(s => s.id === edit.id && s.kind === 'text');
        if (!source) throw new ArticleError(422,'只能编辑已有文字资料，网页原文请另附补充说明');
        source.title = field(edit.title,500,true);source.text = field(edit.text,30000,true);source.hash = hash(source.text);source.readAt = new Date().toISOString();
        this.invalidate(a,'evidence');
      }
      if (p.addUrl !== undefined) {
        const u = object(p.addUrl); const url = publicUrl(field(u.url,4096,true)).href;
        let depth: 0 | 1 = 0;
        if (u.parentId !== undefined) { const parent = a.sources.find(s => s.id === u.parentId); if (!parent || parent.depth !== 0 || !parent.links.some(l => l.url === url)) throw new ArticleError(422, '只能选择已读取来源的一层候选链接'); depth = 1; }
        if (a.sources.some(s => s.url === url)) throw new ArticleError(422, '资料链接已存在');
        a.sources.push(this.newUrl(url,depth)); this.invalidate(a,'evidence');
      }
      if (p.sourceEdits !== undefined) {
        if (!Array.isArray(p.sourceEdits) || p.sourceEdits.length > 10) throw new ArticleError(400,'资料选择无效');
        for (const edit of p.sourceEdits) { const s = a.sources.find(s => s.id === edit?.id); if (!s || typeof edit.included !== 'boolean') throw new ArticleError(422,'资料选择无效'); s.included = edit.included; }
        this.invalidate(a,'evidence');
      }
      if (p.removeSourceId !== undefined) { if (!a.sources.some(s => s.id === p.removeSourceId)) throw new ArticleError(404,'资料不存在'); a.sources = a.sources.filter(s => s.id !== p.removeSourceId); this.invalidate(a,'evidence'); }
      if (a.sources.length > 10) throw new ArticleError(422,'每篇最多 10 份资料');
      for (const step of ['evidence','outline','draft','review'] as const) {
        const key = step === 'evidence' ? 'facts' : step === 'review' ? 'revision' : step;
        if (p[key] === undefined) continue;
        if (a.steps[step] !== 'succeeded') throw new ArticleError(422,'请先完成对应生成步骤再编辑');
        let result: any;
        try { result = validateWritingResult(step, step === 'evidence' ? { facts: p.facts, issues: a.issues } : step === 'review' ? { revision: p.revision, notes: a.reviewNotes } : p[key], a); }
        catch (e) { throw new ArticleError(422,(e as Error).message); }
        const next = ARTICLE_STEPS[ARTICLE_STEPS.indexOf(step)+1]; if (next) this.invalidate(a,next);
        if (step === 'evidence') {a.facts = result.facts;a.materialConfirmed = false;} else if (step === 'review') { a.revision = result.revision; a.reviewed = false; } else (a as any)[key] = result;
        if (step === 'outline') a.outlineConfirmed = false;
        if (step === 'draft') a.reviewed = false;
      }
      if (p.materialConfirmed !== undefined) { if (typeof p.materialConfirmed !== 'boolean' || (p.materialConfirmed && !a.sources.some(s => s.included && s.status === 'readable'))) throw new ArticleError(422,'先补充可读资料'); a.materialConfirmed = p.materialConfirmed; }
      if (p.outlineConfirmed !== undefined) { if (typeof p.outlineConfirmed !== 'boolean' || (p.outlineConfirmed && a.steps.outline !== 'succeeded')) throw new ArticleError(422,'先完成提纲'); a.outlineConfirmed = p.outlineConfirmed; }
      if (p.adopted !== undefined) { if (!['draft','revision'].includes(p.adopted) || !a[p.adopted as 'draft'|'revision'] || a.steps[p.adopted === 'draft' ? 'draft' : 'review'] !== 'succeeded') throw new ArticleError(422,'请选择当前有效稿件'); a.adopted = p.adopted; a.reviewed = false; a.illustrations = []; a.steps.illustrations = 'pending'; }
      if (p.reviewed !== undefined) { if (typeof p.reviewed !== 'boolean' || (p.reviewed && (a.steps.review !== 'succeeded' || !a[a.adopted]))) throw new ArticleError(422,'先完成审校并检查稿件'); a.reviewed = p.reviewed; }
      for (const k of ['author','digest','coverAssetId'] as const) if (p[k] !== undefined) a[k] = field(p[k], k === 'author' ? 16 : k === 'digest' ? 120 : 100);
      this.applyLayout(a,p);
      if (p.bodyImageAssetIds !== undefined) { if (!Array.isArray(p.bodyImageAssetIds) || p.bodyImageAssetIds.length > 10 || new Set(p.bodyImageAssetIds).size !== p.bodyImageAssetIds.length) throw new ArticleError(422,'正文图片最多10张，不可重复'); a.bodyImageAssetIds = p.bodyImageAssetIds.map((v: unknown) => field(v,100,true)); }
      this.applyImagePlacements(a,p);
      if(a.automation&&!runId&&(p.coverAssetId!==undefined||p.bodyImageAssetIds!==undefined)){
        if(a.coverAssetId&&a.bodyImageAssetIds.length){
          if(!this.deps.resolveAsset)throw new ArticleError(422,'图片素材校验不可用');
          for(const id of [a.coverAssetId,...a.bodyImageAssetIds]){const asset=await this.deps.resolveAsset(id);if(!asset||asset.record.kind!=='image')throw new ArticleError(422,'选择的图片不存在，请重新选择');}
          a.automation.checkpoints.assets={status:'succeeded',updatedAt:new Date().toISOString()};
        }else delete a.automation.checkpoints.assets;
        delete a.automation.checkpoints.preview;
      }
      delete a.error; return this.persist(a);
    });
  }
  private guard(a: ArticleRecord, step: ArticleStep,automatic=false) {
    if (step === 'diagnose') return;
    if (!a.selectedTopic || a.steps.diagnose !== 'succeeded') throw new ArticleError(422,'请先完成选题诊断并选择方向');
    if (!a.sources.some(s => s.included && s.status === 'readable')) throw new ArticleError(422,'资料不足，请读取正文或粘贴资料');
    if (step === 'evidence') return;
    if ((!a.materialConfirmed&&!automatic) || a.steps.evidence !== 'succeeded') throw new ArticleError(422,'请先整理事实并确认资料');
    if (step === 'outline') return;
    if (a.steps.outline !== 'succeeded' || (!a.outlineConfirmed&&!automatic)) throw new ArticleError(422,'请先生成并确认提纲');
    if (step === 'draft') return;
    if (a.steps.draft !== 'succeeded') throw new ArticleError(422,'请先完成初稿');
    if (step === 'illustrations' && ((!a.reviewed&&!automatic) || a.steps.review !== 'succeeded')) throw new ArticleError(422,'请先完成审校并人工确认定稿');
  }
  async run(id: string, step: ArticleStep, version: unknown,runId?:string,signal?:AbortSignal): Promise<ArticleRecord> {
    if (!ARTICLE_STEPS.includes(step)) throw new ArticleError(400,'写作步骤无效');
    const snapshot = await this.serial(async () => { const a = await this.record(id); this.editable(a,version,runId); this.guard(a,step,!!runId&&a.automation?.runId===runId&&autoActive(a)); a.running = step; a.steps[step] = 'running'; delete a.error; return this.persist(a); });
    try {
      let result = await this.deps.writer.run(step,snapshot,signal);signal?.throwIfAborted();if(runId)try{result=validateWritingResult(step,result,snapshot);}catch{throw new ArticleError(422,'AI 内容未通过结构或来源引用校验，请重试当前步骤','ai_output_invalid');}
      return await this.serial(async () => {
        const a = await this.record(id);signal?.throwIfAborted();if(runId&&a.automation?.runId!==runId)throw new ArticleError(409,'自动创作任务已变化'); const next = ARTICLE_STEPS[ARTICLE_STEPS.indexOf(step)+1]; if (next) this.invalidate(a,next);
        if (step === 'diagnose') { a.topics = result.topics; delete a.selectedTopic; }
        if (step === 'evidence') { a.facts = result.facts; a.issues = result.issues; a.materialConfirmed = false; }
        if (step === 'outline') { a.outline = result; a.outlineConfirmed = false; }
        if (step === 'draft') a.draft = result;
        if (step === 'review') { a.revision = result.revision; a.reviewNotes = result.notes; a.adopted = 'revision'; a.reviewed = false; }
        if (step === 'illustrations') a.illustrations = result.images;
        a.steps[step] = 'succeeded'; delete a.running; return this.persist(a);
      });
    } catch (error) {
      const failure=articleWritingFailure(error);
      await this.serial(async () => { const a = await this.record(id); delete a.running; a.steps[step] = 'failed'; a.error = signal?.aborted?'自动创作已停止，已有成果保留':`生成失败：${failure.message}`; return this.persist(a); });
      if(signal?.aborted)throw error;
      throw new ArticleError(422, error instanceof ArticleError ? error.message : `生成失败：${failure.message}`,failure.code);
    }
  }
  async readSources(id: string, version: unknown, ids: unknown, actorId?:string,runId?:string,signal?:AbortSignal): Promise<ArticleRecord> {
    const snapshot = await this.serial(async () => {
      const a = await this.record(id); this.editable(a,version,runId);
      if (!Array.isArray(ids) || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length || ids.some(id => !a.sources.some(s => s.id === id && s.kind === 'web'))) throw new ArticleError(422,'每批请选择 1～3 个网页来源');
      a.running = 'read'; return this.persist(a);
    });
    try {
      const sources = await Promise.all(snapshot.sources.filter(s => (ids as string[]).includes(s.id)).map(async s => ({ ...s, ...await (this.deps.readSource ? this.deps.readSource(s.url) : actorId && this.deps.readResearchSource ? this.deps.readResearchSource(actorId,s.url) : readArticleSource(s.url)) })));
      signal?.throwIfAborted();return await this.serial(async () => { const a = await this.record(id);signal?.throwIfAborted(); a.sources = a.sources.map(s => sources.find(n => n.id === s.id) ?? s); this.invalidate(a,'evidence'); delete a.running; return this.persist(a); });
    } catch (error) {
      await this.serial(async () => { const a = await this.record(id); delete a.running; a.error = '资料读取失败，请补充资料后重试'; return this.persist(a); }); throw new ArticleError(422,'资料读取失败');
    }
  }
  async remove(id: string, version: unknown): Promise<void> {
    await this.serial(async () => { const a = await this.record(id); this.editable(a,version); const records = { ...await this.index() }; delete records[id]; await this.deps.storage.writeJsonAtomic(INDEX,records); this.loaded = Promise.resolve(records); });
  }
  private async prepared(a: ArticleRecord) {
    this.guard(a,'illustrations');
    const chosen = a[a.adopted]; if (!chosen) throw new ArticleError(422,'没有有效定稿');
    const draft = { ...structuredClone(chosen), author: a.author, digest: a.digest,
      sections: structuredClone(chosen.sections) };
    if (!a.coverAssetId) throw new ArticleError(422,'请选择封面图片');
    const assets: ResolvedAssetFile[] = [];
    for (const id of [a.coverAssetId,...a.bodyImageAssetIds]) { const file = await this.deps.resolveAsset?.(id); if (!file || file.record.kind !== 'image') throw new ArticleError(422,'选中的图片已失效，请重新选择'); assets.push(file); }
    const hashes = await Promise.all(assets.map(a => readFile(a.path).then(hash)));
    const html = this.layoutHtml(a,draft);
    const previewRevision = hash(JSON.stringify({ article: a, hashes, html }));
    return { draft, html, cover: assets[0]!, images: assets.slice(1), hashes, previewRevision };
  }
  async preview(id: string, version: unknown): Promise<ArticlePreview> {
    return this.serial(async () => { const a = await this.record(id); this.editable(a,version); const p = await this.prepared(a); return { version:a.version, previewRevision:p.previewRevision, html:p.html, title:p.draft.title, sourceCount:a.sources.filter(s => s.included).length }; });
  }
  async previewDraftUpdate(id: string, taskId: string, version: unknown, actor: ActorSnapshot) {
    return this.serial(async () => {
      const a = await this.record(id); this.editable(a,version); const p = await this.prepared(a);
      if (!this.deps.previewDraftUpdate) throw new ArticleError(500,'草稿更新服务未配置');
      const checked = await this.deps.previewDraftUpdate(taskId,{article:a,...p,actor},p.previewRevision);
      return { version:a.version,taskId,mediaId:checked.mediaId,previewRevision:checked.previewRevision,html:p.html,title:p.draft.title };
    });
  }
  async updateDraft(id: string, taskId: string, version: unknown, previewRevision: unknown, actor: ActorSnapshot) {
    return this.serial(async () => {
      const a = await this.record(id); this.editable(a,version); const p = await this.prepared(a);
      if (!this.deps.updateDraft) throw new ArticleError(500,'草稿更新服务未配置');
      // 持有文章队列至远端结果落盘，当前定稿/图片不能在提交中途被编辑。
      return this.deps.updateDraft(taskId,{article:a,...p,actor},p.previewRevision,previewRevision);
    });
  }
  async saveWechatDraft(id:string,version:unknown,previewRevision:unknown,confirmed:unknown,actor:ActorSnapshot){
    if(confirmed!==true)throw new ArticleError(400,'请先核对文章、图片与目标公众号，再明确确认保存');
    return this.serial(async()=>{
      let a=await this.record(id);this.editable(a,version);const p=await this.prepared(a);
      if(p.previewRevision!==previewRevision)throw new ArticleError(409,'预览已变化，请重新核对预览');
      const fingerprint=hash(JSON.stringify({draft:p.draft,html:p.html,hashes:p.hashes,sources:a.sources}));
      if(a.wechatDelivery&&a.wechatDelivery.fingerprint!==fingerprint)throw new ArticleError(409,'文章已有草稿交付记录；当前内容已改变，请到发布中心人工处理新版本');
      if(a.wechatDelivery?.state==='preparing')throw new ArticleError(409,'上次建包中断，请先在发布中心核对本地文章包，勿重复创建');
      if(a.wechatDelivery?.state==='uncertain')throw new ArticleError(409,'草稿保存结果待核实，请先到公众号后台检查，勿重复提交');
      if(!this.deps.verifyWechat||!this.deps.submitWechat||!this.deps.getWechatTask||!this.deps.createPackage)throw new ArticleError(422,'公众号草稿服务未就绪，文章成果已保留');
      let task=a.wechatDelivery?.taskId?await this.deps.getWechatTask(a.wechatDelivery.taskId):undefined;
      if(task?.autoPublish?.outcomeUncertain)throw new ArticleError(409,'草稿保存结果待核实，请先到公众号后台检查，勿重复提交');
      if(!task?.autoPublish?.draftMediaId){
        const checked=await this.deps.verifyWechat();if(!checked.ok)throw new ArticleError(422,checked.draftPermission.message||checked.credentials.message,'wechat_unavailable');
        if(!a.wechatDelivery){
          a.wechatDelivery={state:'preparing',fingerprint};a=await this.persist(a);
          const detail=await this.deps.createPackage({article:a,...p,actor});
          const first=detail.tasks.find(t=>t.platform==='wechat_mp');if(!first)throw new ArticleError(500,'文章包未生成公众号任务，请到发布中心核对');
          a.wechatDelivery={state:'ready',fingerprint,packageId:detail.package.id,taskId:first.id};a=await this.persist(a);
        }
        try{task=await this.deps.submitWechat(a.wechatDelivery!.taskId!,actor);}
        catch(error){a.wechatDelivery!.state='uncertain';a.wechatDelivery!.message='草稿提交中断，结果需核实；文章和本地包已保留';await this.persist(a);throw error;}
      }
      if(!task)throw new ArticleError(500,'草稿交付记录缺失，请到发布中心核对');
      a.wechatDelivery!.state=task.autoPublish?.outcomeUncertain?'uncertain':task.autoPublish?.draftMediaId?'succeeded':'ready';
      a.wechatDelivery!.mediaId=task.autoPublish?.draftMediaId;a.wechatDelivery!.message=task.autoPublish?.message??'草稿未保存，请在发布中心核对失败原因';
      a=await this.persist(a);return{article:a,task};
    });
  }
  async createPackage(id: string, version: unknown, previewRevision: unknown, actor: ActorSnapshot): Promise<PublishingPackageDetail> {
    // ponytail: serialize local packaging with saves; per-article queues if packaging contention becomes measurable.
    return this.serial(async () => {
      const a = await this.record(id); this.editable(a,version); const p = await this.prepared(a);
      if (previewRevision !== p.previewRevision) throw new ArticleError(409,'预览已变化，请重新预览');
      if (!this.deps.createPackage) throw new ArticleError(500,'发布包服务未配置');
      // Reserve the preview version before the publisher transaction: no fallible article write follows a committed package.
      await this.persist(a);
      return this.deps.createPackage({ article:a, ...p, actor });
    });
  }
}
