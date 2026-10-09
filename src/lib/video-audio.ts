import { open, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './command.js';
import type { AssetStore } from './assets-store.js';
import type { HyperframesCommandRunner } from './hyperframes-video.js';
import type { VideoAudioOptions, VideoCaptionCue, VideoAudioManifest } from '../types.js';

export interface LocalSpeechCapabilities {
  available: boolean;
  provider: 'macos-say';
  voices: Array<{ id: string; language: string }>;
  reason?: string;
}

export async function localSpeechCapabilities(): Promise<LocalSpeechCapabilities> {
  const unavailable = (reason: string): LocalSpeechCapabilities => ({ available: false, provider: 'macos-say', voices: [], reason });
  if (process.platform !== 'darwin') return unavailable('本地中文配音目前支持 macOS；仍可生成画面或使用素材库背景音乐。');
  try {
    const { stdout } = await runCommand('/usr/bin/say', ['-v', '?'], { captureStdout: true, captureStderr: true, timeoutMs: 10_000 });
    const voices = stdout.split('\n').flatMap(line => {
      const match = /^(.*?)\s+(zh_CN|zh_TW|zh_HK)\s+#/u.exec(line);
      return match ? [{ id: match[1]!.trim(), language: match[2]! }] : [];
    }).filter((voice, index, all) => all.findIndex(item => item.id === voice.id) === index);
    return voices.length ? { available: true, provider: 'macos-say', voices } : unavailable('未发现已安装中文系统语音，请在 macOS 辅助功能中添加语音后重试。');
  } catch { return unavailable('无法读取本机中文系统语音，请检查 macOS 的语音设置。'); }
}

export function parseVideoAudioOptions(value: unknown): VideoAudioOptions {
  if (value === undefined) return { voiceover: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('成片音频选项必须为对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['voiceover', 'voice', 'rate', 'backgroundAssetId', 'backgroundVolume'].includes(key))) throw new Error('成片音频选项包含未知字段');
  if (input.voiceover !== undefined && typeof input.voiceover !== 'boolean') throw new Error('配音选项须为布尔值');
  if (input.voice !== undefined && (typeof input.voice !== 'string' || !input.voice.trim() || input.voice.length > 160)) throw new Error('中文语音选项无效');
  if (input.rate !== undefined && (!Number.isInteger(input.rate) || (input.rate as number) < 150 || (input.rate as number) > 300)) throw new Error('配音速度须在 150～300 之间');
  if (input.backgroundAssetId !== undefined && (typeof input.backgroundAssetId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.backgroundAssetId))) throw new Error('背景音乐须选自本机音频素材库');
  if (input.backgroundVolume !== undefined && (typeof input.backgroundVolume !== 'number' || !Number.isFinite(input.backgroundVolume) || input.backgroundVolume < 0 || input.backgroundVolume > .5)) throw new Error('背景音乐音量须在 0～50% 之间');
  return { voiceover: input.voiceover === true,
    ...(input.voice !== undefined ? { voice: input.voice as string } : {}),
    ...(input.rate !== undefined ? { rate: input.rate as number } : {}),
    ...(input.backgroundAssetId !== undefined ? { backgroundAssetId: input.backgroundAssetId as string } : {}),
    ...(input.backgroundVolume !== undefined ? { backgroundVolume: input.backgroundVolume as number } : {}),
  };
}

export function splitSpokenCaptions(text: string): string[] {
  const result: string[] = [];
  let pending = '';
  function appendChunk(value: string): void {
    const chunk = value.trim();
    if (!chunk) return;
    if (/^[\p{P}\p{S}]+$/u.test(chunk) && result.length) result[result.length - 1] += chunk;
    else result.push(chunk);
  }
  for (const character of text.trim().replace(/\s+/gu, ' ')) {
    pending += character;
    if (/[。！？!?；;，,]/u.test(character) || Array.from(pending).length >= 28) {
      appendChunk(pending);
      pending = '';
    }
  }
  appendChunk(pending);
  return result;
}

function srtTime(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const h = Math.floor(milliseconds / 3_600_000);
  const m = Math.floor(milliseconds / 60_000) % 60;
  const s = Math.floor(milliseconds / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`;
}

export function captionsSrt(cues: VideoCaptionCue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n');
}

export async function snapshotBackgroundAudio(assets: AssetStore, root: string, id: string, destination: string): Promise<{ id: string; title: string }> {
  const asset = await assets.resolveFile(id);
  if (!asset || asset.record.kind !== 'audio') throw new Error('背景音乐素材已删除或不是音频，请重新选择');
  const canonicalRoot = await realpath(root);
  const handle = await open(asset.path, 'r');
  try {
    const before = await handle.stat();
    const current = await stat(asset.path);
    const canonicalFile = await realpath(asset.path);
    const relative = path.relative(path.join(canonicalRoot, 'assets/audio'), canonicalFile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !before.isFile() || before.size <= 0 || before.size > 50 * 1024 * 1024
      || before.dev !== current.dev || before.ino !== current.ino || before.size !== asset.record.bytes) throw new Error('背景音乐文件不在安全素材目录内或已经改变');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) throw new Error('背景音乐在读取时发生变化，请重新选择');
    await writeFile(destination, bytes, { flag: 'wx' });
    return { id: asset.record.id, title: asset.record.originalName };
  } finally { await handle.close(); }
}

export interface VideoAudioPreparationOptions {
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  runner?: HyperframesCommandRunner;
  resolveBackground?: (id: string, destination: string) => Promise<{ id: string; title: string }>;
  // Tests may supply local audio; production always uses the installed OS voice.
  synthesize?: (text: string, output: string, voice: string, rate: number, signal?: AbortSignal) => Promise<void>;
}

export class LocalVideoAudio {
  private readonly runner: HyperframesCommandRunner;
  constructor(private readonly config: VideoAudioPreparationOptions = {}) { this.runner = config.runner ?? { run: runCommand }; }

  private async ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
    await this.runner.run(this.config.ffmpegBinary ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { captureStderr: true, timeoutMs: 120_000, signal });
  }

  private async duration(file: string, signal?: AbortSignal): Promise<number> {
    const { stdout } = await this.runner.run(this.config.ffprobeBinary ?? 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,mov,aac,wav,aiff', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { captureStdout: true, captureStderr: true, timeoutMs: 20_000, signal });
    const data = JSON.parse(stdout); const duration = Number(data.format?.duration);
    if (!data.streams?.some((stream: { codec_type?: string }) => stream.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('成片音频无有效音轨或时长异常');
    return duration;
  }

  async prepare(scenes: Array<{ index: number; narration: string; duration: number }>, duration: number, project: string, rawOptions: VideoAudioOptions, signal?: AbortSignal): Promise<VideoAudioManifest | undefined> {
    const options = parseVideoAudioOptions(rawOptions);
    if (!options.voiceover && !options.backgroundAssetId) return undefined;
    const dir = path.join(project, 'assets/audio');
    await mkdir(dir, { recursive: true });
    const cues: VideoCaptionCue[] = [];
    let voice: string | undefined;
    if (options.voiceover) {
      if (this.config.synthesize) voice = options.voice ?? 'test-local-voice';
      else {
        const capabilities = await localSpeechCapabilities();
        if (!capabilities.available) throw new Error(capabilities.reason);
        voice = options.voice ?? capabilities.voices.find(item => item.id.startsWith('Tingting') && item.language === 'zh_CN')?.id ?? capabilities.voices[0]!.id;
        if (!capabilities.voices.some(item => item.id === voice)) throw new Error('所选中文系统语音已不可用，请刷新语音列表');
      }
      let sceneStart = 0;
      const concat: string[] = [];
      await this.ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(duration), '-c:a', 'pcm_s16le', path.join(dir, 'silence.wav')], signal);
      const silence = (seconds: number) => { if (seconds > .0001) concat.push("file 'silence.wav'", 'inpoint 0', `outpoint ${seconds.toFixed(6)}`); };
      for (const scene of scenes) {
        const chunks = splitSpokenCaptions(scene.narration);
        if (!chunks.some(chunk => /[\p{L}\p{N}]/u.test(chunk)) || Array.from(scene.narration).length > 2000) throw new Error(`第 ${scene.index} 镜头缺少有效口播稿或内容过长`);
        const parts: Array<{ text: string; file: string; duration: number }> = [];
        for (const [index, text] of chunks.entries()) {
          if (signal?.aborted) throw new Error('配音生成已取消');
          const stem = `voice-${scene.index}-${index + 1}`;
          const input = path.join(dir, `${stem}.aiff`); const file = path.join(dir, `${stem}.wav`);
          if (this.config.synthesize) await this.config.synthesize(text, input, voice!, options.rate ?? 210, signal);
          else {
            const script = path.join(dir, `${stem}.txt`);
            await writeFile(script, text.replaceAll('[[', '［［').replaceAll(']]', '］］'), 'utf8');
            await this.runner.run('/usr/bin/say', ['-v', voice!, '-r', String(options.rate ?? 210), '-f', script, '-o', input], { captureStderr: true, timeoutMs: 60_000, signal });
          }
          await this.ffmpeg(['-i', input, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', file], signal);
          parts.push({ text, file, duration: await this.duration(file, signal) });
        }
        const total = parts.reduce((sum, item) => sum + item.duration, 0);
        const available = scene.duration - .6;
        const speed = Math.max(1, total / available);
        if (available <= 0 || speed > 1.35) throw new Error(`第 ${scene.index} 镜头口播需要 ${total.toFixed(1)} 秒，超过 ${available.toFixed(1)} 秒可用时长；请缩短口播或增加分镜时长，不会截断配音。`);
        silence(.3);
        let cursor = sceneStart + .3;
        for (const part of parts) {
          if (speed > 1.001) {
            const fitted = part.file.replace('.wav', '-fit.wav');
            await this.ffmpeg(['-i', part.file, '-af', `atempo=${speed.toFixed(6)}`, '-c:a', 'pcm_s16le', fitted], signal);
            part.file = fitted; part.duration = await this.duration(fitted, signal);
          }
          const end = cursor + part.duration;
          if (end > sceneStart + scene.duration - .25) throw new Error(`第 ${scene.index} 镜头配音无法完整放入分镜，请缩短口播`);
          cues.push({ sceneIndex: scene.index, text: part.text, start: cursor, end, file: `assets/audio/${path.basename(part.file)}` });
          concat.push(`file '${path.basename(part.file)}'`); cursor = end;
        }
        silence(sceneStart + scene.duration - cursor);
        sceneStart += scene.duration;
      }
      await writeFile(path.join(dir, 'narration.ffconcat'), ['ffconcat version 1.0', ...concat].join('\n') + '\n', 'utf8');
      await this.ffmpeg(['-f', 'concat', '-safe', '1', '-i', path.join(dir, 'narration.ffconcat'), '-af', `apad=whole_dur=${duration},atrim=duration=${duration}`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', path.join(dir, 'narration.wav')], signal);
      await writeFile(path.join(dir, 'subtitles.srt'), captionsSrt(cues), 'utf8');
    }
    let background: { id: string; title: string } | undefined;
    if (options.backgroundAssetId) {
      if (!this.config.resolveBackground) throw new Error('背景音乐素材解析未配置');
      const raw = path.join(dir, 'background-source');
      background = await this.config.resolveBackground(options.backgroundAssetId, raw);
      await this.duration(raw, signal);
      await this.ffmpeg(['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,mov,aac,wav', '-i', raw, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', path.join(dir, 'background.wav')], signal);
    }
    const inputs = [...(options.voiceover ? ['-i', path.join(dir, 'narration.wav')] : []), ...(background ? ['-stream_loop', '-1', '-i', path.join(dir, 'background.wav')] : [])];
    const fade = `afade=t=in:st=0:d=0.35,afade=t=out:st=${Math.max(0, duration - .5)}:d=0.5`;
    const volume = options.backgroundVolume ?? .12;
    let filter: string;
    if (options.voiceover && background) filter = `[0:a]asplit=2[voice][side];[1:a]volume=${volume},${fade}[bed];[bed][side]sidechaincompress=threshold=0.025:ratio=8:attack=15:release=250[ducked];[voice][ducked]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false[out]`;
    else if (options.voiceover) filter = '[0:a]alimiter=limit=0.95:level=false[out]';
    else filter = `[0:a]volume=${volume},${fade},alimiter=limit=0.95:level=false[out]`;
    await this.ffmpeg([...inputs, '-filter_complex', filter, '-map', '[out]', '-t', String(duration), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', path.join(dir, 'mix.wav')], signal);
    const mixDuration = await this.duration(path.join(dir, 'mix.wav'), signal);
    if (Math.abs(mixDuration - duration) > .1) throw new Error('成片混音时长与画面不一致');
    const manifest: VideoAudioManifest = { provider: 'system-local', voiceover: options.voiceover, voice, rate: options.voiceover ? options.rate ?? 210 : undefined,
      backgroundAssetId: background?.id, backgroundTitle: background?.title, backgroundVolume: background ? volume : undefined,
      mixFile: 'assets/audio/mix.wav', subtitleFile: options.voiceover ? 'assets/audio/subtitles.srt' : undefined, duration, cues };
    await writeFile(path.join(dir, 'audio-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }
}
