import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { ActorSnapshot, JobRecord, PublishingPackageDetail, TranscriptAsset } from '../types.js';
import { LocalStorage } from './storage.js';
import { resolveSourceVideo } from './video-output.js';
import { GalleryError, GalleryMedia, validateGalleryImage } from './gallery-media.js';
import type { Gallery, GalleryDraft, GalleryPlanInput, GalleryPreview, GallerySource, GalleryTranslation, GalleryContentPlan, GalleryOperationInput, GalleryWorkControl, GalleryOperation } from './gallery-types.js';
import { galleryPlanBlockReason, planGallery } from './gallery-planner.js';
import { PUBLISH_NOTE_POLICIES, validateNoteCopy } from './publishing-platforms.js';
import type { GalleryCopyWriter } from './gallery-copy.js';
import { isYouTubeUrl } from './youtube.js';
import { GalleryTranslator, planTranslatedGallery, validateGalleryTranslationCues } from './gallery-translation.js';
import { inspectTranscriptQuality } from './transcript-quality.js';
import { galleryContentItems, estimateGalleryContent, type GalleryContentPlanner } from './gallery-content.js';
import { normalizeNoteBgm } from './sau-runner.js';

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
  contentPlanner?: Pick<GalleryContentPlanner, 'plan'>;
};

export class GalleryService {
  private readonly media: Pick<GalleryMedia, 'probe' | 'frame' | 'render'> & Partial<Pick<GalleryMedia, 'suggestSubtitle' | 'suggestSubtitles' | 'suggestMainCrop'>>;
  private loaded?: Promise<Record<string, Gallery>>;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly busy = new Set<string>();
  private readonly operations = new Map<string, { id: string; sourceFingerprint: string; resume?: () => void }>();

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
        if (record.operation && ['running', 'pausing', 'paused'].includes(record.operation.status)) {
          record.operation.status = 'interrupted'; record.operation.error = record.operation.recovery ? '应用退出导致任务中断，可继续已保存的处理' : '应用退出导致任务中断，请重新发起';
          record.operation.updatedAt = new Date().toISOString();
          if (record.operation.recovery?.version === record.version) record.operation.recovery.version++;
          record.version++; recovered = true;
        }
        if (record.status === 'running') {
          record.status = 'failed'; record.error = '上次生成被中断，请继续或重新生成';
          if (record.operation?.recovery?.version === record.version) record.operation.recovery.version++;
          record.version++; recovered = true;
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

  private editable(record: Gallery, version: number, owned = false): void {
    if (!owned && (record.status === 'running' || this.busy.has(record.id))) throw new GalleryError(409, '图集生成中，请等待完成');
    if (!Number.isInteger(version) || record.version !== version) throw new GalleryError(409, '图集版本已变化，请刷新后重试');
  }

  private async exclusive<T>(id: string, version: number, work: (gallery: Gallery) => Promise<T>): Promise<T> {
    const gallery = await this.serial(async () => {
      const current = await this.record(id); this.editable(current, version);
      this.busy.add(id); return structuredClone(current);
    });
    try { return await work(gallery); }
    finally { this.busy.delete(id); }
  }

  private commit(gallery: Gallery, finished = false): Promise<Gallery> {
    return this.serial(async () => {
      const current = await this.record(gallery.id);
      const operation = current.operation;
      const recovery = operation?.recovery;
      return this.persist({ ...gallery, operation: recovery && this.operations.get(gallery.id)?.id === operation.id
        ? { ...operation, recovery: { ...recovery, version: gallery.version, finished } } : operation });
    });
  }

  private imageLimit(count: number): void {
    if (count > 35) throw new GalleryError(422, `预计或实际需要 ${count} 张图片，超过自动生成上限 35 张；请先整理并确认保留内容`, 'gallery_image_limit');
  }

  private async contentSource(current: Gallery, targetLines = 8, fullVideo = true): Promise<GalleryContentPlan> {
    return this.withSource(current.sourceJobId, async source => {
      const transcript = await this.transcript(current.sourceJobId);
      if (current.mode === 'translated') {
        await this.checkedTranslation(current);
        if (fullVideo && (current.translation!.start !== 0 || current.translation!.end < source.info.duration - .001)) throw new GalleryError(422, '请先全文翻译，再选择图集内容');
      }
      const items = galleryContentItems(transcript.asset, source.info, current.mode === 'translated' ? current.translation : undefined);
      return { id: randomUUID(), transcriptHash: transcript.hash, sourceFingerprint: source.fingerprint, targetLines, items,
        estimatedImages: estimateGalleryContent(items, targetLines, source.info, current.mode === 'translated'), method: 'manual', createdAt: new Date().toISOString() };
    });
  }

  private async checkedContent(gallery: Gallery, contentPlanId: string): Promise<GalleryContentPlan> {
    const content = gallery.contentPlan;
    if (!content || content.id !== contentPlanId) throw new GalleryError(409, '文字内容方案已变化，请重新确认');
    if ((await this.transcript(gallery.sourceJobId)).hash !== content.transcriptHash
      || await this.sourceFingerprint(gallery.sourceJobId) !== content.sourceFingerprint) throw new GalleryError(409, '文字依据的转录或来源已变化，请重新规划');
    if (gallery.mode === 'translated') {
      await this.checkedTranslation(gallery);
      if (JSON.stringify(gallery.translation!.cues.map(cue => [cue.segmentIndex, cue.original, cue.text, cue.start, cue.end]))
        !== JSON.stringify(content.items.map(item => [item.segmentIndex, item.originalText, item.text, item.start, item.end]))) throw new GalleryError(409, '译文已变化，请重新规划文字');
    }
    return content;
  }

  async prepareContent(id: string, input: { version: number; targetLines?: number; fullVideo?: boolean }): Promise<Gallery> {
    return this.exclusive(id, input?.version, async current => {
      if (input.fullVideo !== undefined && typeof input.fullVideo !== 'boolean') throw new GalleryError(422, '视频范围选择无效');
      const contentPlan = await this.contentSource(current, input.targetLines ?? 8, input.fullVideo !== false);
      return this.commit({ ...current, contentPlan, plan: undefined, appliedPlanId: undefined, version: current.version + 1, updatedAt: new Date().toISOString() });
    });
  }

  async updateContent(id: string, input: { version: number; contentPlanId: string; selectedIds: string[] }): Promise<Gallery> {
    return this.exclusive(id, input?.version, async current => {
      const content = await this.checkedContent(current, input.contentPlanId);
      if (!Array.isArray(input.selectedIds) || !input.selectedIds.length || new Set(input.selectedIds).size !== input.selectedIds.length
        || input.selectedIds.some(id => typeof id !== 'string' || !content.items.some(item => item.id === id))) throw new GalleryError(422, '保留内容编号无效、重复或为空');
      const items = content.items.map(item => ({ ...item, selected: input.selectedIds.includes(item.id) }));
      const info = await this.inspectSource(id);
      const contentPlan = { ...content, items, estimatedImages: estimateGalleryContent(items, content.targetLines, info, current.mode === 'translated'), confirmedAt: new Date().toISOString() };
      return this.commit({ ...current, contentPlan, plan: undefined, appliedPlanId: undefined, version: current.version + 1, updatedAt: new Date().toISOString() });
    });
  }

  async startOperation(id: string, input: GalleryOperationInput, actorId?: string): Promise<Gallery> {
    let previousOperation: string | undefined;
    const started = await this.serial(async () => {
      const current = await this.record(id); this.editable(current, input?.version);
      previousOperation = current.operation?.id;
      if (!['content', 'candidates', 'render'].includes(input?.kind)) throw new GalleryError(422, '生成任务类型无效');
      if (input.kind === 'content') {
        await this.checkedContent(current, input.contentPlanId ?? '');
        if (!this.deps.contentPlanner) throw new GalleryError(503, 'AI 内容整理服务未就绪');
      }
      if (input.kind === 'candidates') {
        if (input.contentConfirmed !== true || !input.contentPlanId) throw new GalleryError(422, '请先确认文字内容');
        const content = await this.checkedContent(current, input.contentPlanId);
        if (!content.confirmedAt) throw new GalleryError(422, '请先保存并确认文字内容');
        if (input.targetLines !== undefined && input.targetLines !== content.targetLines) throw new GalleryError(409, '目标条数已变化，请重新确认文字');
        this.imageLimit(content.estimatedImages);
      }
      if (input.kind === 'render') {
        if (input.planId !== undefined) {
          if (input.subtitlesConfirmed !== true) throw new GalleryError(422, '请先核对整套字幕候选');
          await this.checkedPlan(current, input.planId);
          this.imageLimit(current.plan!.images.length);
          const reason = galleryPlanBlockReason(current.plan!); if (reason) throw new GalleryError(422, reason);
        } else this.imageLimit(current.images.length);
      }
      const now = new Date().toISOString();
      const total = input.kind === 'content' ? current.contentPlan!.items.length
        : input.kind === 'candidates' ? current.contentPlan!.items.filter(item => item.selected).length
        : input.planId ? current.plan!.images.length : current.images.length;
      const operation: GalleryOperation = { id: randomUUID(), actorId, kind: input.kind, status: 'running',
        stage: input.kind === 'candidates' ? 'ocr' : input.kind, completed: 0, total, startedAt: now, updatedAt: now };
      const sourceFingerprint = await this.sourceFingerprint(current.sourceJobId);
      operation.recovery = { input: structuredClone(input), version: current.version, sourceFingerprint,
        ...(input.kind !== 'render' || input.planId || current.appliedPlanId ? { transcriptHash: (await this.transcript(current.sourceJobId)).hash } : {}) };
      const saved = await this.persist({ ...current, operation, error: undefined });
      this.busy.add(id); this.operations.set(id, { id: operation.id, sourceFingerprint }); return saved;
    });
    this.launchOperation(started, input);
    if (previousOperation) {
      safeId(previousOperation);
      await rm(path.join(await this.outputRoot(), id, `operation-${previousOperation}`), { recursive: true, force: true }).catch(() => undefined);
    }
    return started;
  }

  private launchOperation(started: Gallery, input: GalleryOperationInput): void {
    const id = started.id;
    void this.executeOperation(started, input).finally(async () => {
      this.operations.delete(id); this.busy.delete(id);
      if ((await this.record(id)).operation?.status === 'completed') {
        await rm(path.join(await this.outputRoot(), id, `operation-${started.operation!.id}`), { recursive: true, force: true });
      }
    }).catch(error => console.error('[gallery operation]', error));
  }

  private async operationPatch(id: string, operationId: string, patch: Partial<GalleryOperation>): Promise<Gallery> {
    return this.serial(async () => {
      const current = await this.record(id);
      if (current.operation?.id !== operationId) throw new GalleryError(409, '生成任务已变化');
      if (patch.status === 'pausing' && current.operation.status !== 'running') throw new GalleryError(409, '任务已结束或暂停状态已变化');
      if (patch.status === 'running' && current.operation.status !== 'paused') throw new GalleryError(409, '任务暂停状态已变化');
      return this.persist({ ...current, operation: { ...current.operation, ...patch, updatedAt: new Date().toISOString() } });
    });
  }

  private operationControl(id: string, operationId: string, stage: GalleryOperation['stage']): GalleryWorkControl {
    return {
      unit: (key, work) => this.operationUnit(id, operationId, `${stage}:${key}`, work),
      checkpoint: async () => {
        const running = this.operations.get(id);
        if (running?.id !== operationId) throw new GalleryError(409, '生成任务已变化');
        const current = await this.record(id);
        if (current.operation?.status === 'pausing') {
          const gate = new Promise<void>(resolve => { running.resume = resolve; });
          await this.operationPatch(id, operationId, { status: 'paused' });
          await gate;
          const latest = await this.record(id);
          if (await this.sourceFingerprint(latest.sourceJobId) !== running.sourceFingerprint) throw new GalleryError(409, '原视频来源在暂停期间已变化，请重新生成');
          if (latest.operation!.kind === 'render') {
            if (latest.appliedPlanId) await this.checkedPlan(latest, latest.appliedPlanId);
          }
          else await this.checkedContent(latest, latest.contentPlan?.id ?? '');
        }
      },
      progress: async (completed, total) => { await this.operationPatch(id, operationId, { stage, completed, total }); },
    };
  }

  private async operationDirectory(id: string, operationId: string): Promise<string> {
    safeId(id); safeId(operationId);
    const root = await this.outputRoot();
    const dir = path.join(root, id, `operation-${operationId}`);
    await mkdir(dir, { recursive: true });
    if (!(await realpath(dir)).startsWith(root + path.sep)) throw new GalleryError(422, '恢复目录不安全');
    return dir;
  }

  private async operationUnit<T>(id: string, operationId: string, key: string, work: () => Promise<T>): Promise<T> {
    const dir = await this.operationDirectory(id, operationId);
    const file = path.join(dir, `${hash(key)}.json`);
    try {
      const canonical = await realpath(file);
      if (!canonical.startsWith(dir + path.sep)) throw new GalleryError(422, '恢复结果路径不安全');
      const saved = JSON.parse(await readFile(canonical, 'utf8'));
      if (!saved || saved.hash !== hash(JSON.stringify({ value: saved.value }))) throw new GalleryError(422, '已保存的处理结果损坏，请重新发起');
      return saved.value as T;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = await work();
    await this.deps.storage.writeJsonAtomic(path.join('output/galleries', id, `operation-${operationId}`, path.basename(file)), { value, hash: hash(JSON.stringify({ value })) });
    return value;
  }

  private async renderOperationImage(gallery: Gallery, control: GalleryWorkControl, video: string, image: Gallery['images'][number], file: string, index: number): Promise<void> {
    if (!control.unit || !gallery.operation) { await this.media.render(video, image, file); return; }
    const key = `image:${index}:${JSON.stringify(image)}`;
    const dir = await this.operationDirectory(gallery.id, gallery.operation.id);
    const cached = path.join(dir, `${hash(key)}.png`);
    const expected = await control.unit(key, async () => {
      await rm(cached, { force: true });
      await this.media.render(video, image, cached);
      return hash(await readFile(cached));
    });
    const canonical = await realpath(cached);
    if (!canonical.startsWith(dir + path.sep)) throw new GalleryError(422, '恢复图片路径不安全');
    const bytes = await readFile(canonical);
    if (hash(bytes) !== expected) throw new GalleryError(422, '已保存的图片损坏，请重新发起');
    await writeFile(file, bytes);
  }

  private async executeOperation(started: Gallery, input: GalleryOperationInput): Promise<void> {
    const operationId = started.operation!.id;
    try {
      if (started.operation!.recovery?.finished) {
        await this.operationPatch(started.id, operationId, { status: 'completed', error: undefined }); return;
      }
      if (input.kind === 'content') {
        const content = started.contentPlan!;
        const control = this.operationControl(started.id, operationId, 'content');
        const items = await this.deps.contentPlanner!.plan(content.items, control);
        await control.checkpoint?.();
        await this.checkedContent(started, content.id);
        const source = await this.inspectSource(started.id);
        await this.commit({ ...started, contentPlan: { ...content, items, method: 'ai', confirmedAt: undefined, estimatedImages: estimateGalleryContent(items, content.targetLines, source, started.mode === 'translated') }, plan: undefined, appliedPlanId: undefined, version: started.version + 1 }, true);
      } else if (input.kind === 'candidates') {
        await this.planWork(started, { ...input, targetLines: started.contentPlan!.targetLines }, this.operationControl(started.id, operationId, 'ocr'), this.operationControl(started.id, operationId, 'candidates'), this.operationControl(started.id, operationId, 'copy'));
      } else {
        await this.renderInternal(started.id, started.version, input.planId, this.operationControl(started.id, operationId, 'render'), true);
      }
      await this.operationControl(started.id, operationId, input.kind === 'candidates' ? 'candidates' : input.kind).checkpoint?.();
      const current = await this.record(started.id);
      await this.operationPatch(started.id, operationId, { status: 'completed', completed: current.operation!.total });
    } catch (error) {
      await this.operationPatch(started.id, operationId, { status: 'failed', error: error instanceof Error ? error.message : '图集生成失败' });
    }
  }

  private async controlOperation(id: string, operationId: string, actorId?: string): Promise<Gallery> {
    const current = await this.record(id);
    if (typeof operationId !== 'string' || current.operation?.id !== operationId) throw new GalleryError(409, '生成任务不存在、已中断或已变化');
    if (current.operation.actorId !== actorId) throw new GalleryError(403, '只有发起任务的操作者可以控制任务');
    return current;
  }

  async pauseOperation(id: string, operationId: string, actorId?: string): Promise<Gallery> {
    const current = await this.controlOperation(id, operationId, actorId);
    if (!['running', 'pausing', 'paused'].includes(current.operation!.status)) throw new GalleryError(409, '任务已经结束');
    if (current.operation!.status !== 'running') return structuredClone(current);
    return this.operationPatch(id, operationId, { status: 'pausing' });
  }

  async resumeOperation(id: string, operationId: string, actorId?: string): Promise<Gallery> {
    const current = await this.controlOperation(id, operationId, actorId);
    if (current.operation!.status === 'interrupted') {
      const started = await this.serial(async () => {
        const latest = await this.controlOperation(id, operationId, actorId);
        const recovery = latest.operation!.recovery;
        if (latest.operation!.status !== 'interrupted' || !recovery || this.busy.has(id)) throw new GalleryError(409, '中断任务缺少恢复记录或正在处理，请重新发起');
        if (recovery.version !== latest.version) throw new GalleryError(409, '图集版本或确认内容已变化，请重新发起');
        if (await this.sourceFingerprint(latest.sourceJobId) !== recovery.sourceFingerprint
          || (recovery.transcriptHash && (await this.transcript(latest.sourceJobId)).hash !== recovery.transcriptHash)) throw new GalleryError(409, '原视频来源或转录已变化，请重新规划');
        if (!recovery.finished) {
          if (recovery.input.kind === 'render') {
            if (recovery.input.planId) {
              if (recovery.input.subtitlesConfirmed !== true) throw new GalleryError(409, '字幕确认记录缺失，请重新确认');
              await this.checkedPlan(latest, recovery.input.planId);
            }
          } else {
            const content = await this.checkedContent(latest, recovery.input.contentPlanId ?? '');
            if (recovery.input.kind === 'candidates' && (!content.confirmedAt || recovery.input.contentConfirmed !== true)) throw new GalleryError(409, '文字确认记录缺失，请重新确认');
          }
        }
        const saved = await this.persist({ ...latest, operation: { ...latest.operation!, status: 'running', error: undefined, updatedAt: new Date().toISOString() } });
        this.busy.add(id); this.operations.set(id, { id: operationId, sourceFingerprint: recovery.sourceFingerprint });
        return saved;
      });
      this.launchOperation(started, { ...started.operation!.recovery!.input, version: started.version });
      return started;
    }
    if (this.operations.get(id)?.id !== operationId) throw new GalleryError(409, '生成任务已中断，请重新发起');
    if (current.operation!.status !== 'paused') throw new GalleryError(409, '任务尚未暂停或已经结束');
    const saved = await this.operationPatch(id, operationId, { status: 'running' });
    const running = this.operations.get(id)!; const resume = running.resume; running.resume = undefined; resume?.(); return saved;
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
      || !Array.isArray(input.images) || input.images.length < 1) {
      throw new GalleryError(422, '标题、文案或图片数量不合法（图集至少需 1 张）');
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
    let bgm: string;
    try { bgm = normalizeNoteBgm(input.bgm); }
    catch (error) { throw new GalleryError(422, error instanceof Error ? error.message : '配乐名称不合法'); }
    return { title: input.title.trim(), description: input.description, hashtags: input.hashtags.map(t => t.trim().replace(/^#+/, '')).filter(Boolean), bgm: bgm || undefined, images };
  }

  async list(): Promise<Gallery[]> {
    // Read committed snapshots without waiting for OCR or translation; writes remain serialized.
    return structuredClone(Object.values(await this.index()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async get(id: string): Promise<Gallery> {
    const gallery = structuredClone(await this.record(id));
    if (gallery.plan) gallery.plan.blockedReason = galleryPlanBlockReason(gallery.plan)
      || (gallery.mode === 'translated' && !gallery.plan.scope ? '旧方案缺少完整视频范围校验，请重新自动创作；原图保留供参考。' : undefined);
    if (gallery.translation) {
      try { await this.checkedTranslation(gallery); }
      catch { gallery.error = '译文依据的转录或来源已变化，请重新翻译。'; }
    }
    if (gallery.copyReference) {
      try { await this.checkedCopy(gallery); }
      catch { gallery.copyError = '文案依据的转录或来源已变化，请重新生成图文文案并核对。'; }
    }
    return gallery;
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
        contentPlan: sameImages ? current.contentPlan : undefined,
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
    return this.withSource(gallery.sourceJobId, async source => ({ ...source.info,
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
    const transcript = await this.transcript(gallery.sourceJobId);
    if (gallery.translation.transcriptHash !== transcript.hash
      || gallery.translation.sourceFingerprint !== await this.sourceFingerprint(gallery.sourceJobId)) {
      throw new GalleryError(409, '转录或原视频已变化，请重新翻译');
    }
    validateGalleryTranslationCues(gallery.translation.cues);
    const expected = transcript.asset.segments?.flatMap((s, segmentIndex) => s.end! > gallery.translation!.start
      && s.start! < gallery.translation!.end && s.text.trim() ? [{ segmentIndex, original: s.text, start: s.start }] : []);
    const actual = gallery.translation.cues.map(({ segmentIndex, original, start }) => ({ segmentIndex, original, start }));
    if (!expected || JSON.stringify(actual) !== JSON.stringify(expected)) throw new GalleryError(409, '译文存在遗漏或与原文不一致，请重新全文翻译');
  }

  async translate(id: string, input: { version: number; start: number; end: number }): Promise<Gallery> {
    return this.exclusive(id, input?.version, async current => {
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
        validateGalleryTranslationCues(cues, false, source.info.duration);
        const translated = await this.deps.translator!.translate(cues);
        validateGalleryTranslationCues(translated, true, source.info.duration);
        if (JSON.stringify(translated.map(({text: _text,...cue})=>cue)) !== JSON.stringify(cues.map(({text: _text,...cue})=>cue))) throw new GalleryError(422, '翻译结果原文或时间不一致，请重试');
        if ((await this.transcript(current.sourceJobId)).hash !== transcript.hash
          || await this.sourceFingerprint(current.sourceJobId) !== source.fingerprint) throw new GalleryError(409, '翻译期间来源已变化，请重新翻译');
        const saved = await this.commit({ ...current, contentPlan: undefined, translation: { start: input.start, end: input.end, cues: translated,
          transcriptHash: transcript.hash, sourceFingerprint: source.fingerprint }, plan: undefined, appliedPlanId: undefined,
          status: 'draft', error: undefined, version: current.version + 1, updatedAt: new Date().toISOString() });
        if (current.plan) { safeId(current.plan.id); await rm(path.join(await this.outputRoot(), current.id, `plan-${current.plan.id}`), {recursive:true,force:true}).catch(()=>undefined); }
        return saved;
      });
    });
  }

  async plan(id: string, input: GalleryPlanInput): Promise<Gallery> {
    return this.exclusive(id, input?.version, current => this.planWork(current, input));
  }

  private async planWork(current: Gallery, input: GalleryPlanInput, ocrControl: GalleryWorkControl = {}, imageControl: GalleryWorkControl = {}, copyControl: GalleryWorkControl = imageControl): Promise<Gallery> {
    if (input.fullVideo !== undefined && typeof input.fullVideo !== 'boolean') throw new GalleryError(422, '视频范围选择无效');
    if (current.mode !== 'translated' && !this.media.suggestSubtitle && !this.media.suggestSubtitles) throw new GalleryError(503, '字幕候选检测未就绪');
    return this.withSource(current.sourceJobId, async source => {
      const transcript = await this.transcript(current.sourceJobId);
      let content: GalleryContentPlan | undefined;
      if (input.contentPlanId !== undefined) {
        if (input.contentConfirmed !== true) throw new GalleryError(422, '请先确认文字内容');
        content = await this.checkedContent(current, input.contentPlanId);
        if (!content.confirmedAt || content.targetLines !== (input.targetLines ?? 8)) throw new GalleryError(409, '文字选择或目标条数未确认，请重新确认');
      }
      if (current.mode === 'translated') {
        await this.checkedTranslation(current);
        if (input.fullVideo !== false && (current.translation!.start !== 0 || current.translation!.end < source.info.duration - .001)) throw new GalleryError(422, '当前译文未覆盖完整视频，请先全文翻译再自动分图；指定片段须明确选择片段模式。');
      }
      const items = content?.items ?? galleryContentItems(transcript.asset, source.info, current.mode === 'translated' ? current.translation : undefined);
      const selected = items.filter(item => item.selected);
      if (!selected.length) throw new GalleryError(422, '请选择至少一条文字内容');
      this.imageLimit(estimateGalleryContent(items, input.targetLines ?? 8, source.info, current.mode === 'translated'));
      await ocrControl.progress?.(0, selected.length);
      await ocrControl.checkpoint?.();
      const proposal = current.mode === 'translated'
        ? planTranslatedGallery({ ...current.translation!, cues: current.translation!.cues.filter(cue => selected.some(item => item.segmentIndex === cue.segmentIndex)) }, input.targetLines ?? 8, source.info.duration)
        : await planGallery(transcript.asset, source.info,
          quote => {
            const segments = transcript.asset.segments!;
            const overlapping = segments.filter(segment => typeof segment.end === 'number' && typeof segment.start === 'number'
              && segment.end > quote.start && segment.start < quote.end);
            const adjacent = segments.slice(Math.max(0, segments.indexOf(overlapping[0]!) - 1), segments.indexOf(overlapping.at(-1)!) + 2)
              .filter(segment => segment.end! > quote.start - 4 && segment.start! < quote.end + 4);
            const context = { ...quote, text: overlapping.map(segment => segment.text).join(''), targetText: quote.text, adjacentText: adjacent.map(segment => segment.text).join('') };
            const detect = async () => this.media.suggestSubtitles
              ? this.media.suggestSubtitles(source.path, context, input, ocrControl)
              : this.media.suggestSubtitle!(source.path, context, input);
            return ocrControl.unit ? ocrControl.unit(JSON.stringify(quote), detect) : detect();
          }, input, { ...ocrControl, quotes: selected });
      this.imageLimit(proposal.images.length);
      const segments = transcript.asset.segments!.filter(segment => segment.text.trim());
      const quotes = proposal.images.flatMap(image => image.quotes);
      const scope = content && selected.length < items.length ? 'selection' as const : current.mode === 'translated' && input.fullVideo === false ? 'range' as const : 'full' as const;
      const coverage = { start: scope === 'selection' ? Math.min(...selected.map(q => q.start)) : current.mode === 'translated' ? current.translation!.start : 0,
        end: scope === 'selection' ? Math.max(...selected.map(q => q.end)) : current.mode === 'translated' ? current.translation!.end : source.info.duration, duration: source.info.duration,
        totalSegments: content ? new Set(selected.map(item => item.segmentIndex)).size : segments.length,
        selectedSegments: new Set(quotes.map(q => q.segmentIndex)).size };
      const planId = imageControl.unit ? await imageControl.unit('plan-id', async () => randomUUID()) : randomUUID();
      const plan = { id: planId, previewHashes: [] as string[], transcriptHash: transcript.hash, sourceFingerprint: source.fingerprint, ...proposal, scope, coverage };
      const dir = path.join(await this.outputRoot(), current.id, `plan-${plan.id}`);
      await mkdir(dir, { recursive: true });
      try {
        if (!(await realpath(dir)).startsWith((await this.outputRoot()) + path.sep)) throw new GalleryError(422, '方案目录不安全');
        await imageControl.progress?.(0, plan.images.length);
        for (const [i, image] of plan.images.entries()) {
          await imageControl.checkpoint?.();
          if (current.mode !== 'translated' && this.media.suggestMainCrop) {
            const crop = () => this.media.suggestMainCrop!(source.path, image.image);
            image.image.mainCrop = imageControl.unit ? await imageControl.unit(`crop:${i}:${JSON.stringify(image.image)}`, crop) : await crop();
          }
          const file = path.join(dir, `${i}.png`);
          await this.renderOperationImage(current, imageControl, source.path, image.image, file, i);
          plan.previewHashes.push(hash(await readFile(file)));
          await imageControl.progress?.(i + 1, plan.images.length);
        }
        let copy: Partial<Gallery> = {};
        if (!current.description.trim() && this.deps.copyWriter) {
          await copyControl.checkpoint?.();
          await copyControl.progress?.(0, 1);
          try {
            const write = () => this.writeCopy(current, source, transcript, quotes.filter(q => q.verification === 'ocr').map(q => q.text));
            copy = copyControl.unit ? await copyControl.unit('copy', write) : await write();
          }
          catch (error) { copy = { copyError: error instanceof Error ? error.message : '图文文案生成失败，请单独重试' }; }
          await copyControl.progress?.(1, 1);
        }
        await imageControl.checkpoint?.();
        if (await this.sourceFingerprint(current.sourceJobId) !== source.fingerprint) throw new GalleryError(409, '原视频在规划期间发生变化，请重新规划');
        if ((await this.transcript(current.sourceJobId)).hash !== transcript.hash) throw new GalleryError(409, '转录在规划期间发生变化，请重新规划');
        const saved = await this.commit({ ...current, ...copy, plan, version: current.version + 1, updatedAt: new Date().toISOString() }, true);
        if (current.plan) { safeId(current.plan.id); await rm(path.join(await this.outputRoot(), current.id, `plan-${current.plan.id}`), { recursive: true, force: true }).catch(() => undefined); }
        return saved;
      } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
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
    return this.exclusive(id, version, async current => {
      return this.withSource(current.sourceJobId, async source => {
        const transcript = await this.transcript(current.sourceJobId);
        const nativeSubtitles = current.plan?.transcriptHash === transcript.hash && current.plan.sourceFingerprint === source.fingerprint
          ? current.plan.images.flatMap(i => i.quotes).filter(q => q.verification === 'ocr').map(q => q.text) : [];
        const copy = await this.writeCopy(current, source, transcript, nativeSubtitles);
        return this.commit({ ...current, ...copy, version: current.version + 1, updatedAt: new Date().toISOString() });
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
    if (gallery.mode === 'translated' && !gallery.plan.scope) throw new GalleryError(409, '旧译文方案缺少完整视频范围校验，请重新自动创作；原图保留。');
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
    return this.exclusive(id, input.version, () => this.renderInternal(id, input.version, input.planId, {}, true));
  }

  async render(id: string, version: number): Promise<Gallery> { return this.exclusive(id, version, () => this.renderInternal(id, version, undefined, {}, true)); }

  private async renderInternal(id: string, version: number, planId?: string, control: GalleryWorkControl = {}, owned = false): Promise<Gallery> {
    let generationDir = '';
    let previousImages: Gallery['images'] | undefined;
    const current = await (async () => {
      let g = await this.record(id); this.editable(g, version, owned);
      if (!planId) this.imageLimit(g.images.length);
      if (g.mode === 'translated') {
        await this.checkedTranslation(g);
        if (!planId && !g.appliedPlanId) throw new GalleryError(422, '请先核对译文方案后生成');
      }
      if (planId !== undefined) {
        await this.checkedPlan(g, planId);
        this.imageLimit(g.plan!.images.length);
        if (!g.plan!.images.length) throw new GalleryError(422, '没有可用原生字幕候选，请重新规划');
        for (let i = 0; i < g.plan!.images.length; i++) await this.readPlanImage(g, i);
        previousImages = g.images;
        g = { ...g, images: g.plan!.images.map(i => i.image), appliedPlanId: planId };
      }
      if (g.appliedPlanId) {
        await this.checkedPlan(g, g.appliedPlanId);
        this.imageLimit(g.plan!.images.length);
        const blockedReason = galleryPlanBlockReason(g.plan!);
        if (blockedReason) throw new GalleryError(422, blockedReason);
        if (imageHash(g) !== imageHash({ ...g, images: g.plan!.images.map(i => i.image) })) throw new GalleryError(409, '请重新确认整套方案后生成');
      }
      await this.withSource(g.sourceJobId, async source => { this.normalize(g, source.info.duration, g.mode === 'translated'); });
      return this.commit({ ...g, status: 'running', error: undefined, version: g.version + 1 });
    })();
    try {
      return await this.withSource(current.sourceJobId, async source => {
      if (current.appliedPlanId) {
        await this.checkedPlan(current, current.appliedPlanId);
        if (source.fingerprint !== current.plan!.sourceFingerprint) throw new GalleryError(409, '原视频已变化，请重新规划');
      }
      const generation = control.unit ? await control.unit('generation', async () => randomUUID()) : randomUUID();
      generationDir = path.join(await this.outputRoot(), current.id, generation);
      await mkdir(generationDir, { recursive: true });
      if (!(await realpath(generationDir)).startsWith((await this.outputRoot()) + path.sep)) throw new GalleryError(422, '图集目录不安全');
      const hashes: string[] = [];
      await control.progress?.(0, current.images.length);
      for (const [i, image] of current.images.entries()) {
        await control.checkpoint?.();
        const file = path.join(generationDir, `${i}.png`);
        await this.renderOperationImage(current, control, source.path, image, file, i);
        const renderedHash = hash(await readFile(file));
        if (current.appliedPlanId && renderedHash !== current.plan!.previewHashes?.[i]) throw new GalleryError(409, '生成图片与已确认的方案预览不一致，请重新规划');
        hashes.push(renderedHash);
        await control.progress?.(i + 1, current.images.length);
      }
      await control.checkpoint?.();
      if (await this.sourceFingerprint(current.sourceJobId) !== source.fingerprint) throw new GalleryError(409, '原视频在生成期间发生变化，请重新生成');
      const ready = await this.serial(async () => {
        if (current.appliedPlanId) await this.checkedPlan(current, current.appliedPlanId);
        const operation = (await this.record(id)).operation;
        return this.persist({ ...current, operation: operation?.recovery && this.operations.get(id)?.id === operation.id
          ? { ...operation, recovery: { ...operation.recovery, version: current.version + 1, finished: true } } : operation, status: 'ready', version: current.version + 1,
          generated: { id: generation, draftHash: imageHash(current), sourceFingerprint: source.fingerprint, hashes,
            ...(current.appliedPlanId ? { transcriptHash: current.plan!.transcriptHash } : {}) }, updatedAt: new Date().toISOString() });
      });
      if (current.generated) await rm(path.join(await this.outputRoot(), current.id, current.generated.id), { recursive: true, force: true }).catch(() => undefined);
      return ready;
      });
    } catch (error) {
      await this.serial(async () => this.persist({ ...current, operation: (await this.record(id)).operation, ...(previousImages ? { images: previousImages } : {}), status: 'failed', version: current.version + 1, error: error instanceof Error ? error.message : '图集生成失败' }));
      if (generationDir) await rm(generationDir, { recursive: true, force: true });
      throw error;
    }
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
    let bgm: string;
    try { bgm = normalizeNoteBgm(g.bgm); }
    catch (error) { throw new GalleryError(422, error instanceof Error ? error.message : '配乐名称不合法'); }
    const revision = [g.id, g.version, g.generated, copy, 'douyin', ...(bgm ? [bgm] : [])];
    return { paths, preview: { previewRevision: hash(JSON.stringify(revision)), ...(bgm ? { bgm } : {}), imageCount: paths.length,
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
