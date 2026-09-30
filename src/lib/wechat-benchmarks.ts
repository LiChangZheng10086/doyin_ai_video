import { randomUUID } from 'node:crypto';
import { LocalStorage } from './storage.js';
import { searchWechatArticles, wechatReferenceUrl, type WechatSearchArticle } from './wechat-search.js';

export interface BenchmarkSample {
  title:string; url:string; dateText:string; reads:number|null; lowerBound:boolean; metricSource:string; measuredAt:string;
}
export interface BenchmarkAccount {
  id:string; name:string; identity:string; identityConfirmed:boolean; relevant:boolean; selected:boolean; notes:string; samples:BenchmarkSample[];
}
export interface BenchmarkGroup {
  id:string; version:number; name:string; audience:string; keywords:string[]; minReads:number; accounts:BenchmarkAccount[]; createdAt:string; updatedAt:string;
}
export interface BenchmarkAssessment {
  selectedCount:number; qualifiedCount:number;
  accounts:Array<{id:string;sampleCount:number;medianReads:number|null;lowerBound:boolean;qualified:boolean;reasons:string[]}>;
}
export type BenchmarkView = BenchmarkGroup & {assessment:BenchmarkAssessment};
export interface BenchmarkSearchResult {keyword:string;fetchedAt:string;articles:WechatSearchArticle[];cached:boolean}
export class BenchmarkError extends Error {
  constructor(readonly status:number,message:string,readonly code='benchmark_failed'){super(message);}
}
const INDEX='cache/wechat-benchmarks.json';
function obj(input:unknown):Record<string,unknown>{if(!input||typeof input!=='object'||Array.isArray(input))throw new BenchmarkError(400,'参数格式无效');return input as Record<string,unknown>;}
function text(input:unknown,max:number,required=false):string{if(typeof input!=='string'||input.length>max||(required&&!input.trim()))throw new BenchmarkError(422,'文字为空或超出长度限制');return input.trim();}
function bool(input:unknown):boolean{if(typeof input!=='boolean')throw new BenchmarkError(422,'确认状态无效');return input;}
function number(input:unknown):number{if(typeof input!=='number'||!Number.isSafeInteger(input)||input<0||input>1_000_000_000)throw new BenchmarkError(422,'阅读数或门槛应为 0～10 亿的整数');return input;}
function sample(input:unknown):BenchmarkSample{
  const p=obj(input);let url:string;
  try{url=wechatReferenceUrl(text(p.url,4096,true));}catch{throw new BenchmarkError(422,'样本必须是公众号文章或搜狗微信链接');}
  const reads=p.reads===null?null:number(p.reads);const lowerBound=bool(p.lowerBound);
  const metricSource=text(p.metricSource,500);const measuredAt=text(p.measuredAt,100);
  if(reads!==null&&(!metricSource||!measuredAt||!Number.isFinite(Date.parse(measuredAt))))throw new BenchmarkError(422,'阅读数据必须有来源与有效观察时间');
  if(reads===null&&lowerBound)throw new BenchmarkError(422,'未知阅读量不能标为下界');
  return {title:text(p.title,500,true),url,dateText:text(p.dateText,100),reads,lowerBound,metricSource,measuredAt};
}
function account(input:unknown,id:string):BenchmarkAccount{
  const p=obj(input);if(!Array.isArray(p.samples)||p.samples.length>20)throw new BenchmarkError(422,'每个账号最多 20 篇文章样本');
  const samples=p.samples.map(sample);
  if(new Set(samples.map(s=>s.url)).size!==samples.length)throw new BenchmarkError(422,'文章样本不可重复');
  const biz=[...new Set(samples.map(s=>new URL(s.url)).filter(u=>u.hostname==='mp.weixin.qq.com').map(u=>u.searchParams.get('__biz')).filter((s):s is string=>!!s))];
  if(biz.length>1)throw new BenchmarkError(422,'样本来自不同公众号身份，请分别保存');
  const identity=biz.length?`biz:${biz[0]}`:text(p.identity,200);
  const identityConfirmed=bool(p.identityConfirmed);
  if(identityConfirmed&&!identity)throw new BenchmarkError(422,'请填写核验后的账号标识，或使用包含 biz 的文章链接');
  return {id,name:text(p.name,100,true),identity,identityConfirmed,relevant:bool(p.relevant),selected:bool(p.selected),notes:text(p.notes,2000),samples};
}
function groupFields(input:Record<string,unknown>):Pick<BenchmarkGroup,'name'|'audience'|'keywords'|'minReads'>{
  if(!Array.isArray(input.keywords)||!input.keywords.length||input.keywords.length>10)throw new BenchmarkError(422,'请填写 1～10 个关键词');
  return {name:text(input.name,100,true),audience:text(input.audience,2000),keywords:[...new Set(input.keywords.map(k=>text(k,100,true)))],minReads:number(input.minReads)};
}
function uniqueIdentities(accounts:BenchmarkAccount[]){
  const identities=accounts.map(a=>a.identity).filter(Boolean);
  if(new Set(identities).size!==identities.length)throw new BenchmarkError(422,'同一账号身份已存在，请合并样本');
}

export function benchmarkAssessment(group:BenchmarkGroup):BenchmarkAssessment{
  const accounts=group.accounts.map(a=>{
    const samples=a.samples.filter(s=>s.reads!==null&&s.metricSource&&Number.isFinite(Date.parse(s.measuredAt))).sort((x,y)=>x.reads!-y.reads!);
    const middle=Math.floor(samples.length/2);
    const medians=samples.length%2?[samples[middle]!]:samples.length?[samples[middle-1]!,samples[middle]!]:[];
    const medianReads=medians.length?medians.reduce((n,s)=>n+s.reads!,0)/medians.length:null;
    const lowerBound=samples.some(s=>s.lowerBound);
    const reasons:string[]=[];
    if(!a.identityConfirmed||!a.identity)reasons.push('身份待核验');
    if(!a.relevant)reasons.push('赛道相关性待确认');
    if(medianReads===null)reasons.push('缺少阅读依据');else if(medianReads<group.minReads)reasons.push('未达到阅读门槛');
    return {id:a.id,sampleCount:samples.length,medianReads,lowerBound,qualified:a.selected&&!reasons.length,reasons};
  });
  return {accounts,selectedCount:group.accounts.filter(a=>a.selected).length,qualifiedCount:accounts.filter(a=>a.qualified).length};
}

export class WechatBenchmarkService {
  private loaded?:Promise<Record<string,BenchmarkGroup>>;private tail:Promise<unknown>=Promise.resolve();
  private cache=new Map<string,BenchmarkSearchResult>();private pending=new Map<string,Promise<BenchmarkSearchResult>>();private lastSearch?:number;
  constructor(private storage:LocalStorage,private deps:{search?:typeof searchWechatArticles;now?:()=>number}={}){}
  private now(){return this.deps.now?.()??Date.now();}
  private serial<T>(action:()=>Promise<T>):Promise<T>{const p=this.tail.then(action);this.tail=p.catch(()=>undefined);return p;}
  private view(g:BenchmarkGroup):BenchmarkView{return {...structuredClone(g),assessment:benchmarkAssessment(g)};}
  private index():Promise<Record<string,BenchmarkGroup>>{
    return this.loaded??=(async()=>{
      let data:Record<string,BenchmarkGroup>;
      try{data=await this.storage.readJson(INDEX);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {};throw new BenchmarkError(500,'对标索引损坏，未覆盖原文件');}
      try{
        obj(data);
        for(const [id,g]of Object.entries(data)){
          if(!g||g.id!==id||!/^[a-f0-9-]{36}$/.test(id)||!Number.isSafeInteger(g.version)||g.version<1||!Number.isFinite(Date.parse(g.createdAt))||!Number.isFinite(Date.parse(g.updatedAt))||!Array.isArray(g.accounts)||g.accounts.length>100)throw new Error();
          groupFields(g as unknown as Record<string,unknown>);
          if(new Set(g.accounts.map(a=>a.id)).size!==g.accounts.length)throw new Error();
          for(const a of g.accounts){if(!/^[a-f0-9-]{36}$/.test(a.id))throw new Error();account(a,a.id);}
          uniqueIdentities(g.accounts);
        }
      }catch{throw new BenchmarkError(500,'对标索引损坏，未覆盖原文件');}
      return data;
    })();
  }
  private async get(id:string):Promise<BenchmarkGroup>{
    if(!/^[a-f0-9-]{36}$/.test(id))throw new BenchmarkError(400,'对标组标识无效');
    const data=await this.index();if(!Object.hasOwn(data,id))throw new BenchmarkError(404,'对标组不存在');return structuredClone(data[id]!);
  }
  private async save(g:BenchmarkGroup):Promise<BenchmarkView>{
    g.version++;g.updatedAt=new Date(this.now()).toISOString();const next={...await this.index(),[g.id]:g};
    await this.storage.writeJsonAtomic(INDEX,next);this.loaded=Promise.resolve(next);return this.view(g);
  }
  async list():Promise<BenchmarkView[]>{return this.serial(async()=>Object.values(await this.index()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(g=>this.view(g)));}
  async create(input:unknown):Promise<BenchmarkView>{return this.serial(async()=>{
    if(Object.keys(await this.index()).length>=50)throw new BenchmarkError(422,'最多保存 50 个对标组');
    return this.save({...groupFields(obj(input)),id:randomUUID(),version:0,accounts:[],createdAt:new Date(this.now()).toISOString(),updatedAt:''});
  });}
  async update(id:string,input:unknown):Promise<BenchmarkView>{return this.serial(async()=>{
    const p=obj(input);const g=await this.get(id);if(p.version!==g.version)throw new BenchmarkError(409,'对标版本已变化，请刷新后重试');
    if(Object.keys(p).some(k=>!['version','name','audience','keywords','minReads','addAccount','account','removeAccountId'].includes(k)))throw new BenchmarkError(400,'存在未知字段');
    Object.assign(g,groupFields({...g,...p}));
    if(p.addAccount!==undefined){if(g.accounts.length>=100)throw new BenchmarkError(422,'每组最多 100 个候选账号');g.accounts.push(account(p.addAccount,randomUUID()));}
    if(p.account!==undefined){const edited=obj(p.account);const index=g.accounts.findIndex(a=>a.id===edited.id);if(index<0)throw new BenchmarkError(404,'候选账号不存在');g.accounts[index]=account(edited,g.accounts[index]!.id);}
    if(p.removeAccountId!==undefined){if(!g.accounts.some(a=>a.id===p.removeAccountId))throw new BenchmarkError(404,'候选账号不存在');g.accounts=g.accounts.filter(a=>a.id!==p.removeAccountId);}
    uniqueIdentities(g.accounts);return this.save(g);
  });}
  async remove(id:string,version:unknown):Promise<void>{return this.serial(async()=>{
    const g=await this.get(id);if(g.version!==version)throw new BenchmarkError(409,'对标版本已变化，请刷新后重试');
    const next={...await this.index()};delete next[id];await this.storage.writeJsonAtomic(INDEX,next);this.loaded=Promise.resolve(next);
  });}
  search(keyword:unknown):Promise<BenchmarkSearchResult>{
    const key=text(keyword,100,true);const time=this.now();const cached=this.cache.get(key);
    if(cached&&time-Date.parse(cached.fetchedAt)<600000)return Promise.resolve({...structuredClone(cached),cached:true});
    const pending=this.pending.get(key);if(pending)return pending.then(value=>structuredClone(value));
    if(this.lastSearch!==undefined&&time-this.lastSearch<60000)return Promise.reject(new BenchmarkError(429,'搜索请求至少间隔 60 秒，请稍后或手动录入'));
    this.lastSearch=time;
    const result=(async()=>{
      try{
        const articles=await (this.deps.search??searchWechatArticles)(key);
        const value={keyword:key,fetchedAt:new Date(this.now()).toISOString(),articles,cached:false};
        if(this.cache.size>=50)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,value);return structuredClone(value);
      }catch(e){throw new BenchmarkError(422,e instanceof Error?e.message:'公开搜索暂不可用，请手动录入');}
      finally{this.pending.delete(key);}
    })();this.pending.set(key,result);return result;
  }
  async forArticle(id:string):Promise<{domain:string;audience:string;styleSample:string}>{return this.serial(async()=>{
    const g=await this.get(id);const assessment=benchmarkAssessment(g);
    if(assessment.qualifiedCount<10)throw new BenchmarkError(422,`当前有效对标 ${assessment.qualifiedCount} 个，至少需要 10 个；请核验身份、赛道与阅读依据`);
    const accounts=g.accounts.filter(a=>assessment.accounts.some(s=>s.id===a.id&&s.qualified));
    const styleSample=['以下仅是用户核验的对标观察与标题样本，不能作为事实来源，不能据标题声称已分析原文。',...accounts.map(a=>{
      const stats=assessment.accounts.find(s=>s.id===a.id)!;
      return `${a.name}（${a.identity}）；${stats.sampleCount}篇阅读样本，中位${stats.lowerBound?'下界':''} ${stats.medianReads}；写作观察：${a.notes.slice(0,300)}；标题参考：${a.samples.slice(0,3).map(s=>s.title.slice(0,100)).join(' / ')}`;
    })].join('\n').slice(0,10000);
    return {domain:g.name,audience:g.audience,styleSample};
  });}
}
