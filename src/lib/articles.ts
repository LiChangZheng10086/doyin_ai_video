import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ActorSnapshot, PublishingPackageDetail } from '../types.js';
import { LocalStorage } from './storage.js';
import { articlePublicUrl, readArticleSource } from './article-sources.js';
import { validateWritingResult, type ArticleWritingService } from './article-writing.js';
import { ARTICLE_STEPS, type ArticleRecord, type ArticleStep, type ArticlePreview, type ArticleMaterial } from './article-types.js';
import { renderWechatArticleHtml } from './wechat-article.js';
import { wechatLayout } from './wechat-templates.js';
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
  resolveHotspot?: (sourceId: string, itemId: string) => Promise<ArticleRecord['hotspot']>;
  resolveAsset?: (id: string) => Promise<ResolvedAssetFile | null>;
  createPackage?: (input: ArticlePackageInput) => Promise<PublishingPackageDetail>;
  resolveBenchmark?: (id: string) => Promise<{domain:string;audience:string;styleSample:string}>;
};

export class ArticleService {
  private loaded?: Promise<Record<string, ArticleRecord>>;
  private tail: Promise<unknown> = Promise.resolve();
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
      for (const a of Object.values(records)) if (a.running) {
        if (ARTICLE_STEPS.includes(a.running as ArticleStep)) a.steps[a.running as ArticleStep] = 'failed';
        delete a.running; a.error = '上次操作被中断，请重新执行'; a.version++; recovered = true;
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
  private editable(a: ArticleRecord, version: unknown) {
    if (a.running) throw new ArticleError(409, '文章正在处理，请等待完成');
    if (!Number.isInteger(version) || a.version !== version) throw new ArticleError(409, '文章版本已变化，请刷新后重试');
  }
  private async persist(a: ArticleRecord): Promise<ArticleRecord> {
    a.version++; a.updatedAt = new Date().toISOString();
    const next = { ...await this.index(), [a.id]: a };
    await this.deps.storage.writeJsonAtomic(INDEX, next); this.loaded = Promise.resolve(next); return structuredClone(a);
  }
  private invalidate(a: ArticleRecord, from: ArticleStep) {
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
  async list(): Promise<ArticleRecord[]> { return this.serial(async () => structuredClone(Object.values(await this.index()).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)))); }
  async get(id: string): Promise<ArticleRecord> { return this.serial(() => this.record(id)); }
  async create(input: unknown): Promise<ArticleRecord> {
    return this.serial(async () => {
      const data = object(input); let hotspot: ArticleRecord['hotspot'];
      if (data.hotspot) { const h = object(data.hotspot); hotspot = await this.deps.resolveHotspot?.(field(h.sourceId,100,true), field(h.itemId,2048,true)); if (!hotspot) throw new ArticleError(404, '热榜线索已失效，请刷新或从收藏创建'); }
      let benchmark: {domain:string;audience:string;styleSample:string}|undefined;
      if (data.benchmarkId !== undefined) {
        if (!this.deps.resolveBenchmark) throw new ArticleError(422,'对标服务不可用');
        try { benchmark = await this.deps.resolveBenchmark(field(data.benchmarkId,100,true)); }
        catch(e) { throw new ArticleError(422,e instanceof Error ? e.message : '对标资料不可用'); }
      }
      const now = new Date().toISOString();
      const a: ArticleRecord = { id: randomUUID(), version: 0, keyword: field(data.keyword ?? hotspot?.title, 500, true), createdAt: now, updatedAt: now,
        requirements: { audience: '', purpose: '帮助读者理解事件与影响', viewpoint: '', styleSample: '', domain: '', structure: '', length: '1500～2500字' }, ...(hotspot ? { hotspot } : {}),
        topics: [], sources: [], facts: [], issues: [], reviewNotes: [], illustrations: [], reference: {},
        adopted: 'draft', reviewed: false, materialConfirmed: false, outlineConfirmed: false,
        author: '', digest: '', coverAssetId: '', bodyImageAssetIds: [], steps: Object.fromEntries(ARTICLE_STEPS.map(s => [s,'pending'])) as ArticleRecord['steps'] };
      if (hotspot) a.sources.push(this.newUrl(hotspot.url));
      if (benchmark) Object.assign(a.requirements,benchmark);
      return this.persist(a);
    });
  }
  private newUrl(url: string, depth: 0 | 1 = 0): ArticleMaterial {
    return { id: randomUUID(), url: publicUrl(url).href, title: new URL(url).hostname, text: '', included: true, kind: 'web', depth, status: 'needs_material', readAt: '', hash: '', links: [], truncated: false, error: '尚未读取' };
  }
  async update(id: string, input: unknown): Promise<ArticleRecord> {
    return this.serial(async () => {
      const p = object(input); const a = await this.record(id); this.editable(a,p.version);
      const allowed = ['layoutTemplate','editSourceText','version','keyword','requirements','selectedTopic','addText','addUrl','sourceEdits','removeSourceId','facts','outline','draft','revision','adopted','reviewed','materialConfirmed','outlineConfirmed','author','digest','coverAssetId','bodyImageAssetIds'];
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
      if (p.layoutTemplate !== undefined) {
        try { a.layoutTemplate = wechatLayout(field(p.layoutTemplate,100,true)).id; }
        catch { throw new ArticleError(422,'排版模板无效，请重新选择'); }
      }
      if (p.bodyImageAssetIds !== undefined) { if (!Array.isArray(p.bodyImageAssetIds) || p.bodyImageAssetIds.length > 10 || new Set(p.bodyImageAssetIds).size !== p.bodyImageAssetIds.length) throw new ArticleError(422,'正文图片最多10张，不可重复'); a.bodyImageAssetIds = p.bodyImageAssetIds.map((v: unknown) => field(v,100,true)); }
      delete a.error; return this.persist(a);
    });
  }
  private guard(a: ArticleRecord, step: ArticleStep) {
    if (step === 'diagnose') return;
    if (!a.selectedTopic || a.steps.diagnose !== 'succeeded') throw new ArticleError(422,'请先完成选题诊断并选择方向');
    if (!a.sources.some(s => s.included && s.status === 'readable')) throw new ArticleError(422,'资料不足，请读取正文或粘贴资料');
    if (step === 'evidence') return;
    if (!a.materialConfirmed || a.steps.evidence !== 'succeeded') throw new ArticleError(422,'请先整理事实并确认资料');
    if (step === 'outline') return;
    if (a.steps.outline !== 'succeeded' || !a.outlineConfirmed) throw new ArticleError(422,'请先生成并确认提纲');
    if (step === 'draft') return;
    if (a.steps.draft !== 'succeeded') throw new ArticleError(422,'请先完成初稿');
    if (step === 'illustrations' && (!a.reviewed || a.steps.review !== 'succeeded')) throw new ArticleError(422,'请先完成审校并人工确认定稿');
  }
  async run(id: string, step: ArticleStep, version: unknown): Promise<ArticleRecord> {
    if (!ARTICLE_STEPS.includes(step)) throw new ArticleError(400,'写作步骤无效');
    const snapshot = await this.serial(async () => { const a = await this.record(id); this.editable(a,version); this.guard(a,step); a.running = step; a.steps[step] = 'running'; delete a.error; return this.persist(a); });
    try {
      const result = await this.deps.writer.run(step,snapshot);
      return await this.serial(async () => {
        const a = await this.record(id); const next = ARTICLE_STEPS[ARTICLE_STEPS.indexOf(step)+1]; if (next) this.invalidate(a,next);
        if (step === 'diagnose') { a.topics = result.topics; delete a.selectedTopic; }
        if (step === 'evidence') { a.facts = result.facts; a.issues = result.issues; a.materialConfirmed = false; }
        if (step === 'outline') { a.outline = result; a.outlineConfirmed = false; }
        if (step === 'draft') a.draft = result;
        if (step === 'review') { a.revision = result.revision; a.reviewNotes = result.notes; a.adopted = 'revision'; a.reviewed = false; }
        if (step === 'illustrations') a.illustrations = result.images;
        a.steps[step] = 'succeeded'; delete a.running; return this.persist(a);
      });
    } catch (error) {
      await this.serial(async () => { const a = await this.record(id); delete a.running; a.steps[step] = 'failed'; a.error = '生成失败：请检查 AI 配置、资料与输出格式后重试'; return this.persist(a); });
      throw new ArticleError(422, error instanceof ArticleError ? error.message : '生成失败：请检查 AI 配置、资料与输出格式后重试');
    }
  }
  async readSources(id: string, version: unknown, ids: unknown): Promise<ArticleRecord> {
    const snapshot = await this.serial(async () => {
      const a = await this.record(id); this.editable(a,version);
      if (!Array.isArray(ids) || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length || ids.some(id => !a.sources.some(s => s.id === id && s.kind === 'web'))) throw new ArticleError(422,'每批请选择 1～3 个网页来源');
      a.running = 'read'; return this.persist(a);
    });
    try {
      const sources = await Promise.all(snapshot.sources.filter(s => (ids as string[]).includes(s.id)).map(async s => ({ ...s, ...await (this.deps.readSource ?? readArticleSource)(s.url) })));
      return await this.serial(async () => { const a = await this.record(id); a.sources = a.sources.map(s => sources.find(n => n.id === s.id) ?? s); this.invalidate(a,'evidence'); delete a.running; return this.persist(a); });
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
      sections: [...structuredClone(chosen.sections), { heading: '资料来源', paragraphs: a.sources.filter(s => s.included && a.facts.some(f => f.sourceId === s.id)).map(s => `${s.title}${s.url ? `：${s.url}` : '（用户提供）'}`), factIds: [] }] };
    if (!a.coverAssetId) throw new ArticleError(422,'请选择封面图片');
    const assets: ResolvedAssetFile[] = [];
    for (const id of [a.coverAssetId,...a.bodyImageAssetIds]) { const file = await this.deps.resolveAsset?.(id); if (!file || file.record.kind !== 'image') throw new ArticleError(422,'选中的图片已失效，请重新选择'); assets.push(file); }
    const hashes = await Promise.all(assets.map(a => readFile(a.path).then(hash)));
    const html = renderWechatArticleHtml(draft,{ layoutTemplate:a.layoutTemplate, images: a.bodyImageAssetIds.map((_,i) => ({slot:i+1})) });
    const previewRevision = hash(JSON.stringify({ article: a, hashes, html }));
    return { draft, html, cover: assets[0]!, images: assets.slice(1), hashes, previewRevision };
  }
  async preview(id: string, version: unknown): Promise<ArticlePreview> {
    return this.serial(async () => { const a = await this.record(id); this.editable(a,version); const p = await this.prepared(a); return { version:a.version, previewRevision:p.previewRevision, html:p.html, title:p.draft.title, sourceCount:a.sources.filter(s => s.included).length }; });
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
