import { request } from 'node:https';
import type { Readable } from 'node:stream';
import { articlePublicUrl, resolveArticleAddress } from './article-sources.js';
import { ResearchError } from './research-types.js';

export const RESEARCH_MAX_BYTES = 2 * 1024 * 1024;
export function researchPublicUrl(input: string): URL {
  const url=articlePublicUrl(input);
  for(const key of url.searchParams.keys()) if (/^(?:access_token|auth|authorization|token|xsec_token|signature|x-amz-signature|api_key|apikey)$/i.test(key)) {
    throw new ResearchError(400,'unsafe_url','请使用不含访问凭据的公开链接');
  }
  return url;
}
export async function validateResearchUrl(input: string, resolver?: Parameters<typeof resolveArticleAddress>[1]) {
  return resolveArticleAddress(researchPublicUrl(input).href,resolver);
}
export async function readBoundedResponse(response: Response, maxBytes=RESEARCH_MAX_BYTES): Promise<string> {
  if (!response.body) return '';
  const reader=response.body.getReader(); const chunks:Uint8Array[]=[];let count=0;
  try {
    for (;;) {const item=await reader.read();if(item.done)break;count+=item.value.byteLength;
      if(count>maxBytes) throw new ResearchError(502,'too_large','来源响应过大，请选择其它报道');chunks.push(item.value);}
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch(error) {await reader.cancel().catch(()=>{});throw error;} finally {reader.releaseLock();}
}

/** Native data may arrive after SDK cancellation; never enqueue after close/error. */
export function boundedNodeBody(source:Readable,signal:AbortSignal,maxBytes=RESEARCH_MAX_BYTES):ReadableStream<Uint8Array>{
  let finished=false;let bytes=0;let abort=()=>{};
  return new ReadableStream<Uint8Array>({
    start(controller){
      const stop=(error?:unknown)=>{if(finished)return;finished=true;signal.removeEventListener('abort',abort);if(error)controller.error(error);else controller.close();source.destroy();};
      abort=()=>stop(signal.reason??new Error('读取已取消'));
      source.on('data',(chunk:Buffer)=>{if(finished)return;bytes+=chunk.length;if(bytes>maxBytes){stop(new ResearchError(502,'too_large','来源响应过大'));return;}controller.enqueue(new Uint8Array(chunk));if((controller.desiredSize??0)<=0)source.pause();});
      source.on('error',error=>stop(error));source.on('end',()=>stop());source.on('close',()=>{if(!finished)stop(new ResearchError(502,'upstream','来源响应被中断'));});
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    },
    pull(){if(!finished)source.resume();},
    cancel(){if(finished)return;finished=true;signal.removeEventListener('abort',abort);source.destroy();},
  });
}

/** SDK fetch replacement: every socket uses a previously validated public address. */
export function createResearchFetch(deps:{resolveAddress?:typeof validateResearchUrl;request?:typeof request}={}) {
 return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const source=input instanceof Request ? input.url : String(input);
  const signal=init.signal ?? AbortSignal.timeout(30000);
  signal.throwIfAborted();
  const pinned=await new Promise<Awaited<ReturnType<typeof resolveArticleAddress>>>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    (deps.resolveAddress??validateResearchUrl)(source).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
  signal.throwIfAborted();
  const headers=new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value,key)=>headers.set(key,value));headers.set('accept-encoding','identity');
  headers.set('user-agent','douyin-ai-video/content-research');
  return new Promise((resolve,reject)=>{
    const req=(deps.request??request)(pinned.url,{agent:false,signal,method:init.method ?? (input instanceof Request ? input.method : 'GET'),headers:Object.fromEntries(headers),
      lookup:((_host:string,options:{all?:boolean},callback:(...args:any[])=>void)=>{
        const address={address:pinned.address,family:pinned.family};if(options.all)callback(null,[address]);else callback(null,address.address,address.family);
      }) as any},res=>{
      const status=res.statusCode ?? 502;
      if(status>=300 && status<400){res.destroy();reject(new ResearchError(502,'upstream','来源重定向，未自动跟随'));return;}
      if(Number(res.headers['content-length'])>RESEARCH_MAX_BYTES || (res.headers['content-encoding'] && res.headers['content-encoding']!=='identity')){
        res.destroy();reject(new ResearchError(502,'too_large','来源响应过大或编码不受支持'));return;
      }
      const out=new Headers();for(const [key,value]of Object.entries(res.headers))if(value!==undefined)out.set(key,Array.isArray(value)?value.join(', '):value);
      const body=[204,205,304].includes(status)?null:boundedNodeBody(res,signal);
      if(!body)res.resume();
      try {resolve(new Response(body,{status,headers:out}));}catch(error){res.destroy();reject(error);}
    });
    req.on('error',reject);
    if(init.body!==undefined && init.body!==null) {
      if(typeof init.body!=='string'){req.destroy();reject(new ResearchError(400,'unsupported_format','请求正文格式不受支持'));return;}
      req.write(init.body);
    }
    req.end();
  });
 };
}
export const researchFetch=createResearchFetch();
