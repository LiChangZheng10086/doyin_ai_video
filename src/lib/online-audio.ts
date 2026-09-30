import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LocalStorage } from './storage.js';
import { AssetStore } from './assets-store.js';
import { runCommand } from './command.js';
import { AUDIO_BOARDS, AUDIO_SOURCES, fetchAudioTracks, resolveAudio, openAudioRemote, validOnlineTrack, OnlineAudioError,
  type AudioBoardId, type AudioSource, type OnlineTrack, type AudioMedia } from './online-audio-sources.js';

export interface AudioBoard {
  source: AudioSource; board: AudioBoardId; items: OnlineTrack[]; status: 'fresh' | 'stale' | 'unavailable';
  fetchedAt?: string; checkedAt?: string; expiresAt?: string; refreshAfter?: string; error?: string;
}
export interface AudioImportItem {
  id: string; track: OnlineTrack; status: 'queued' | 'downloading' | 'succeeded' | 'failed';
  message?: string; assetId?: string; previewOnly?: boolean;
}
export interface AudioImportBatch { id: string; items: AudioImportItem[] }
export interface AudioPreview { token: string; durationMs: number; previewOnly: boolean }
type CachedMedia = AudioPreview & { trackKey: string; directory: string; path: string; extension: AudioMedia['extension']; expires: number };
type Dependencies = {
  now?: () => number; ffprobeBinary?: string; fetchTracks?: typeof fetchAudioTracks;
  resolveMedia?: typeof resolveAudio; openRemote?: typeof openAudioRemote;
  probe?: (filePath: string, extension: AudioMedia['extension']) => Promise<{ durationMs: number }>;
};
const MAX_BYTES = 50 * 1024 * 1024;
const CACHE_MS = 600_000;
const REFRESH_MS = 60_000;
const reason = (error: unknown): string => error instanceof OnlineAudioError ? error.message : '音频获取失败，请检查网络与本地存储后重试';

export class OnlineAudioService {
  private readonly now: () => number;
  private readonly fetchTracks: typeof fetchAudioTracks;
  private readonly resolveMedia: typeof resolveAudio;
  private readonly openRemote: typeof openAudioRemote;
  private readonly probe: NonNullable<Dependencies['probe']>;
  private readonly boards = new Map<string, AudioBoard>();
  private readonly boardPending = new Map<string, Promise<AudioBoard>>();
  private readonly tracks = new Map<string, OnlineTrack>();
  private readonly media = new Map<string, CachedMedia>();
  private readonly mediaPending = new Map<string, Promise<CachedMedia>>();
  private readonly batches = new Map<string, AudioImportBatch & { actor: string; created: number }>();
  private readonly imports = new Map<string, AudioImportItem>();
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private readonly ready: Promise<void>;

  constructor(private storage: LocalStorage, private assets: AssetStore, deps: Dependencies = {}) {
    this.now = deps.now ?? Date.now; this.fetchTracks = deps.fetchTracks ?? fetchAudioTracks;
    this.resolveMedia = deps.resolveMedia ?? resolveAudio; this.openRemote = deps.openRemote ?? openAudioRemote;
    this.probe = deps.probe ?? ((file, extension) => probeAudioFile(file, extension, deps.ffprobeBinary));
    const directory = storage.resolve('cache/online-audio/media');
    this.ready = rm(directory, { recursive: true, force: true }).then(() => mkdir(directory, { recursive: true })).then(() => {});
    // Keep a rejected initialization handled until an operation can report the storage error.
    void this.ready.catch(() => {});
  }
  private source(value: unknown): AudioSource {
    if (value !== 'netease' && value !== 'qq') throw new OnlineAudioError(400, '请选择有效音乐来源');
    return value;
  }
  private remember(items: OnlineTrack[]): void {
    for (const item of items) {
      this.tracks.delete(item.key); this.tracks.set(item.key, item);
    }
    while (this.tracks.size > 1000) this.tracks.delete(this.tracks.keys().next().value!);
  }
  private track(key: unknown): OnlineTrack {
    if (typeof key !== 'string') throw new OnlineAudioError(400, '请选择有效曲目');
    const item = this.tracks.get(key);
    if (!item) throw new OnlineAudioError(404, '曲目已过期，请重新加载榜单或搜索后再操作');
    return item;
  }
  async list(sourceValue: unknown, boardValue: unknown, refresh = false): Promise<AudioBoard> {
    const source = this.source(sourceValue);
    if (!AUDIO_BOARDS.some(item => item.id === boardValue)) throw new OnlineAudioError(400, '请选择有效榜单');
    const board = boardValue as AudioBoardId; const key = `${source}-${board}`;
    const pending = this.boardPending.get(key); if (pending) return pending;
    const operation = this.loadBoard(source, board, key, refresh).finally(() => this.boardPending.delete(key));
    this.boardPending.set(key, operation); return operation;
  }
  private async loadBoard(source: AudioSource, board: AudioBoardId, key: string, refresh: boolean): Promise<AudioBoard> {
    const cacheFile = `cache/online-audio/${key}.json`;
    let snapshot = this.boards.get(key);
    if (!snapshot) {
      try {
        const cached = await this.storage.readJson<AudioBoard>(cacheFile);
        if (cached.source === source && cached.board === board && Array.isArray(cached.items) && cached.items.length <= 100
          && cached.items.every(item => validOnlineTrack(item, source)) && Number.isFinite(Date.parse(cached.fetchedAt ?? ''))
          && Date.parse(cached.fetchedAt!) <= this.now() && Number.isFinite(Date.parse(cached.checkedAt ?? ''))
          && Date.parse(cached.checkedAt!) <= this.now()) snapshot = cached;
      } catch { /* Cache is replaceable; the user's asset index is not. */ }
    }
    snapshot ??= { source, board, items: [], status: 'unavailable' };
    if ((refresh || !snapshot.fetchedAt || this.now() - Date.parse(snapshot.fetchedAt) >= CACHE_MS)
      && (!snapshot.checkedAt || this.now() - Date.parse(snapshot.checkedAt) >= REFRESH_MS)) {
      snapshot = { ...snapshot, checkedAt: new Date(this.now()).toISOString() };
      try {
        const items = await this.fetchTracks(source, { board });
        if (!items.length || items.length > 100 || !items.every(item => validOnlineTrack(item, source))) throw new OnlineAudioError(502, '来源未返回有效曲目');
        snapshot = { source, board, items, fetchedAt: new Date(this.now()).toISOString(), checkedAt: snapshot.checkedAt, status: 'fresh' };
      } catch (error) { snapshot = { ...snapshot, error: reason(error) }; }
      try { await this.storage.writeJsonAtomic(cacheFile, snapshot); }
      catch { snapshot = { ...snapshot, error: '榜单缓存保存失败，本次数据未持久化，请检查存储目录' }; }
    }
    snapshot.status = snapshot.items.length ? snapshot.error || this.now() - Date.parse(snapshot.fetchedAt!) >= CACHE_MS ? 'stale' : 'fresh' : 'unavailable';
    snapshot.expiresAt = snapshot.fetchedAt ? new Date(Date.parse(snapshot.fetchedAt) + CACHE_MS).toISOString() : undefined;
    snapshot.refreshAfter = snapshot.checkedAt ? new Date(Date.parse(snapshot.checkedAt) + REFRESH_MS).toISOString() : undefined;
    this.boards.set(key, snapshot); this.remember(snapshot.items); return structuredClone(snapshot);
  }
  async search(sourceValue: unknown, queryValue: unknown): Promise<OnlineTrack[]> {
    const source = this.source(sourceValue);
    if (typeof queryValue !== 'string' || !queryValue.trim() || queryValue.trim().length > 100) throw new OnlineAudioError(400, '请输入 1～100 字的歌曲或歌手名称');
    const items = await this.fetchTracks(source, { query: queryValue.trim() });
    if (items.length > 100 || !items.every(item => validOnlineTrack(item, source))) throw new OnlineAudioError(502, '来源搜索结果无效');
    this.remember(items); return items;
  }
  async preview(key: unknown): Promise<AudioPreview> {
    const value = await this.prepareMedia(this.track(key));
    return { token: value.token, previewOnly: value.previewOnly, durationMs: value.durationMs };
  }
  async openMedia(token: string): Promise<{ path: string; mimeType: string }> {
    await this.ready;
    const value = this.media.get(token);
    if (!value || value.expires <= this.now()) throw new OnlineAudioError(404, '试听已过期，请重新点击试听');
    return { path: value.path, mimeType: value.extension === 'mp3' ? 'audio/mpeg' : value.extension === 'm4a' ? 'audio/mp4' : 'audio/aac' };
  }
  private async prepareMedia(track: OnlineTrack): Promise<CachedMedia> {
    await this.ready;
    for (const value of this.media.values()) {
      if (value.expires <= this.now()) { this.media.delete(value.token); await rm(value.directory, { recursive: true, force: true }); }
      else if (value.trackKey === track.key) return value;
    }
    const existing = this.mediaPending.get(track.key); if (existing) return existing;
    if (this.mediaPending.size >= 2) throw new OnlineAudioError(429, '正在获取音频，请稍后重试');
    const operation = this.downloadMedia(track).finally(() => this.mediaPending.delete(track.key));
    this.mediaPending.set(track.key, operation); return operation;
  }
  private async downloadMedia(track: OnlineTrack): Promise<CachedMedia> {
    let directory: string | undefined;
    try {
      const media = await this.resolveMedia(track);
      directory = await mkdtemp(this.storage.resolve('cache/online-audio/media/track-'));
      const filePath = path.join(directory, `audio.${media.extension}`);
      const response = await this.openRemote(media.url, track.source, 'media');
      if (Number(response.headers['content-length']) > MAX_BYTES) { response.destroy(); throw new OnlineAudioError(413, '音频超过 50MB 上限'); }
      let bytes = 0;
      const bounded = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length; callback(bytes > MAX_BYTES ? new OnlineAudioError(413, '音频超过 50MB 上限') : null, chunk);
      } });
      await pipeline(response, bounded, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
      if (!bytes) throw new OnlineAudioError(422, '来源返回空音频');
      const probe = await this.probe(filePath, media.extension);
      if (!Number.isFinite(probe.durationMs) || probe.durationMs <= 0) throw new OnlineAudioError(422, '音频时长无效');
      const previewOnly = media.previewOnly || !!(track.durationMs && probe.durationMs < track.durationMs * 0.9 && track.durationMs - probe.durationMs > 10_000);
      const value: CachedMedia = { token: randomUUID(), trackKey: track.key, directory, path: filePath, extension: media.extension,
        durationMs: probe.durationMs, previewOnly, expires: this.now() + CACHE_MS };
      // ponytail: at most eight temporary tracks (~400MB); no persistent streaming cache.
      while (this.media.size >= 8) {
        const oldest = this.media.values().next().value!; this.media.delete(oldest.token);
        await rm(oldest.directory, { recursive: true, force: true });
      }
      this.media.set(value.token, value); return value;
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof OnlineAudioError) throw error;
      throw new OnlineAudioError(502, reason(error));
    }
  }
  startImport(keys: unknown, actor: string): AudioImportBatch {
    if (!Array.isArray(keys) || !keys.length || keys.length > 20 || new Set(keys).size !== keys.length) throw new OnlineAudioError(400, '每次请选择 1～20 首不同歌曲');
    const tracks = keys.map(key => this.track(key));
    if (this.waiting + tracks.filter(track => !this.imports.has(track.key)).length > 20) throw new OnlineAudioError(429, '下载队列已满，请等待当前批次完成');
    for (const [id, batch] of this.batches) if (this.now() - batch.created > 3_600_000 && batch.items.every(i => !['queued', 'downloading'].includes(i.status))) this.batches.delete(id);
    if (this.batches.size >= 100) throw new OnlineAudioError(429, '下载批次过多，请稍后重试');
    const items = tracks.map(track => {
      const pending = this.imports.get(track.key); if (pending) return pending;
      const item: AudioImportItem = { id: randomUUID(), track, status: 'queued' };
      this.imports.set(track.key, item); this.waiting++;
      this.queue = this.queue.then(async () => {
        item.status = 'downloading';
        try {
          const existing = (await this.assets.list('audio')).find(asset => asset.audioSource?.platform === track.source && asset.audioSource.trackId === track.trackId);
          if (existing && await this.assets.resolveFile(existing.id)) {
            item.assetId = existing.id; item.previewOnly = existing.audioSource?.previewOnly; item.status = 'succeeded'; item.message = '已在素材库'; return;
          }
          const media = await this.prepareMedia(track);
          const asset = await this.assets.add('audio', { originalName: `${track.artist ? `${track.artist} - ` : ''}${track.title}.${media.extension}`,
            data: await readFile(media.path), durationMs: media.durationMs,
            audioSource: { platform: track.source, trackId: track.trackId, title: track.title, artist: track.artist, url: track.url, previewOnly: media.previewOnly } });
          item.assetId = asset.id; item.previewOnly = media.previewOnly; item.status = 'succeeded'; item.message = media.previewOnly ? '试听片段已入库' : '已入库';
        } catch (error) { item.status = 'failed'; item.message = reason(error); }
        finally { this.imports.delete(track.key); this.waiting--; }
      }).catch(() => { item.status = 'failed'; item.message = '下载中断，请重试'; this.imports.delete(track.key); this.waiting--; });
      return item;
    });
    const batch = { id: randomUUID(), items, actor, created: this.now() };
    this.batches.set(batch.id, batch); return structuredClone({ id: batch.id, items });
  }
  getImport(id: string, actor: string): AudioImportBatch {
    const batch = this.batches.get(id);
    if (!batch || batch.actor !== actor) throw new OnlineAudioError(404, '下载批次不存在或后端已重启，请重新选择后下载');
    return structuredClone({ id: batch.id, items: batch.items });
  }
}

export async function probeAudioFile(filePath: string, extension: AudioMedia['extension'], binary = 'ffprobe'): Promise<{ durationMs: number }> {
  if ((await stat(filePath)).size > MAX_BYTES) throw new OnlineAudioError(413, '音频超过 50MB 上限');
  try {
    const { stdout, stderr } = await runCommand(binary, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,mov,aac',
      '-count_frames', '-show_format', '-show_streams', '-of', 'json', filePath], { captureStdout: true, captureStderr: true, timeoutMs: 15_000 });
    const info = JSON.parse(stdout); const format = String(info.format?.format_name ?? '').split(',');
    const streams = Array.isArray(info.streams) ? info.streams : [];
    const validFormat = extension === 'mp3' ? format.includes('mp3') : extension === 'm4a' ? format.includes('mov') : format.includes('aac');
    const durationMs = Math.round(Number(info.format?.duration) * 1000);
    if (stderr.trim() || !validFormat || !streams.some((s: any) => s.codec_type === 'audio' && Number(s.nb_read_frames) > 0)
      || streams.some((s: any) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
      || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error('invalid audio');
    return { durationMs };
  } catch { throw new OnlineAudioError(422, '音频校验失败，请确认 FFprobe 可用并重试；未导入素材库'); }
}

export { AUDIO_SOURCES, AUDIO_BOARDS, OnlineAudioError };
