import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseExaCandidates, parseResearchContent } from './research-content.js';
import { readBoundedResponse, researchFetch, validateResearchUrl } from './research-http.js';
import { ResearchError, type ResearchCandidate, type ResearchContent } from './research-types.js';

export interface ResearchProviders {
  search(query:string,signal:AbortSignal):Promise<ResearchCandidate[]>;
  readJina(url:string,signal:AbortSignal):Promise<ResearchContent>;
}
export function providerFailure(error:unknown):ResearchError {
  if(error instanceof ResearchError)return error;
  if(error instanceof Error && /abort|timeout/i.test(error.name+' '+error.message))return new ResearchError(504,'timeout','资料服务请求超时，请稍后重试');
  return new ResearchError(502,'upstream','资料服务暂不可用，请手动添加公开链接或文字资料');
}
export function createResearchProviders(fetcher:typeof researchFetch=researchFetch,validate:(url:string)=>Promise<unknown>=validateResearchUrl):ResearchProviders {
  return {
    async readJina(url,outerSignal){
      const signal=AbortSignal.any([outerSignal,AbortSignal.timeout(30000)]);
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>reject(signal.reason);signal.throwIfAborted();signal.addEventListener('abort',abort,{once:true});
        validate(url).then(()=>resolve(),reject).finally(()=>signal.removeEventListener('abort',abort));
      });
      const response=await fetcher(`https://r.jina.ai/${url}`,{signal,headers:{Accept:'text/plain'},redirect:'error'});
      if(response.status===429){await response.body?.cancel();throw new ResearchError(429,'rate_limited','Jina 阅读已限频，请稍后重试',60);}
      if(!response.ok){await response.body?.cancel();throw new ResearchError(502,response.status===403?'blocked':'upstream','阅读服务未返回目标正文');}
      return parseResearchContent({url,provider:'jina',format:'markdown',body:await readBoundedResponse(response)});
    },
    async search(query,outerSignal){
      const signal=AbortSignal.any([outerSignal,AbortSignal.timeout(30000)]);
      const endpoint=new URL('https://mcp.exa.ai/mcp?tools=web_search_exa');
      const transport=new StreamableHTTPClientTransport(endpoint,{requestInit:{signal,redirect:'error'},
        fetch:async(input,init)=>{
          const target=new URL(input instanceof Request?input.url:String(input));
          if(target.origin!==endpoint.origin||target.pathname!==endpoint.pathname)throw new ResearchError(502,'unsafe_url','搜索工具请求了未允许的端点');
          const combined=AbortSignal.any([signal,...(init?.signal?[init.signal]:[])]);
          const response=await fetcher(input, {...init,signal:combined,redirect:'error'});
          if(response.status===429){await response.body?.cancel();throw new ResearchError(429,'rate_limited','Exa 搜索已达到免费限额，请稍后重试',60);}
          return response;
        },reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
      const client=new Client({name:'douyin-content-research',version:'1.0.0'});
      const abort=()=>{void transport.close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
      try{
        await client.connect(transport,{signal,timeout:30000});
        const listed=await client.listTools({}, {signal,timeout:30000});
        const tool=listed.tools.find(t=>t.name==='web_search_exa');
        const properties=tool?.inputSchema.properties as Record<string,unknown>|undefined;
        if(!tool||!properties?.query||!properties?.numResults||(tool.inputSchema.required??[]).some(k=>!['query','objective','numResults'].includes(k)))
          throw new ResearchError(502,'unsupported_format','搜索工具参数已变化，请手动添加链接');
        const result=await client.callTool({name:'web_search_exa',arguments:{query,numResults:5,...(properties.objective?{objective:'查找与选题直接相关的公开原始报道，保留来源链接，不编造事实'}:{})}},undefined,{signal,timeout:30000});
        return parseExaCandidates(result);
      }finally{signal.removeEventListener('abort',abort);await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});await transport.close().catch(()=>{});}
    },
  };
}
