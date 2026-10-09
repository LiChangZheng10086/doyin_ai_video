import { randomUUID } from 'node:crypto';
import { downloadArticleHtml, type ArticleSourceRead } from './article-sources.js';
import { parseResearchContent } from './research-content.js';
import { researchPublicUrl, validateResearchUrl } from './research-http.js';
import { createResearchProviders, providerFailure, type ResearchProviders } from './research-providers.js';
import { normalizeResearchConfig, ResearchError, type ResearchConfig, type ResearchContent, type ResearchReadInput, type ResearchReadResult, type ResearchSearchResult, type ResearchSelection, type ResearchStatus } from './research-types.js';

type Snapshot={actorId:string;key:string;expires:number;bytes:number;value:ResearchReadResult|ResearchSearchResult};
type Deps={resolveConfig?:()=>Promise<ResearchConfig>;providers?:ResearchProviders;now?:()=>number;validateUrl?:(url:string)=>Promise<unknown>;
  readDirect?:(url:string,signal:AbortSignal)=>Promise<ResearchContent>;maxEntriesPerActor?:number;maxBytes?:number;configurationSource?:ResearchStatus['configurationSource']};
export class ResearchService {
  private snapshots=new Map<string,Snapshot>();private pending=new Map<string,Promise<any>>();private attempts=new Map<string,number>();private active=new Map<string,number>();
  private totalBytes=0;private now:()=>number;private providers:ResearchProviders;private validate:(url:string)=>Promise<unknown>;
  private reports:ResearchStatus['providers']={jina:{state:'unverified'},exa:{state:'unverified'}};
  constructor(private deps:Deps={}){this.now=deps.now??Date.now;this.providers=deps.providers??createResearchProviders();this.validate=deps.validateUrl??validateResearchUrl;}
  private async config(){return normalizeResearchConfig(await this.deps.resolveConfig?.());}
  async status():Promise<ResearchStatus>{return {config:await this.config(),configurationSource:this.deps.configurationSource??'environment',providers:structuredClone(this.reports)};}
  private remove(id:string){const old=this.snapshots.get(id);if(old){this.totalBytes-=old.bytes;this.snapshots.delete(id);}}
  private prune(){const now=this.now();for(const[id,s]of this.snapshots)if(s.expires<=now)this.remove(id);for(const[k,time]of this.attempts)if(now-time>=60000)this.attempts.delete(k);}
  private store(actorId:string,key:string,value:Snapshot['value']){
    this.prune();const bytes=Buffer.byteLength(JSON.stringify(value));const max=this.deps.maxBytes??20*1024*1024;
    if(bytes>max)throw new ResearchError(502,'too_large','资料快照过大');
    const owned=()=>[...this.snapshots].filter(([,s])=>s.actorId===actorId);
    while(owned().length>=(this.deps.maxEntriesPerActor??100))this.remove(owned()[0][0]);
    while(this.totalBytes+bytes>max && this.snapshots.size)this.remove(this.snapshots.keys().next().value!);
    const id='readId'in value?value.readId:value.searchId;
    this.snapshots.set(id,{actorId,key,value:structuredClone(value),expires:Date.parse(value.expiresAt),bytes});this.totalBytes+=bytes;
  }
  private get(actorId:string,id:string){this.prune();const s=this.snapshots.get(id);
    if(!s||s.actorId!==actorId)throw new ResearchError(410,'not_found','资料快照已过期或后端已重启，请重新读取');
    this.snapshots.delete(id);this.snapshots.set(id,s);return structuredClone(s.value);
  }
  private async operation<T extends Snapshot['value']>(actorId:string,operationKey:string,config:ResearchConfig,fn:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    this.prune();const key=JSON.stringify([actorId,operationKey,config]);
    for(const[id,s]of this.snapshots)if(s.key===key){if('readId'in s.value && s.value.kind==='unreadable')continue;const value=this.get(actorId,id);if('cached'in value)value.cached=true;return value as T;}
    const pending=this.pending.get(key);if(pending)return structuredClone(await pending);
    const throttle=JSON.stringify([actorId,operationKey]);const attempt=this.attempts.get(throttle);
    if(attempt!==undefined)throw new ResearchError(429,'rate_limited','距上次读取不足60秒，请稍后重试',Math.ceil((60000-this.now()+attempt)/1000));
    if((this.active.get(actorId)??0)>=3||this.attempts.size>=10000)throw new ResearchError(429,'rate_limited','当前资料请求较多，请稍后重试',60);
    this.attempts.set(throttle,this.now());this.active.set(actorId,(this.active.get(actorId)??0)+1);
    const signal=AbortSignal.timeout(operationKey.startsWith('search:')?30000:50000);
    const promise=(async()=>{try{const result=await fn(signal);signal.throwIfAborted();this.store(actorId,key,result);return result;}finally{this.pending.delete(key);this.active.set(actorId,(this.active.get(actorId)??1)-1);}})();
    this.pending.set(key,promise);return structuredClone(await promise);
  }
  private async safeCandidates<T extends {url:string}>(items:T[],signal:AbortSignal):Promise<T[]>{
    const out:T[]=[];
    for(const item of items){signal.throwIfAborted();try{await this.withSignal(this.validate(item.url),signal);out.push(item);}catch(error){if(signal.aborted)throw error;}}
    return out;
  }
  private withSignal<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
    signal.throwIfAborted();return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
  }
  async search(actorId:string,raw:unknown):Promise<ResearchSearchResult>{
    if(typeof raw!=='string'||!raw.trim()||raw.trim().length>500)throw new ResearchError(400,'unsupported_format','搜索词应为1～500字符');
    const query=raw.trim();const config=await this.config();if(!config.exaEnabled)throw new ResearchError(422,'disabled','请先在设置中启用 Exa 资料搜索');
    return this.operation(actorId,`search:${query}`,config,async signal=>{
      try{const candidates=await this.safeCandidates(await this.withSignal(this.providers.search(query,signal),signal),signal);
        this.reports.exa={state:'ok',checkedAt:new Date(this.now()).toISOString()};
        return {searchId:randomUUID(),query,candidates:candidates.slice(0,5),fetchedAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+600000).toISOString(),cached:false};
      }catch(error){const failure=providerFailure(error);this.reports.exa={state:'error',checkedAt:new Date(this.now()).toISOString(),message:failure.message};throw failure;}
    });
  }
  async read(actorId:string,input:ResearchReadInput):Promise<ResearchReadResult>{
    if(!input||typeof input!=='object')throw new ResearchError(400,'unsupported_format','请选择公开链接或搜索结果');
    let url:string;
    if('url'in input && Object.keys(input).length===1 && typeof input.url==='string'){
      try{url=researchPublicUrl(input.url).href;}catch{throw new ResearchError(400,'unsafe_url','请使用不含凭据的公开 HTTPS 链接');}
    }else if('searchId'in input && Object.keys(input).length===2 && typeof input.searchId==='string'&&typeof input.candidateId==='string'){
      const result=this.get(actorId,input.searchId);if(!('candidates'in result && 'searchId'in result))throw new ResearchError(410,'not_found','搜索结果已失效');
      const selected=result.candidates.find(c=>c.id===input.candidateId);if(!selected)throw new ResearchError(404,'not_found','搜索候选不存在');url=selected.url;
    }else throw new ResearchError(400,'unsupported_format','链接与搜索候选必须二选一');
    const config=await this.config();
    return this.operation(actorId,`read:${url}`,config,async signal=>{
      let content:ResearchContent;
      try{
        await this.withSignal(this.validate(url),signal);
        const directSignal=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
        try{content=await this.withSignal(this.deps.readDirect?this.deps.readDirect(url,directSignal):downloadArticleHtml(url,directSignal).then(body=>parseResearchContent({url,body,format:'html',provider:'direct'})),directSignal);}
        catch{content=parseResearchContent({url,body:'',format:'html',provider:'direct'});}
        if(content.status!=='readable' && config.jinaEnabled && (await this.config()).jinaEnabled){
          try{content=await this.withSignal(this.providers.readJina(url,signal),signal);this.reports.jina={state:content.status==='readable'||content.kind==='topic'?'ok':'error',checkedAt:new Date(this.now()).toISOString(),message:content.error?.message};}
          catch(error){const failure=providerFailure(error);this.reports.jina={state:'error',checkedAt:new Date(this.now()).toISOString(),message:failure.message};content={...content,error:{code:failure.code,message:failure.message}};}
        }
        content.candidates=await this.safeCandidates(content.candidates,signal);
      }catch(error){const failure=signal.aborted?providerFailure(signal.reason):new ResearchError(400,'unsafe_url','来源不能安全读取，请使用其它公开链接');content={...parseResearchContent({url,body:'',format:'html',provider:'direct'}),error:{code:failure.code,message:failure.message}};}
      return {...content,readId:randomUUID(),readAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+1800000).toISOString()};
    });
  }
  async resolveSelections(actorId:string,raw:unknown):Promise<ArticleSourceRead[]>{
    if(!actorId||!Array.isArray(raw)||!raw.length||raw.length>3||new Set(raw.map(s=>s?.readId)).size!==raw.length)throw new ResearchError(422,'unsupported_format','每批请选择1～3份不同正文');
    return raw.map((selection:ResearchSelection)=>{
      if(!selection||typeof selection.readId!=='string'||typeof selection.hash!=='string')throw new ResearchError(400,'unsupported_format','资料选择格式无效');
      const read=this.get(actorId,selection.readId);if(!('readId'in read))throw new ResearchError(410,'not_found','正文快照已失效');
      if(read.hash!==selection.hash)throw new ResearchError(409,'upstream','正文版本已变化，请重新读取');
      if(read.kind!=='article'||read.status!=='readable'||!read.text)throw new ResearchError(422,'not_found','请选择已读取的报道正文，线索不能作为证据');
      return {url:read.url,title:read.title,text:read.text,status:read.status,readAt:read.readAt,hash:read.hash,publishedAt:read.publishedAt,truncated:read.truncated,
        readProvider:read.provider==='jina'?'jina':'direct',sourceKind:read.kind,links:read.candidates.map(c=>({title:c.title,url:c.url}))};
    });
  }
}
