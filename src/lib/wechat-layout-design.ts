import { modernWechatLayout, validateWechatLayoutOptions, type WechatLayoutOptions } from './wechat-templates.js';
export interface DesignedSection { heading:string; paragraphs:Array<{html:string;kind:'body'|'quote'|'code'}>; images:string[] }
/** Consumes sanitized text/image fragments only. No CSS input, script, grid or external fonts. */
export function renderDesignedWechatLayout(id:string,options:WechatLayoutOptions,sections:DesignedSection[],references:string[],tailImages:string[]):string {
  const layout=modernWechatLayout(id),o=validateWechatLayoutOptions(options);
  const color=o.themeColor??layout.color,f=o.fontSize??layout.fontSize,lh=o.lineHeight??layout.lineHeight;
  const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16));
  const light=rgb[0]*.299+rgb[1]*.587+rgb[2]*.114>165,ink=light?'#1f2937':color;
  const family=id==='deep-reading'?"'Songti SC','STSong',serif":"-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";
  const body=`font-size:${f}px;line-height:${lh};color:#334155;margin:0 0 ${id==='deep-reading'?20:14}px;overflow-wrap:break-word;`;
  const root=`margin:0;max-width:100%;padding:${id==='image-story'?'14px 12px':'20px 18px'};font-family:${family};background:#ffffff;color:#1f2937;`;
  const emphasis=(html:string)=>html.replace(/<strong(?:\s[^>]*)?>/gi,`<strong style="font-weight:700;color:${ink};">`);
  const paragraph=(p:DesignedSection['paragraphs'][number],lead:boolean)=>{
    const html=emphasis(p.html);
    if(p.kind==='code')return `<section style="margin:18px 0;padding:14px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;font-family:Menlo,Consolas,monospace;font-size:${Math.max(13,f-2)}px;line-height:1.7;white-space:pre-wrap;word-break:break-all;">${html}</section>`;
    if(p.kind==='quote')return `<blockquote style="margin:20px 0;padding:12px 16px;border-left:${id==='deep-reading'?2:4}px solid ${color};background:${id==='deep-reading'?'#ffffff':'#f8fafc'};font-size:${f}px;line-height:${lh};color:#64748b;">${html}</blockquote>`;
    const leadStyle=lead&&id==='tech-explainer'?`padding:16px;border-top:2px solid ${color};background:#f8fafc;`:lead&&id==='business-brief'?`padding:12px 14px;border-left:4px solid ${color};background:#f1f5f9;`:'';
    const text = `<p style="${body}${id==='deep-reading'?'text-indent:2em;':''}">${html}</p>`;
    return leadStyle ? `<section style="margin-bottom:20px;${leadStyle}">${text}</section>` : text;
  };
  const heading=(text:string,i:number)=>{
    if(!text)return '';
    const base=`font-size:${f+3}px;line-height:1.45;font-weight:700;margin:0 0 16px;color:#15232c;`;
    if(id==='practical-guide')return `<section style="margin-bottom:14px;"><p style="font-size:12px;letter-spacing:2px;color:${ink};margin:0 0 6px;">${String(i+1).padStart(2,'0')}</p><h2 style="${base}padding-bottom:10px;border-bottom:2px solid ${color};">${text}</h2></section>`;
    if(id==='business-brief')return `<h2 style="${base}font-size:${f+2}px;padding:9px 12px;background:${color};color:${light?'#15232c':'#ffffff'};">${text}</h2>`;
    if(id==='deep-reading')return `<h2 style="${base}font-family:'Songti SC','STSong',serif;text-align:center;margin:12px 0 24px;padding:0 0 14px;border-bottom:1px solid #e2e8f0;">${text}</h2>`;
    if(id==='image-story')return `<h2 style="${base}font-weight:600;margin-top:16px;">${text}</h2>`;
    if(id==='resource-list')return `<h2 style="${base}padding-left:12px;border-left:4px solid ${color};">${text}</h2>`;
    return `<h2 style="${base}padding-left:12px;border-left:3px solid ${color};">${text}</h2>`;
  };
  const image=(html:string)=>html.replace(/<img([^>]*?)style="[^"]*"/g,`<img$1style="display:block;width:100%;max-width:100%;height:auto;margin:${id==='image-story'?12:20}px 0;border-radius:${id==='image-story'?0:4}px;"`);
  const parts=sections.map((s,i)=>{
    const wrapper=id==='resource-list'?'padding:18px 16px;border:1px solid #e2e8f0;border-radius:6px;':id==='business-brief'?'padding-bottom:12px;border-bottom:1px solid #e2e8f0;':'';
    const pictures=s.images.map(image).join('');
    return `<section style="margin:${i===0?0:id==='deep-reading'?40:28}px 0 0;${wrapper}">${id==='image-story'?pictures:''}${heading(s.heading,i)}${s.paragraphs.map((p,j)=>paragraph(p,i===0&&j===0)).join('\n')}${id==='image-story'?'':pictures}</section>`;
  });
  parts.push(...tailImages.map(image));
  if(references.length){
    const refStyle=id==='resource-list'?'padding:14px;background:#f8fafc;border:1px dashed #cbd5e1;':id==='business-brief'?'padding:12px;background:#f1f5f9;':'padding-top:16px;border-top:1px solid #e2e8f0;';
    parts.push(`<section style="margin-top:32px;${refStyle}"><p style="font-size:13px;color:${ink};font-weight:700;line-height:1.5;margin:0 0 10px;">资料来源</p>${references.map(ref=>`<p style="font-size:13px;line-height:1.7;color:#64748b;margin:0 0 8px;word-break:break-all;">${ref}</p>`).join('\n')}</section>`);
  }
  return `<section style="${root}">${parts.join('\n')}</section>`;
}
