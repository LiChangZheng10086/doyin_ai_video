/** Selected styles adapted from delphuy/Wechat-Article-editor (MIT).
 * Attribution: docs/third-party/wechat-article-editor.md. Only trusted constants enter HTML. */
export const WRITING_STRUCTURES = [
  { name: '自由组织', value: '' },
  { name: '教程步骤', value: '问题与适用人群 → 准备条件 → 具体步骤 → 常见问题 → 行动建议；步骤与效果必须有资料依据' },
  { name: '实用清单', value: '明确筛选条件 → 分项说明与依据 → 使用限制 → 选择建议；不虚构排行与推荐理由' },
  { name: '案例分析', value: '有来源的案例背景 → 问题与过程 → 原因分析 → 可借鉴做法与边界；不虚构亲身经历' },
  { name: '方案比较', value: '读者需求 → 统一比较维度 → 各方案事实与取舍 → 按情境给建议；不制造数据' },
  { name: '观点论证', value: '核心主张 → 证据与分析 → 反例或条件 → 有边界的结论；区分观点与事实' },
  { name: '资讯解读', value: '可核验的新变化 → 背景 → 对目标读者的影响 → 不确定性 → 可采取的行动' },
] as const;

export const WECHAT_LAYOUTS = [
  { id: 'default', name: '默认阅读', description: '沿用已有公众号排版', color: '#333333', styles: {} },
  { id: 'minimal-read', name: '极简阅读', description: '细左边线标题、宽松正文', color: '#2563eb', styles: {
    h2: 'font-size:19px;font-weight:700;margin:28px 0 12px;color:#111827;padding-left:12px;border-left:3px solid #2563eb;line-height:1.4;',
    p: 'font-size:16px;margin:0 0 14px;line-height:1.85;color:#374151;',
    strong: 'font-weight:700;color:#2563eb;',
  } },
  { id: 'business-brief', name: '商务简报', description: '蓝色色块标题、首行缩进', color: '#1e40af', styles: {
    h2: 'font-size:18px;font-weight:700;background-color:#1e40af;color:#ffffff;display:inline-block;padding:6px 14px;margin:22px 0 12px;border-radius:2px;line-height:1.35;',
    p: 'font-size:16px;margin:0 0 14px;line-height:1.85;text-indent:2em;color:#334155;',
    strong: 'font-weight:700;color:#1e40af;',
  } },
  { id: 'tutorial-steps', name: '教程步骤', description: '紫色胶囊标题、清晰分节', color: '#7c3aed', styles: {
    h2: 'font-size:18px;font-weight:800;margin:24px 0 12px;color:#ffffff;background-color:#7c3aed;display:inline-block;padding:7px 14px;border-radius:999px;line-height:1.3;',
    p: 'font-size:16px;margin:0 0 12px;line-height:1.8;color:#1f2937;',
    strong: 'font-weight:800;color:#111827;',
  } },
  { id: 'daily-news', name: '日报资讯', description: '紧凑正文、灰底分区标题', color: '#dc2626', styles: {
    h2: 'font-size:18px;font-weight:800;margin:18px 0 8px;color:#111827;background-color:#f3f4f6;padding:8px 10px;border-left:3px solid #dc2626;line-height:1.35;',
    p: 'font-size:16px;margin:0 0 10px;line-height:1.7;color:#1f2937;',
    strong: 'font-weight:800;color:#111827;',
  } },
] as const;

export function wechatLayout(id = 'default') {
  const layout = WECHAT_LAYOUTS.find(item => item.id === id) ?? MODERN_WECHAT_LAYOUTS.find(item => item.id === id);
  if (!layout) throw new Error('排版模板无效，请重新选择');
  return layout;
}

/** Input has already been sanitized by wechat-article; never accepts user CSS. */
export function applyWechatLayout(html: string, id?: string): string {
  const layout = wechatLayout(id);
  const styles = ('styles' in layout ? layout.styles : {}) as Record<string, string>;
  return html.replace(/<(h2|p|strong)(\s[^>]*)?>/giu, (tag, name: string, attrs = '') => {
    const style = styles[name.toLowerCase()];
    return style ? `<${name}${attrs.replace(/\sstyle="[^"]*"/giu, '')} style="${style}">` : tag;
  });
}

/** Version 2 is opt-in: saved legacy IDs keep their original rendering. */
export const MODERN_WECHAT_LAYOUTS = [
  { id:'tech-explainer',name:'科技解读',description:'概念导语、细线章节、注释配图',color:'#2563eb',fontSize:16,lineHeight:1.85 },
  { id:'practical-guide',name:'实操教程',description:'步骤标记、代码框、截图与提示',color:'#087f72',fontSize:16,lineHeight:1.8 },
  { id:'business-brief',name:'商务简报',description:'摘要栏、资讯分区、紧凑来源',color:'#1e40af',fontSize:16,lineHeight:1.8 },
  { id:'deep-reading',name:'深度长文',description:'书页留白、衬线章节、安静引用',color:'#555165',fontSize:17,lineHeight:2 },
  { id:'image-story',name:'图片故事',description:'大图在前、轻标题、留白图注',color:'#b4533c',fontSize:16,lineHeight:1.9 },
  { id:'resource-list',name:'清单推荐',description:'条目卡片、醒目分项、资源注释',color:'#496b38',fontSize:16,lineHeight:1.8 },
] as const;
export interface WechatLayoutOptions { themeColor?: string; fontSize?: number; lineHeight?: number }
export interface WechatLayoutDefaults { version:number; layoutTemplate:string; layoutVersion:2; layoutOptions:WechatLayoutOptions }
export const FACTORY_WECHAT_LAYOUT = {layoutTemplate:'tech-explainer',layoutVersion:2 as const,layoutOptions:{}};
export function validateWechatLayoutOptions(value:unknown):WechatLayoutOptions {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('排版选项须为对象');
  const o=value as Record<string,unknown>;
  if(Object.keys(o).some(k=>!['themeColor','fontSize','lineHeight'].includes(k)))throw new Error('排版包含未知设置');
  if(o.themeColor!==undefined && (typeof o.themeColor!=='string'||!/^#[a-f0-9]{6}$/i.test(o.themeColor)))throw new Error('主题色须为六位十六进制颜色');
  if(o.fontSize!==undefined && (!Number.isInteger(o.fontSize)||Number(o.fontSize)<15||Number(o.fontSize)>18))throw new Error('正文字号须为15～18');
  if(o.lineHeight!==undefined && (typeof o.lineHeight!=='number'||!Number.isFinite(o.lineHeight)||o.lineHeight<1.5||o.lineHeight>2.1))throw new Error('行距须为1.5～2.1');
  return {...o} as WechatLayoutOptions;
}
export function modernWechatLayout(id:string) {
  const layout=MODERN_WECHAT_LAYOUTS.find(item=>item.id===id);
  if(!layout)throw new Error('请选择六类新版模板之一');
  return layout;
}
