import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export type AudioSource = 'netease' | 'qq';
export type AudioBoardId = 'hot' | 'soar' | 'new';
export interface OnlineTrack {
  key: string; source: AudioSource; trackId: string; title: string; artist: string;
  url: string; durationMs?: number; rank?: number;
}
export interface AudioMedia { url: string; extension: 'mp3' | 'm4a' | 'aac'; previewOnly: boolean }
export class OnlineAudioError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const AUDIO_SOURCES = [
  { id: 'netease', name: '网易云音乐' }, { id: 'qq', name: 'QQ音乐' },
] as const;
export const AUDIO_BOARDS = [
  { id: 'hot', name: '热歌榜' }, { id: 'soar', name: '飙升榜' }, { id: 'new', name: '新歌榜' },
] as const;
const boardIds = { netease: { hot: 3778678, soar: 19723756, new: 3779629 }, qq: { hot: 26, soar: 62, new: 27 } };
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

export function validOnlineTrack(value: unknown, source: AudioSource): value is OnlineTrack {
  const item = object(value);
  return item.source === source && typeof item.trackId === 'string'
    && (source === 'netease' ? /^\d{1,20}$/ : /^[a-zA-Z0-9]{1,30}$/).test(item.trackId)
    && item.key === `${source}:${item.trackId}` && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 300
    && typeof item.artist === 'string' && item.artist.length <= 300
    && item.url === (source === 'netease' ? `https://music.163.com/song?id=${item.trackId}` : `https://y.qq.com/n/ryqq/songDetail/${item.trackId}`)
    && (item.durationMs === undefined || Number.isFinite(item.durationMs) && item.durationMs > 0 && item.durationMs < 86_400_000)
    && (item.rank === undefined || Number.isInteger(item.rank) && item.rank >= 1 && item.rank <= 100);
}

export function parseAudioTracks(source: AudioSource, payload: unknown, chart: boolean): OnlineTrack[] {
  const data = object(payload);
  const qq = object(data.req); const qqData = object(qq.data);
  if (source === 'netease' ? data.code !== 200 : data.code !== 0 || qq.code !== 0) throw new OnlineAudioError(502, '来源返回错误，请稍后重试');
  const result = object(data.result);
  const body = object(qqData.body);
  const rows = source === 'netease' ? chart ? result.tracks : result.songs
    : chart ? qqData.songInfoList : body.item_song ?? object(body.song).list;
  if (!Array.isArray(rows)) throw new OnlineAudioError(502, '来源响应格式变化，请稍后重试或打开原平台');
  const items: OnlineTrack[] = []; const seen = new Set<string>();
  for (const [index, value] of rows.slice(0, 100).entries()) {
    const row = object(value); const trackId = text(source === 'netease' ? row.id : row.mid);
    const singers = source === 'netease' ? row.artists ?? row.ar : row.singer;
    const durationMs = source === 'netease' ? row.duration ?? row.dt : Number(row.interval) * 1000;
    const item: OnlineTrack = { key: `${source}:${trackId}`, source, trackId,
      title: text(row.title ?? row.name).slice(0, 300), artist: Array.isArray(singers) ? singers.map(s => text(object(s).name)).filter(Boolean).join(' / ').slice(0, 300) : '',
      url: source === 'netease' ? `https://music.163.com/song?id=${trackId}` : `https://y.qq.com/n/ryqq/songDetail/${trackId}`,
      ...(Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : {}), ...(chart ? { rank: index + 1 } : {}) };
    if (!validOnlineTrack(item, source) || seen.has(item.key)) continue;
    seen.add(item.key); items.push(item);
  }
  if (!items.length && (chart || rows.length)) throw new OnlineAudioError(502, '来源未返回有效曲目，请稍后重试');
  return items;
}

export function validateAudioUrl(raw: string, source: AudioSource, purpose: 'metadata' | 'media'): URL {
  let url: URL; try { url = new URL(raw); } catch { throw new OnlineAudioError(502, '来源地址无效'); }
  const hosts = purpose === 'metadata' ? source === 'netease' ? ['music.163.com'] : ['u.y.qq.com']
    : source === 'netease' ? ['music.126.net'] : ['stream.qqmusic.qq.com', 'aqqmusic.tc.qq.com'];
  const allowed = hosts.some(host => url.hostname === host || purpose === 'media' && host !== 'aqqmusic.tc.qq.com' && url.hostname.endsWith(`.${host}`));
  if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new OnlineAudioError(502, '来源地址不在允许范围内');
  return url;
}

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001:db8::', 32], ['2001::', 32], ['2002::', 16]] as const) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
export function publicAudioAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

/** Validate and pin DNS at the actual connection; never follow redirects or forward cookies. */
export async function openAudioRemote(raw: string, source: AudioSource, purpose: 'metadata' | 'media'): Promise<IncomingMessage> {
  const url = validateAudioUrl(raw, source, purpose);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAudioAddress(item.address))) throw new OnlineAudioError(502, '来源解析到不允许的网络地址');
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false, signal: AbortSignal.timeout(purpose === 'media' ? 60_000 : 8000),
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: source === 'netease' ? 'https://music.163.com/' : 'https://y.qq.com/', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => {
        const done = callback as (...args: unknown[]) => void;
        if (options.all) done(null, addresses); else done(null, addresses[0].address, addresses[0].family);
      },
    }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new OnlineAudioError(502, `来源返回 HTTP ${response.statusCode}，请稍后重试`)); return; }
      resolve(response);
    });
    request.on('error', () => reject(new OnlineAudioError(502, '来源请求失败或超时，请检查网络后重试')));
  });
}

async function sourceJson(raw: string, source: AudioSource): Promise<unknown> {
  const response = await openAudioRemote(raw, source, 'metadata');
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new OnlineAudioError(502, '来源响应过大');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error instanceof OnlineAudioError) throw error; throw new OnlineAudioError(502, '来源响应无效或网络中断'); }
  finally { response.destroy(); }
}

function qqUrl(module: string, method: string, param: Record<string, unknown>, mobile = false): string {
  const data = { comm: { ct: mobile ? 11 : 24, cv: mobile ? 1003006 : 0, uin: 0, format: 'json' }, req: { module, method, param } };
  return `https://u.y.qq.com/cgi-bin/musicu.fcg?${new URLSearchParams({ data: JSON.stringify(data) })}`;
}
export async function fetchAudioTracks(source: AudioSource, input: { board?: AudioBoardId; query?: string }): Promise<OnlineTrack[]> {
  const chart = input.board !== undefined;
  const url = source === 'netease' ? chart ? `https://music.163.com/api/playlist/detail?id=${boardIds.netease[input.board!]}`
    : `https://music.163.com/api/search/get?${new URLSearchParams({ s: input.query!, type: '1', limit: '30', offset: '0' })}`
    : chart ? qqUrl('musicToplist.ToplistInfoServer', 'GetDetail', { topid: boardIds.qq[input.board!], num: 100, offset: 0 })
    : qqUrl('music.search.SearchCgiService', 'DoSearchForQQMusicMobile', { query: input.query!, num_per_page: 30, page_num: 1, search_type: 0 }, true);
  return parseAudioTracks(source, await sourceJson(url, source), chart);
}

export function parseAudioMedia(source: AudioSource, payload: unknown, trackId: string): AudioMedia {
  const data = object(payload); let raw = ''; let previewOnly = false; let extension = '';
  if (source === 'netease') {
    const item = object(Array.isArray(data.data) ? data.data.find((item: unknown) => text(object(item).id) === trackId) : undefined);
    raw = text(item.url); extension = text(item.type); previewOnly = !!item.freeTrialInfo;
  } else {
    const result = object(object(data.req).data);
    const item = object(Array.isArray(result.midurlinfo) ? result.midurlinfo.find((item: unknown) => text(object(item).songmid) === trackId) : undefined);
    const purl = text(item.purl);
    if (purl && Array.isArray(result.sip) && typeof result.sip[0] === 'string') {
      raw = new URL(purl, result.sip[0]).href; extension = new URL(raw).pathname.split('.').pop() ?? '';
      previewOnly = /(?:^|\/)RS\d|(?:^|\/)试听/i.test(purl);
    }
  }
  if (!raw) throw new OnlineAudioError(422, '该歌曲需会员、登录或暂不可用，请打开原平台查看');
  if (!['mp3', 'm4a', 'aac'].includes(extension)) throw new OnlineAudioError(422, '来源音频格式暂不支持入库');
  const url = new URL(raw); if (url.protocol === 'http:') url.protocol = 'https:';
  validateAudioUrl(url.href, source, 'media');
  return { url: url.href, extension: extension as AudioMedia['extension'], previewOnly };
}
export async function resolveAudio(track: OnlineTrack): Promise<AudioMedia> {
  const url = track.source === 'netease'
    ? `https://music.163.com/api/song/enhance/player/url?${new URLSearchParams({ ids: JSON.stringify([track.trackId]), br: '128000' })}`
    : qqUrl('vkey.GetVkeyServer', 'CgiGetVkey', { guid: '10000', songmid: [track.trackId], songtype: [0], uin: '0', loginflag: 1, platform: '20' });
  return parseAudioMedia(track.source, await sourceJson(url, track.source), track.trackId);
}
