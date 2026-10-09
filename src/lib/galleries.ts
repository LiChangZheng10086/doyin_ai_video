import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { ActorSnapshot, JobRecord, PublishingPackageDetail, TranscriptAsset } from '../types.js';
import { LocalStorage } from './storage.js';
import { resolveSourceVideo } from './video-output.js';
import { GalleryError, GalleryMedia, validateGalleryImage } from './gallery-media.js';
import type { Gallery, GalleryDraft, GalleryPlanInput, GalleryPreview, GallerySource, GalleryTranslation } from './gallery-types.js';
import { SAU_NOTE_MAX_IMAGES } from './sau-runner.js';
import { galleryPlanBlockReason, planGallery } from './gallery-planner.js';
import { PUBLISH_NOTE_POLICIES, validateNoteCopy } from './publishing-platforms.js';
import type { GalleryCopyWriter } from './gallery-copy.js';
import { isYouTubeUrl } from './youtube.js';
import { GalleryTranslator, planTranslatedGallery, validateGalleryTranslationCues } from './gallery-translation.js';
import { inspectTranscriptQuality } from './transcript-quality.js';

const INDEX = 'cache/galleries.json';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const imageHash = (g: GalleryDraft & { translation?: GalleryTranslation }) => hash(JSON.stringify(g.translation ? [g.images, g.translation.cues] : g.images));
const sourceHash = (file: string, stat: Stats) => hash(JSON.stringify([file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
const safeId = (id: string) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new GalleryError(400, '图集或作品标识不合法');
};

type Deps = {
  storage: LocalStorage;
  jobs: { get(id: string): Promise<JobRecord | null> };
  media?: Pick<GalleryMedia, 'probe' | 'frame' | 'render'> & Partial<Pick<GalleryMedia, 'suggestSubtitle' | 'suggestSubtitles' | 'suggestMainCrop'>>;
  createPackage?: (gallery: Gallery, paths: string[], actor: ActorSnapshot) => Promise<PublishingPackageDetail>;
  copyWriter?: Pick<GalleryCopyWriter, 'write'>;
  translator?: Pick<GalleryTranslator, 'translate'>;
};

export class GalleryService {
  private readonly media: Pick<GalleryMedia, 'probe' | 'frame' | 'render'> & Partial<Pick<GalleryMedia, 'suggestSubtitle' | 'suggestSubtitles' | 'suggestMainCrop'>>;
  private loaded?: Promise<Record<string, Gallery>>;
  private tail: Promise<unknown> = Promise.resolve();
  // ponytail: one local render at a time; use a bounded queue if parallel production is needed.
  private rendering = false;

  constructor(private readonly deps: Deps) { this.media = deps.media ?? new GalleryMedia(); }

  private async index(): Promise<Record<string, Gallery>> {
    return this.loaded ??= (async () => {
      let records: Record<string, Gallery>;
      try { records = await this.deps.storage.readJson(INDEX); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        records = {};
      }
      let recovered = false;
      for (const record of Object.values(records)) {
        if (record.status === 'running') {
          record.status = 'failed'; record.error = '上次生成被中断，请重新生成'; record.version++; recovered = true;
        }
      }
      if (recovered) await this.deps.storage.writeJsonAtomic(INDEX, records);
      return records;
    })();
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async record(id: string): Promise<Gallery> {
    safeId(id);
    const records = await this.index();
    const record = Object.hasOwn(records, id) ? records[id] : undefined;
    if (!record) throw new GalleryError(404, '图集不存在或已删除', 'gallery_not_found');
    return record;
  }

  private async persist(record: Gallery): Promise<Gallery> {
    const records = await this.index();
    const next = { ...records, [record.id]: record };
    await this.deps.storage.writeJsonAtomic(INDEX, next);
    this.loaded = Promise.resolve(next);
    return structuredClone(record);
  }

  private editable(record: Gallery, version: number): void {
    if (record.status === 'running') throw new GalleryError(409, '图集生成中，请等待完成');
    if (!Number.isInteger(version) || record.version !== version) throw new GalleryError(409, '图集版本已变化，请刷新后重试');
  }

  private async openSource(jobId: string) {
    safeId(jobId);
    const job = await this.deps.jobs.get(jobId);
    if (!job || job.deletedAt) throw new GalleryError(404, '来源作品不存在或已删除');
    return resolveSourceVideo(this.deps.storage.resolve(), job);
  }

  private async sourceFingerprint(jobId: string): Promise<string> {
    const video = await this.openSource(jobId);
    try { return sourceHash(video.path, await video.handle.stat()); }
    finally { await video.close(); }
  }

  private async withSource<T>(jobId: string, action: (source: { path: string; fingerprint: string; info: GallerySource }) => Promise<T>): Promise<T> {
    const video = await this.openSource(jobId);
    let dir = '';
    try {
      const fingerprint = sourceHash(video.path, await video.handle.stat());
      // ponytail: a private disk snapshot keeps FFmpeg bound to the verified inode; fd-aware spawning if copy cost matters.
      dir = await mkdtemp(path.join(tmpdir(), 'gallery-source-'));
      const snapshot = path.join(dir, 'source.mp4');
      await pipeline(video.handle.createReadStream({ autoClose: false }), createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }));
      if (sourceHash(video.path, await video.handle.stat()) !== fingerprint) throw new GalleryError(409, '原视频在读取期间发生变化，请重试');
      return await action({ path: snapshot, fingerprint, info: await this.media.probe(snapshot) });
    } finally { await video.close(); if (dir) await rm(dir, { recursive: true, force: true }); }
  }

  private normalize(input: GalleryDraft, duration: number, translated = false): GalleryDraft {
    if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200
      || typeof input.description !== 'string' || input.description.length > 20_000
      || !Array.isArray(input.hashtags) || input.hashtags.length > 50
      || !input.hashtags.every(t => typeof t === 'string' && t.length <= 200)
      || !Array.isArray(input.images) || input.images.length < 1 || input.images.length > SAU_NOTE_MAX_IMAGES) {
      throw new GalleryError(422, `标题、文案或图片数量不合法（图集需 1～${SAU_NOTE_MAX_IMAGES} 张）`);
    }
    const images = input.images.map(image => {
      if (image.translatedCaptions !== undefined && !translated) throw new GalleryError(422, '原生字幕图集不能注入译文字幕');
      validateGalleryImage(image, duration);
      return { mainTime: image.mainTime, times: [...image.times], bandTop: image.bandTop, bandBottom: image.bandBottom, mainFraction: image.mainFraction,
        ...(image.translatedCaptions ? { translatedCaptions: [...image.translatedCaptions] } : {}),
        ...(image.compact ? { compact: true } : {}),
        ...(image.filmstrip ? { filmstrip: true } : {}),
        ...(image.mainCrop ? { mainCrop: { left: image.mainCrop.left, right: image.mainCrop.right, top: image.mainCrop.top, bottom: image.mainCrop.bottom } } : {}) };
    });
    return { title: input.title.trim(), description: input.description, hashtags: input.hashtags.map(t => t.trim().replace(/^#+/, '')).filter(Boolean), images };
  }

  async list(): Promise<Gallery[]> {
    return this.serial(async () => structuredClone(Object.values(await this.index()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))));
  }

  async get(id: string): Promise<Gallery> {
    return this.serial(async () => {
      const gallery = structuredClone(await this.record(id));
      if (gallery.plan) gallery.plan.blockedReason = galleryPlanBlockReason(gallery.plan);
      if (gallery.translation) {
        try { await this.checkedTranslation(gallery); }
        catch { gallery.error = '译文依据的转录或来源已变化，请重新翻译。'; }
      }
      if (gallery.copyReference) {
        try { await this.checkedCopy(gallery); }
        catch { gallery.copyError = '文案依据的转录或来源已变化，请重新生成图文文案并核对。'; }
      }
      return gallery;
    });
  }

  async create(sourceJobId: string, mode?: 'native' | 'translated'): Promise<Gallery> {
    return this.serial(async () => {
      return this.withSource(sourceJobId, async source => {
      const job = await this.deps.jobs.get(sourceJobId);
      if (mode !== undefined && mode !== 'native' && mode !== 'translated') throw new GalleryError(422, '图集模式不合法');
      const selectedMode = mode ?? (isYouTubeUrl(job?.sourceUrl ?? '') ? 'translated' : 'native');
      const now = new Date().toISOString();
      return this.persist({ id: randomUUID(), sourceJobId, mode: selectedMode, title: (job?.topic || '字幕图集').slice(0, 20), description: '', hashtags: [],
        images: [{ mainTime: source.info.duration / 5, times: [1, 2, 3, 4].map(i => source.info.duration * i / 5), bandTop: 0.78, bandBottom: 0.96, mainFraction: 0.7 }],
        version: 1, status: 'draft', createdAt: now, updatedAt: now });
      });
    });
  }

  async update(id: string, input: GalleryDraft & { version: number; translation?: GalleryTranslation }): Promise<Gallery> {
    return this.serial(async () => {
      const current = await this.record(id); this.editable(current, input?.version);
      return this.withSource(current.sourceJobId, async source => {
      const translated = current.mode === 'translated';
      let translation = current.translation;
      if (input.translation !== undefined) {
        if (!translated || !translation || !input.translation || !Array.isArray(input.translation.cues)) throw new GalleryError(422, '请先生成可信译文');
        await this.checkedTranslation(current);
        validateGalleryTranslationCues(input.translation.cues, true, source.info.duration);
        const originals = (t: GalleryTranslation) => JSON.stringify({ ...t, cues: t.cues.map(({ text: _text, ...cue }) => cue) });
        if (originals(input.translation) !== originals(translation)) throw new GalleryError(422, '译文原文、时间与来源不可修改，请重新翻译');
        translation = { ...translation, cues: input.translation.cues.map((cue, i) => ({ ...translation!.cues[i]!, text: cue.text.trim() })) };
      }
      const draft = this.normalize(input, source.info.duration, translated);
      const imagesUnchanged = imageHash(this.normalize(current, source.info.duration, translated)) === imageHash(draft);
      if (translated && !imagesUnchanged) throw new GalleryError(422, '译文图片只能按已确认方案生成，请修改译文后重新规划');
      const sameImages = imagesUnchanged
        && JSON.stringify(translation) === JSON.stringify(current.translation);
      if (sameImages) draft.images = current.images;
      const ready = sameImages && current.generated?.draftHash === imageHash({ ...draft, translation }) && current.generated.sourceFingerprint === source.fingerprint;
      const saved = await this.persist({ ...current, ...draft, translation,
        copyError: !sameImages && translated && current.copyReference?.translationHash ? '译文已修改，请重新生成配套文案并核对。' : current.copyError, plan: sameImages ? current.plan : undefined, appliedPlanId: sameImages ? current.appliedPlanId : undefined,
        version: current.version + 1, status: ready ? 'ready' : 'draft', error: undefined, updatedAt: new Date().toISOString() });
      if (current.plan && !sameImages) { safeId(current.plan.id); await rm(path.join(await this.outputRoot(), current.id, `plan-${current.plan.id}`), { recursive: true, force: true }).catch(() => undefined); }
      return saved;
      });
    });
  }

  async remove(id: string, version: number): Promise<void> {
    return this.serial(async () => {
      const current = await this.record(id); this.editable(current, version);
      const records = { ...await this.index() }; delete records[id];
      await this.deps.storage.writeJsonAtomic(INDEX, records); this.loaded = Promise.resolve(records);
      // Generated directories use server UUIDs only; removing a draft never removes copied publish assets.
      const root = await this.outputRoot();
      await rm(path.join(root, id), { recursive: true, force: true });
    });
  }

  async inspectSource(id: string): Promise<GallerySource> {
    const gallery = await this.get(id); const policy = PUBLISH_NOTE_POLICIES.douyin!;
    return this.withSource(gallery.sourceJobId, async source => ({ ...source.info, imageLimit: SAU_NOTE_MAX_IMAGES,
      copyLimits: { titleMax: policy.titleMax, descriptionMax: policy.descriptionMax, hashtagMax: policy.hashtagMax } }));
  }

  async frame(id: string, time: number): Promise<Buffer> {
    const gallery = await this.get(id);
    return this.withSource(gallery.sourceJobId, source => this.media.frame(source.path, time));
  }

  private async outputRoot(): Promise<string> {
    const dir = this.deps.storage.resolve('output/galleries');
    await mkdir(dir, { recursive: true });
    const [root, target] = await Promise.all([realpath(this.deps.storage.resolve()), realpath(dir)]);
    if (!target.startsWith(root + path.sep)) throw new GalleryError(422, '图集目录越出本地存储范围');
    return target;
  }

  private async transcript(jobId: string): Promise<{ asset: TranscriptAsset; hash: string }> {
    safeId(jobId);
    let bytes: Buffer;
    try {
      const file = this.deps.storage.resolve('raw/transcripts', `${jobId}.json`);
      const canonical = await realpath(file);
      const root = await realpath(this.deps.storage.resolve());
      if (!canonical.startsWith(root + path.sep)) throw new Error('outside storage');
      bytes = await readFile(canonical);
    } catch { throw new GalleryError(422, '没有可用视频转录，请先重新转录'); }
    try { return { asset: JSON.parse(bytes.toString('utf8')) as TranscriptAsset, hash: hash(bytes) }; }
    catch { throw new GalleryError(422, '转录文件损坏，请重新转录'); }
  }

  private async checkedTranslation(gallery: Gallery): Promise<void> {
    if (!gallery.translation) throw new GalleryError(422, '请先生成中文译文并核对');
    if (gallery.translation.transcriptHash !== (await this.transcript(gallery.sourceJobId)).hash
      || gallery.translation.sourceFingerprint !== await this.sourceFingerprint(gallery.sourceJobId)) {
      throw new GalleryError(409, '转录或原视频已变化，请重新翻译');
    }
  }

  async translate(id: string, input: { version: number; start: number; end: number }): Promise<Gallery> {
    return this.serial(async () => {
      const current = await this.record(id); this.editable(current, input?.version);
      if (current.mode !== 'translated') throw new GalleryError(422, '当前图集使用原生字幕，请新建中文译文图集');
      if (!this.deps.translator) throw new GalleryError(503, '翻译服务未就绪');
      return this.withSource(current.sourceJobId, async source => {
        if (![input.start, input.end].every(n => typeof n === 'number' && Number.isFinite(n))
          || input.start < 0 || input.end <= input.start || input.end > source.info.duration) throw new GalleryError(422, '翻译范围须在原视频时长内，结束大于开始');
        const transcript = await this.transcript(current.sourceJobId);
        const asset = transcript.asset;
        if (!Array.isArray(asset.segments)) throw new GalleryError(422, '缺少时间轴，请重新转录');
        const issues = inspectTranscriptQuality({ segments: asset.segments, text: asset.transcript || asset.text || '', duration: source.info.duration });
        if (issues.length) throw new GalleryError(422, `转录存在异常，请重新转录：${issues.join('；')}`);
        const cues = asset.segments.flatMap((s, segmentIndex) => typeof s.start === 'number' && typeof s.end === 'number'
          && s.end > input.start && s.start < input.end && s.text.trim()
          ? [{ segmentIndex, original: s.text, text: '', start: s.start, end: Math.min(s.end, source.info.duration) }] : []);
        if (!cues.length) throw new GalleryError(422, '所选范围没有文字，请调整片段');
        if (cues.length > 315) throw new GalleryError(422, '所选片段超过 35 张图集的容量，请缩小翻译范围；原文全文已保留');
        validateGalleryTranslationCues(cues, false, source.info.duration);
        const translated = await this.deps.translator!.translate(cues);
        validateGalleryTranslationCues(translated, true, source.info.duration);
        if (JSON.stringify(translated.map(({text: _text,...cue})=>cue)) !== JSON.stringify(cues.map(({text: _text,...cue})=>cue))) throw new GalleryError(422, '翻译结果原文或时间不一致，请重试');
        if ((await this.transcript(current.sourceJobId)).hash !== transcript.hash
          || await this.sourceFingerprint(current.sourceJobId) !== source.fingerprint) throw new GalleryError(409, '翻译期间来源已变化，请重新翻译');
        const saved = await this.persist({ ...current, translation: { start: input.start, end: input.end, cues: translated,
          transcriptHash: transcript.hash, sourceFingerprint: source.fingerprint }, plan: undefined, appliedPlanId: undefined,
          status: 'draft', error: undefined, version: current.version + 1, updatedAt: new Date().toISOString() });
        if (current.plan) { safeId(current.plan.id); await rm(path.join(await this.outputRoot(), current.id, `plan-${current.plan.id}`), {recursive:true,force:true}).catch(()=>undefined); }
        return saved;
      });
    });
  }

  async plan(id: string, input: GalleryPlanInput): Promise<Gallery> {
    return this.serial(async () => {
      const current = await this.record(id); this.editable(current, input?.version);
      if (current.mode !== 'translated' && !this.media.suggestSubtitle && !this.media.suggestSubtitles) throw new GalleryError(503, '字幕候选检测未就绪');
      return this.withSource(current.sourceJobId, async source => {
        const transcript = await this.transcript(current.sourceJobId);
        if (current.mode === 'translated') await this.checkedTranslation(current);
        const proposal = current.mode === 'translated'
          ? planTranslatedGallery(current.translation!, input.targetLines ?? 8, source.info.duration)
          : await planGallery(transcript.asset, source.info,
          quote => this.media.suggestSubtitles
            ? this.media.suggestSubtitles(source.path, { ...quote, text: transcript.asset.segments!
              .filter(segment => typeof segment.end === 'number' && typeof segment.start === 'number'
                && segment.end > quote.start && segment.start < quote.end).map(segment => segment.text).join('') }, input)
            : this.media.suggestSubtitle!(source.path, quote, input), input);
        const plan = { id: randomUUID(), previewHashes: [] as string[], transcriptHash: transcript.hash, sourceFingerprint: source.fingerprint, ...proposal };
        const dir = path.join(await this.outputRoot(), current.id, `plan-${plan.id}`);
        await mkdir(dir, { recursive: true });
        try {
          if (!(await realpath(dir)).startsWith((await this.outputRoot()) + path.sep)) throw new GalleryError(422, '方案目录不安全');
          for (const [i, image] of plan.images.entries()) {
            if (current.mode !== 'translated' && this.media.suggestMainCrop) image.image.mainCrop = await this.media.suggestMainCrop(source.path, image.image);
            const file = path.join(dir, `${i}.png`);
            await this.media.render(source.path, image.image, file);
            plan.previewHashes.push(hash(await readFile(file)));
          }
          let copy: Partial<Gallery> = {};
          if (!current.description.trim() && this.deps.copyWriter) {
            try { copy = await this.writeCopy(current, source, transcript, plan.images.flatMap(i => i.quotes).filter(q => q.verification === 'ocr').map(q => q.text)); }
            catch (error) { copy = { copyError: error instanceof Error ? error.message : '图文文案生成失败，请单独重试' }; }
          }
          if (await this.sourceFingerprint(current.sourceJobId) !== source.fingerprint) throw new GalleryError(409, '原视频在规划期间发生变化，请重新规划');
          if ((await this.transcript(current.sourceJobId)).hash !== transcript.hash) throw new GalleryError(409, '转录在规划期间发生变化，请重新规划');
          const saved = await this.persist({ ...current, ...copy, plan, version: current.version + 1, updatedAt: new Date().toISOString() });
          if (current.plan) { safeId(current.plan.id); await rm(path.join(await this.outputRoot(), current.id, `plan-${current.plan.id}`), { recursive: true, force: true }).catch(() => undefined); }
          return saved;
        } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
      });
    });
  }

  private async writeCopy(gallery: Gallery, source: { info: GallerySource; fingerprint: string }, transcript: { asset: TranscriptAsset; hash: string }, nativeSubtitles: string[]): Promise<Partial<Gallery>> {
    if (!this.deps.copyWriter) throw new GalleryError(503, '图文文案服务未就绪');
    if (!Array.isArray(transcript.asset.segments) || transcript.asset.segments.some(s => !s || typeof s.text !== 'string')) throw new GalleryError(422, '转录分段格式异常，请重新转录');
    if ([transcript.asset.transcript, transcript.asset.text].some(value => value !== undefined && typeof value !== 'string')) throw new GalleryError(422, '转录全文格式异常，请重新转录');
    const text = transcript.asset.transcript?.trim() || transcript.asset.text?.trim() || transcript.asset.segments.map(s => s.text).join('\n');
    const issues = inspectTranscriptQuality({ segments: transcript.asset.segments, text, duration: source.info.duration });
    if (issues.length) throw new GalleryError(422, `转录存在异常，请先重新转录：${issues.join('；')}`);
    if (gallery.mode === 'translated') await this.checkedTranslation(gallery);
    const copyText = gallery.mode === 'translated' ? gallery.translation!.cues.map(c => `[${c.start}～${c.end}s] ${c.original}\n中文译文：${c.text}`).join('\n') : text;
    const result = await this.deps.copyWriter.write({ transcript: copyText, nativeSubtitles });
    const violations = validateNoteCopy('douyin', result);
    if (!result.description.trim() || violations.length) throw new GalleryError(422, violations[0]?.message ?? 'AI 正文为空');
    if ((await this.transcript(gallery.sourceJobId)).hash !== transcript.hash) throw new GalleryError(409, '转录在文案生成期间发生变化，请重新生成');
    if (await this.sourceFingerprint(gallery.sourceJobId) !== source.fingerprint) throw new GalleryError(409, '原视频在文案生成期间发生变化，请重新生成');
    return { title: result.title, description: result.description, hashtags: result.hashtags, copyError: undefined,
      copyReference: { transcriptHash: transcript.hash, sourceFingerprint: source.fingerprint, ...(gallery.translation ? { translationHash: hash(JSON.stringify(gallery.translation.cues)) } : {}), notes: result.notes } };
  }

  async generateCopy(id: string, version: number): Promise<Gallery> {
    return this.serial(async () => {
      const current = await this.record(id); this.editable(current, version);
      return this.withSource(current.sourceJobId, async source => {
        const transcript = await this.transcript(current.sourceJobId);
        const nativeSubtitles = current.plan?.transcriptHash === transcript.hash && current.plan.sourceFingerprint === source.fingerprint
          ? current.plan.images.flatMap(i => i.quotes).filter(q => q.verification === 'ocr').map(q => q.text) : [];
        const copy = await this.writeCopy(current, source, transcript, nativeSubtitles);
        return this.persist({ ...current, ...copy, version: current.version + 1, updatedAt: new Date().toISOString() });
      });
    });
  }

  private async checkedCopy(gallery: Gallery): Promise<void> {
    if (!gallery.copyReference) return;
    if ((gallery.copyReference.translationHash && gallery.copyReference.translationHash !== hash(JSON.stringify(gallery.translation?.cues)))
      || gallery.copyReference.transcriptHash !== (await this.transcript(gallery.sourceJobId)).hash
      || gallery.copyReference.sourceFingerprint !== await this.sourceFingerprint(gallery.sourceJobId)) {
      throw new GalleryError(409, '图文文案依据的译文、转录或来源已变化，请重新生成文案');
    }
  }

  private async checkedPlan(gallery: Gallery, planId: string): Promise<void> {
    if (!gallery.plan || typeof planId !== 'string' || gallery.plan.id !== planId) throw new GalleryError(409, '图集方案已变化，请重新规划');
    if ((await this.transcript(gallery.sourceJobId)).hash !== gallery.plan.transcriptHash) throw new GalleryError(409, '转录已变化，请重新规划');
    if (await this.sourceFingerprint(gallery.sourceJobId) !== gallery.plan.sourceFingerprint) throw new GalleryError(409, '原视频已变化，请重新规划');
  }

  async planImage(id: string, index: number, planId: string, version: number): Promise<Buffer> {
    return this.serial(async () => {
      const g = await this.record(id);
      if (!Number.isInteger(version) || g.version !== version) throw new GalleryError(409, '图集版本已变化，请刷新后重试');
      await this.checkedPlan(g, planId);
      if (!Number.isInteger(index) || index < 0 || index >= g.plan!.images.length) throw new GalleryError(404, '方案图片不存在');
      safeId(planId);
      return this.readPlanImage(g, index);

    });
  }

  private async readPlanImage(gallery: Gallery, index: number): Promise<Buffer> {
    const root = await this.outputRoot();
    safeId(gallery.plan!.id);
    try {
      const file = await realpath(path.join(root, gallery.id, `plan-${gallery.plan!.id}`, `${index}.png`));
      if (!file.startsWith(root + path.sep)) throw new Error('outside root');
      const bytes = await readFile(file);
      if (!bytes.length || bytes.length > 20 * 1024 * 1024 || hash(bytes) !== gallery.plan!.previewHashes?.[index]) throw new Error('hash mismatch');
      return bytes;
    } catch { throw new GalleryError(422, '方案预览丢失或被修改，请重新规划'); }
  }

  async renderPlan(id: string, input: { version: number; planId: string; subtitlesConfirmed: boolean }): Promise<Gallery> {
    if (typeof input?.planId !== 'string' || !input.planId) throw new GalleryError(422, '请选择有效图集方案');
    if (input?.subtitlesConfirmed !== true) throw new GalleryError(422, '请先逐张核对整套字幕预览');
    return this.renderInternal(id, input.version, input.planId);
  }

  async render(id: string, version: number): Promise<Gallery> { return this.renderInternal(id, version); }

  private async renderInternal(id: string, version: number, planId?: string): Promise<Gallery> {
    let generationDir = '';
    let previousImages: Gallery['images'] | undefined;
    const current = await this.serial(async () => {
      let g = await this.record(id); this.editable(g, version);
      if (g.mode === 'translated') {
        await this.checkedTranslation(g);
        if (!planId && !g.appliedPlanId) throw new GalleryError(422, '请先核对译文方案后生成');
      }
      if (planId !== undefined) {
        await this.checkedPlan(g, planId);
        if (!g.plan!.images.length) throw new GalleryError(422, '没有可用原生字幕候选，请重新规划');
        for (let i = 0; i < g.plan!.images.length; i++) await this.readPlanImage(g, i);
        previousImages = g.images;
        g = { ...g, images: g.plan!.images.map(i => i.image), appliedPlanId: planId };
      }
      if (g.appliedPlanId) {
        await this.checkedPlan(g, g.appliedPlanId);
        const blockedReason = galleryPlanBlockReason(g.plan!);
        if (blockedReason) throw new GalleryError(422, blockedReason);
        if (imageHash(g) !== imageHash({ ...g, images: g.plan!.images.map(i => i.image) })) throw new GalleryError(409, '请重新确认整套方案后生成');
      }
      if (this.rendering) throw new GalleryError(409, '其它图集生成中，请稍后重试');
      await this.withSource(g.sourceJobId, async source => { this.normalize(g, source.info.duration, g.mode === 'translated'); });
      this.rendering = true;
      try { return await this.persist({ ...g, status: 'running', error: undefined, version: g.version + 1 }); }
      catch (error) { this.rendering = false; throw error; }
    });
    try {
      return await this.withSource(current.sourceJobId, async source => {
      if (current.appliedPlanId) {
        await this.checkedPlan(current, current.appliedPlanId);
        if (source.fingerprint !== current.plan!.sourceFingerprint) throw new GalleryError(409, '原视频已变化，请重新规划');
      }
      const generation = randomUUID();
      generationDir = path.join(await this.outputRoot(), current.id, generation);
      await mkdir(generationDir, { recursive: true });
      if (!(await realpath(generationDir)).startsWith((await this.outputRoot()) + path.sep)) throw new GalleryError(422, '图集目录不安全');
      const hashes: string[] = [];
      for (const [i, image] of current.images.entries()) {
        const file = path.join(generationDir, `${i}.png`);
        await this.media.render(source.path, image, file);
        const renderedHash = hash(await readFile(file));
        if (current.appliedPlanId && renderedHash !== current.plan!.previewHashes?.[i]) throw new GalleryError(409, '生成图片与已确认的方案预览不一致，请重新规划');
        hashes.push(renderedHash);
      }
      if (await this.sourceFingerprint(current.sourceJobId) !== source.fingerprint) throw new GalleryError(409, '原视频在生成期间发生变化，请重新生成');
      const ready = await this.serial(async () => {
        if (current.appliedPlanId) await this.checkedPlan(current, current.appliedPlanId);
        return this.persist({ ...current, status: 'ready', version: current.version + 1,
          generated: { id: generation, draftHash: imageHash(current), sourceFingerprint: source.fingerprint, hashes,
            ...(current.appliedPlanId ? { transcriptHash: current.plan!.transcriptHash } : {}) }, updatedAt: new Date().toISOString() });
      });
      if (current.generated) await rm(path.join(await this.outputRoot(), current.id, current.generated.id), { recursive: true, force: true }).catch(() => undefined);
      return ready;
      });
    } catch (error) {
      await this.serial(() => this.persist({ ...current, ...(previousImages ? { images: previousImages } : {}), status: 'failed', version: current.version + 1, error: error instanceof Error ? error.message : '图集生成失败' }));
      if (generationDir) await rm(generationDir, { recursive: true, force: true });
      throw error;
    } finally { this.rendering = false; }
  }

  private async readImage(g: Gallery, index: number): Promise<{ bytes: Buffer; file: string }> {
    if (!Number.isInteger(index) || index < 0 || !g.generated || index >= g.generated.hashes.length) throw new GalleryError(404, '图片不存在');
    safeId(g.generated.id);
    const root = await this.outputRoot();
    const file = path.join(root, g.id, g.generated.id, `${index}.png`);
    try {
      const canonical = await realpath(file);
      if (!canonical.startsWith(root + path.sep)) throw new Error('outside root');
      const bytes = await readFile(canonical);
      if (!bytes.length || bytes.length > 20 * 1024 * 1024 || hash(bytes) !== g.generated.hashes[index]) throw new Error('hash mismatch');
      return { file: canonical, bytes };
    } catch { throw new GalleryError(422, '图集图片丢失或被修改，请重新生成'); }
  }

  async image(id: string, index: number, generation?: string): Promise<Buffer> {
    const g = await this.get(id);
    if (generation !== undefined && generation !== g.generated?.id) throw new GalleryError(409, '图集图片版本已变化，请刷新');
    return (await this.readImage(g, index)).bytes;
  }

  private async checked(g: Gallery): Promise<{ preview: GalleryPreview; paths: string[] }> {
    if (g.mode === 'translated') await this.checkedTranslation(g);
    await this.checkedCopy(g);
    if (g.status !== 'ready' || !g.generated || g.generated.draftHash !== imageHash(g)) throw new GalleryError(409, '请先保存并重新生成整套图集');
    if (g.generated.transcriptHash && g.generated.transcriptHash !== (await this.transcript(g.sourceJobId)).hash) throw new GalleryError(409, '转录已变化，请重新规划并生成图集');
    if (g.generated.sourceFingerprint !== await this.sourceFingerprint(g.sourceJobId)) throw new GalleryError(409, '原视频已变化，请重新生成图集');
    const paths: string[] = [];
    for (let i = 0; i < g.images.length; i++) paths.push((await this.readImage(g, i)).file);
    const policy = PUBLISH_NOTE_POLICIES.douyin!;
    const copy = { title: g.title, description: g.description, hashtags: g.hashtags };
    return { paths, preview: { previewRevision: hash(JSON.stringify([g.id, g.version, g.generated, copy, 'douyin'])), imageCount: paths.length,
      violations: validateNoteCopy('douyin', copy), copyLimits: { titleMax: policy.titleMax, descriptionMax: policy.descriptionMax, hashtagMax: policy.hashtagMax } } };
  }

  async preview(id: string, version: number): Promise<GalleryPreview> {
    return this.serial(async () => { const g = await this.record(id); this.editable(g, version); return (await this.checked(g)).preview; });
  }

  async createPackage(id: string, revision: string, rightsConfirmed: boolean, actor: ActorSnapshot): Promise<PublishingPackageDetail> {
    return this.serial(async () => {
      const g = await this.record(id);
      if (rightsConfirmed !== true) throw new GalleryError(422, '请先核对图集字幕并确认素材发布使用权');
      const { preview, paths } = await this.checked(g);
      if (typeof revision !== 'string' || revision !== preview.previewRevision) throw new GalleryError(409, '图集预览版本已变化，请重新预览');
      if (preview.violations.length) throw new GalleryError(422, preview.violations[0]!.message);
      if (!this.deps.createPackage) throw new GalleryError(503, '图集发布服务未就绪');
      return this.deps.createPackage(structuredClone(g), paths, actor);
    });
  }
}
