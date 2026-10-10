import {chromium,type Browser} from 'playwright';
import type {AssetStore} from './assets-store.js';
import type {ArticleRecord} from './article-types.js';
import {resolveToutiaoBrowser} from './toutiao-browser.js';
import {modernWechatLayout} from './wechat-templates.js';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderArticleIllustrationHtml(a:ArticleRecord,section?:number){
 const draft=a[a.adopted]??a.draft;if(!draft)throw new Error('没有当前稿件');
 const part=section===undefined?undefined:draft.sections[section];
 const title=part?.heading??draft.title,color=a.layoutOptions?.themeColor??(a.layoutVersion===2?modernWechatLayout(a.layoutTemplate!).color:'#2563eb');
 const text=part?.paragraphs.join(' ').replace(/<[^>]*>/g,'').slice(0,160)??'概念 · 用途 · 资料与边界';
 return `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1280px;height:${part?900:720}px;box-sizing:border-box;background:#f4f7fb;color:#15232c;font-family:'PingFang SC','Microsoft YaHei',sans-serif;padding:80px;overflow:hidden"><p style="margin:0;font-size:24px;letter-spacing:3px;color:${color}">${part?'内容示意图 · '+String(section!+1).padStart(2,'0'):'文章封面'}</p><div style="width:90px;height:6px;background:${color};margin:35px 0"></div><h1 style="font-size:${part?52:68}px;line-height:1.4;overflow-wrap:anywhere;margin:0 0 30px">${escape(title)}</h1><p style="font-size:30px;line-height:1.9;overflow-wrap:anywhere;margin:0">${escape(text)}</p><p style="position:absolute;bottom:55px;left:80px;font-size:20px;color:#64748b">${part?'基于文章文字的示意图，不代表现场照片或数据验证':'正文与资料以文章为准'}</p></body>`;
}
export class ArticleIllustrations {
 constructor(private deps:{assets:AssetStore;rootDir:string;browserBinary?:string}){}
 async generate(a:ArticleRecord,signal:AbortSignal):Promise<Pick<ArticleRecord,'coverAssetId'|'bodyImageAssetIds'|'bodyImagePlacements'>>{
  signal.throwIfAborted();const target=resolveToutiaoBrowser({repoRoot:this.deps.rootDir,browserBinary:this.deps.browserBinary,allowSystemChrome:false,env:{}}).target;
  if(!target||target.kind==='channel')throw new Error('自动配图需要项目内置浏览器，请运行 prepare:package:mac；正文已保留');
  let browser:Browser|undefined;const added:string[]=[];
  try{
   browser=await chromium.launch({headless:true,...(target.kind==='executablePath'?{executablePath:target.path}:{})});
   const stop=()=>{void browser?.close().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
   try{
    const page=await browser.newPage();await page.route('**/*',r=>r.abort());
    const capture=async(section?:number)=>{signal.throwIfAborted();await page.setViewportSize({width:1280,height:section===undefined?720:900});await page.setContent(renderArticleIllustrationHtml(a,section));await page.evaluate(()=>document.fonts.ready);const buffer=await page.screenshot({type:'png'});signal.throwIfAborted();const asset=await this.deps.assets.add('image',{originalName:section===undefined?'文章排版封面.png':`第${section+1}节示意图.png`,data:buffer,metadata:{description:'本地生成的文章文字示意图',tags:['文章配图','示意图']}});added.push(asset.id);return asset.id;};
    const coverAssetId=await capture();const count=(a[a.adopted]??a.draft)!.sections.length;
    const planned=[...new Set(a.illustrations.filter(i=>i.section>0&&i.section<=count).map(i=>i.section-1))].slice(0,2);if(!planned.length)planned.push(0);
    const bodyImageAssetIds:string[]=[],bodyImagePlacements:Array<{section:number;caption:string}>=[];
    for(const section of planned){bodyImageAssetIds.push(await capture(section));bodyImagePlacements.push({section,caption:'基于文章文字的示意图'});}
    signal.throwIfAborted();return{coverAssetId,bodyImageAssetIds,bodyImagePlacements};
   }finally{signal.removeEventListener('abort',stop);}
  }catch(error){for(const id of added)await this.deps.assets.remove(id).catch(()=>{});throw error;}
  finally{await browser?.close().catch(()=>{});}
 }
}
