import { WECHAT_LAYOUTS, WRITING_STRUCTURES, applyWechatLayout } from '../../../src/lib/wechat-templates';

const selectClass='mt-2 w-full rounded-lg border border-line-ui bg-canvas px-3 py-2 text-sm text-ink focus:border-accent focus:ring-1 focus:ring-accent';
export function ArticleTemplatePicker({value,onChange}:{value:string;onChange:(value:string)=>void}){
  const layout=WECHAT_LAYOUTS.find(t=>t.id===value)??WECHAT_LAYOUTS[0];
  return <section className="space-y-3 rounded-xl border border-line bg-canvas p-4">
    <label className="block text-xs font-medium text-ink-muted">排版模板<select aria-label="排版模板" value={value} onChange={e=>onChange(e.target.value)} className={selectClass}>{WECHAT_LAYOUTS.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    <p className="text-xs text-ink-muted">{layout.description}。选择后保存，再预览完整文章。</p>
    <iframe title={`${layout.name}样式示例`} sandbox="" className="h-44 w-full rounded-lg border border-line bg-white" srcDoc={applyWechatLayout('<section style="padding:12px;font-family:sans-serif;color:#333333;background:#ffffff;"><h2 style="font-size:19px;margin:12px 0;">章节标题 · 阅读示例</h2><p style="font-size:16px;line-height:1.9;">清楚解释一个问题，让读者了解依据、步骤与适用条件。</p></section>',layout.id)}/>
  </section>;
}

export function WritingStructurePicker({value,onChange}:{value:string;onChange:(value:string)=>void}){
  const choice=WRITING_STRUCTURES.find(t=>t.value===value);
  return <label className="block text-xs font-medium text-ink-muted">写作结构模板<select aria-label="写作结构模板" value={choice?.value??'custom'} onChange={e=>onChange(e.target.value)} className={selectClass}>{WRITING_STRUCTURES.map(t=><option key={t.name} value={t.value}>{t.name}</option>)}{!choice&&<option value="custom">自定义结构</option>}</select></label>;
}
