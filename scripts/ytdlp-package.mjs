import { access, cp, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const YTDLP_VERSION = '2026.08.19';

export async function ensurePackagedYtDlp({ output, asset, version = YTDLP_VERSION, download, makeExecutable }) {
  if (!/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(version) || !['yt-dlp_macos', 'yt-dlp.exe'].includes(asset)) throw new Error('Invalid yt-dlp release or asset');
  const stamp = output + '.version';
  const exists = (file) => access(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
  if (await exists(output) && (await readFile(stamp, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; })).trim() === version) {
    await makeExecutable(output);
    return;
  }
  const temp = await mkdtemp(path.join(path.dirname(output), '.ytdlp-update-'));
  const binary = path.join(temp, asset);
  const nextStamp = path.join(temp, 'version');
  try {
    await download(`https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${asset}`, binary);
    if ((await stat(binary)).size === 0) throw new Error('Downloaded yt-dlp binary is empty');
    await makeExecutable(binary);
    await writeFile(nextStamp, version + '\n');
    const hadBinary = await exists(output);
    const hadStamp = await exists(stamp);
    if (hadBinary) await cp(output, path.join(temp, 'previous-binary'));
    if (hadStamp) await cp(stamp, path.join(temp, 'previous-version'));
    try {
      await rename(binary, output);
      await rename(nextStamp, stamp);
    } catch (error) {
      if (hadBinary) await rename(path.join(temp, 'previous-binary'), output);
      else await rm(output, { force: true });
      if (hadStamp) await rename(path.join(temp, 'previous-version'), stamp);
      else await rm(stamp, { force: true });
      throw error;
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}
