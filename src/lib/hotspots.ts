import { createHash } from 'node:crypto';
import { LocalStorage } from './storage.js';
import { HOTSPOT_SOURCES, fetchHotspotSource, validHotspotItem } from './hotspot-sources.js';
export interface HotspotItem { sourceId: string; itemId: string; title: string; url: string; rank: number; heat?: string; summary?: string }
export interface HotspotBoard {
  source: { id: string; name: string; label: string; home: string };
  items: HotspotItem[];
  fetchedAt?: string;
  checkedAt?: string;
  refreshAfter?: string;
  expiresAt?: string;
  status: 'fresh' | 'stale' | 'unavailable';
  delivery: 'network' | 'cache';
  error?: string;
}
export interface HotspotFavorite extends HotspotItem { id: string; note: string; version: number; fetchedAt: string; savedAt: string; updatedAt: string }
type Snapshot = { items: HotspotItem[]; fetchedAt?: string; checkedAt?: string; error?: string };
export class HotspotError extends Error { constructor(public status: number, message: string) { super(message); } }
const CACHE_MS = 600_000;
const REFRESH_MS = 60_000;
const time = (value?: string): number => typeof value === 'string' ? Date.parse(value) : NaN;
const favoriteFile = 'cache/hotspot-favorites.json';
const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

export class HotspotService {
  private readonly pending = new Map<string, Promise<HotspotBoard>>();
  private readonly memory = new Map<string, Snapshot>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly fetchSource: (source: string) => Promise<HotspotItem[]>;
  constructor(private storage: LocalStorage, deps: { now?: () => number; fetchSource?: (source: string) => Promise<HotspotItem[]> } = {}) {
    this.now = deps.now ?? Date.now; this.fetchSource = deps.fetchSource ?? fetchHotspotSource;
  }
  async list(refresh = false): Promise<HotspotBoard[]> {
    return Promise.all(HOTSPOT_SOURCES.map(source => {
      const pending = this.pending.get(source.id); if (pending) return pending;
      const operation = this.board(source, refresh).finally(() => this.pending.delete(source.id));
      this.pending.set(source.id, operation); return operation;
    }));
  }
  private async snapshot(sourceId: string): Promise<Snapshot> {
    const memory = this.memory.get(sourceId); if (memory) return memory;
    let data: Snapshot | null;
    try { data = await this.storage.readJson<Snapshot>(`cache/hotspots/${sourceId}.json`); }
    catch (error) { if (missing(error)) return { items: [] }; if (error instanceof SyntaxError) return { items: [], error: '本地榜单缓存损坏，正在重新获取' }; throw error; }
    const now = this.now();
    if (!data || !Array.isArray(data.items) || data.items.length > 100
      || data.items.some(item => !validHotspotItem(item, sourceId))
      || (data.items.length > 0 && (!Number.isFinite(time(data.fetchedAt)) || time(data.fetchedAt) > now))
      || (data.checkedAt !== undefined && (!Number.isFinite(time(data.checkedAt)) || time(data.checkedAt) > now))) return { items: [] };
    return { items: data.items, fetchedAt: data.fetchedAt, checkedAt: data.checkedAt, ...(typeof data.error === 'string' ? { error: data.error.slice(0, 300) } : {}) };
  }
  private async board(source: typeof HOTSPOT_SOURCES[number], refresh: boolean): Promise<HotspotBoard> {
    let snapshot: Snapshot;
    try { snapshot = await this.snapshot(source.id); }
    catch { snapshot = { items: [], error: '本地缓存读取失败，请检查存储目录权限' }; }
    let delivery: HotspotBoard['delivery'] = 'cache';
    const now = this.now();
    if ((refresh || !snapshot.fetchedAt || now - time(snapshot.fetchedAt) >= CACHE_MS)
      && (!snapshot.checkedAt || now - time(snapshot.checkedAt) >= REFRESH_MS)) {
      snapshot = { ...snapshot, checkedAt: new Date(now).toISOString() };
      try {
        const items = await this.fetchSource(source.id);
        if (!items.length || items.length > 100 || items.some(item => !validHotspotItem(item, source.id))) throw new Error('来源返回无效榜单');
        snapshot = { items, fetchedAt: new Date(this.now()).toISOString(), checkedAt: snapshot.checkedAt }; delivery = 'network';
      } catch (error) {
        const reason = error instanceof Error && /^(来源|匿名会话)/.test(error.message) ? error.message : '来源暂不可用，请检查网络或稍后重试';
        snapshot = { ...snapshot, error: reason.slice(0, 300) };
      }
      this.memory.set(source.id, snapshot);
      try { await this.storage.writeJsonAtomic(`cache/hotspots/${source.id}.json`, snapshot); }
      catch { snapshot = { ...snapshot, error: '本地缓存保存失败，本次数据未持久化，请检查存储目录权限' }; this.memory.set(source.id, snapshot); }
    }
    return { source: { id: source.id, name: source.name, label: source.label, home: source.home }, ...snapshot, delivery,
      refreshAfter: snapshot.checkedAt ? new Date(time(snapshot.checkedAt) + REFRESH_MS).toISOString() : undefined,
      expiresAt: snapshot.fetchedAt ? new Date(time(snapshot.fetchedAt) + CACHE_MS).toISOString() : undefined,
      status: snapshot.items.length ? snapshot.error || this.now() - time(snapshot.fetchedAt) >= CACHE_MS ? 'stale' : 'fresh' : 'unavailable' };
  }
  async favorites(): Promise<HotspotFavorite[]> {
    let data: unknown;
    try { data = await this.storage.readJson<unknown>(favoriteFile); }
    catch (error) { if (missing(error)) return []; throw error; }
    if (!Array.isArray(data) || data.length > 1000 || data.some((item: HotspotFavorite) => !validHotspotItem(item, item?.sourceId)
      || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id) || typeof item.note !== 'string' || item.note.length > 2000
      || !Number.isInteger(item.version) || item.version < 1 || !Number.isFinite(time(item.fetchedAt)) || !Number.isFinite(time(item.savedAt)) || !Number.isFinite(time(item.updatedAt)))) {
      throw new HotspotError(500, '选题收藏文件损坏，请先备份并检查存储目录，未覆盖原文件');
    }
    return data as HotspotFavorite[];
  }
  // ponytail: one local favorites index; serialize writes, move to transactions only for multi-process writers.
  private mutate<T>(action: (items: HotspotFavorite[]) => Promise<T>): Promise<T> {
    const operation = this.writes.then(async () => { const items = await this.favorites(); const result = await action(items); await this.storage.writeJsonAtomic(favoriteFile, items); return result; });
    this.writes = operation.catch(() => {}); return operation;
  }
  async resolveDetail(sourceId: string, itemId: string) {
    if(typeof sourceId!=='string'||typeof itemId!=='string')return undefined;
    if (!HOTSPOT_SOURCES.some(s => s.id === sourceId)) return undefined;
    const snapshot = await this.snapshot(sourceId);
    const item = snapshot.items.find(i => i.itemId === itemId) ?? (await this.favorites()).find(i => i.sourceId === sourceId && i.itemId === itemId);
    if (!item) return undefined;
    return {item:structuredClone(item),fetchedAt:'fetchedAt' in item ? String(item.fetchedAt) : snapshot.fetchedAt};
  }
  async resolveForArticle(sourceId: string, itemId: string) {
    const detail=await this.resolveDetail(sourceId,itemId);if(!detail)return undefined;
    const item=detail.item;
    return {sourceId,itemId,title:item.title,url:item.url,fetchedAt:detail.fetchedAt};
  }
  async save(sourceId: unknown, itemId: unknown): Promise<HotspotFavorite> {
    if (typeof sourceId !== 'string' || !HOTSPOT_SOURCES.some(source => source.id === sourceId)
      || typeof itemId !== 'string' || !itemId || itemId.length > 2048) throw new HotspotError(400, '请选择有效来源和榜单条目');
    const snapshot = await this.snapshot(sourceId);
    const item = snapshot.items.find(item => item.itemId === itemId);
    if (!item || !snapshot.fetchedAt) throw new HotspotError(404, '该条目已不在当前榜单中，请重新加载后收藏');
    return this.mutate(async items => {
      const id = createHash('sha256').update(JSON.stringify([sourceId, itemId])).digest('hex');
      const existing = items.find(item => item.id === id); if (existing) return existing;
      if (items.length >= 1000) throw new HotspotError(422, '最多收藏 1000 个选题，请先移除不需要的收藏');
      const now = new Date(this.now()).toISOString();
      const favorite: HotspotFavorite = { ...item, id, note: '', version: 1, fetchedAt: snapshot.fetchedAt!, savedAt: now, updatedAt: now };
      items.unshift(favorite); return favorite;
    });
  }
  private current(items: HotspotFavorite[], id: string, version: unknown): HotspotFavorite {
    if (!Number.isInteger(version) || Number(version) < 1) throw new HotspotError(400, '请提供当前收藏版本');
    const item = items.find(item => item.id === id); if (!item) throw new HotspotError(404, '选题收藏不存在或已移除');
    if (item.version !== version) throw new HotspotError(409, '收藏已在其他页面修改，请重新加载后核对；未覆盖你的编辑');
    return item;
  }
  async update(id: string, note: unknown, version: unknown): Promise<HotspotFavorite> {
    if (typeof note !== 'string' || note.length > 2000) throw new HotspotError(400, '备注必须是文本，且不超过 2000 字符');
    return this.mutate(async items => { const item = this.current(items, id, version); item.note = note; item.version++; item.updatedAt = new Date(this.now()).toISOString(); return item; });
  }
  async remove(id: string, version: unknown): Promise<void> {
    return this.mutate(async items => { const item = this.current(items, id, version); items.splice(items.indexOf(item), 1); });
  }
}
