import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GalleryImage } from './gallery-types.js';
import { GalleryError, validateGalleryImage } from './gallery-media.js';
import { requireToutiaoBrowserTarget } from './toutiao-browser.js';

export function validateTranslatedCaptions(captions: string[], count: number): void {
  if (!Array.isArray(captions) || captions.length !== count || !captions.length || captions.length > 9
    || captions.some(text => typeof text !== 'string' || !text.trim() || Array.from(text).length > 240
      || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)
      || (/[\p{L}]/u.test(text) && !/\p{Script=Han}/u.test(text)))) {
    throw new GalleryError(422, '中文译文须与画面逐条对应，每条 1～240 字且为纯文本');
  }
}

export function translatedCaptionHeight(text: string): number {
  // shortcut: conservative character widths reserve room for system Chinese fonts; Chromium rejects actual overflow before saving.
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / 26)), 0);
  return Math.max(112, lines * 48 + 32);
}

const escapeText = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function translatedGalleryHtml(image: GalleryImage, frames: Buffer[]): string {
  validateGalleryImage(image);
  validateTranslatedCaptions(image.translatedCaptions!, image.times.length);
  if (frames.length !== image.times.length + 1) throw new GalleryError(422, '译文画面数量不完整');
  const heights = image.translatedCaptions!.map(translatedCaptionHeight);
  const mainHeight = 1440 - heights.reduce((sum, height) => sum + height, 0);
  if (mainHeight < 432) throw new GalleryError(422, '中文译文排版溢出，请拆分图片以保证可读性');
  const src = (index: number) => `data:image/png;base64,${frames[index]!.toString('base64')}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; font-src 'none'"><style>
*{box-sizing:border-box}html,body{margin:0;width:1080px;height:1440px;overflow:hidden;background:#10151d}body{font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}.hero{height:${mainHeight}px;width:1080px;overflow:hidden}.hero img{display:block;width:100%;height:100%;object-fit:cover}.row{position:relative;width:1080px;overflow:hidden}.row img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.row:after{content:"";position:absolute;inset:0;background:rgba(5,10,18,.76)}.caption{position:relative;z-index:1;margin:0;padding:16px 48px;color:white;font-size:36px;font-weight:600;line-height:48px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all;overflow:hidden;height:100%}
</style></head><body><div class="hero"><img src="${src(0)}"></div>${image.translatedCaptions!.map((text, index) => `<div class="row" style="height:${heights[index]}px"><img src="${src(index + 1)}"><p class="caption">${escapeText(text)}</p></div>`).join('')}</body></html>`;
}

export async function renderTranslatedGallery(image: GalleryImage, frame: (time: number) => Promise<Buffer>, output: string, config: { browserBinary?: string } = {}): Promise<void> {
  validateGalleryImage(image);
  validateTranslatedCaptions(image.translatedCaptions!, image.times.length);
  let browser: import('playwright').Browser | undefined;
  try {
    const target = requireToutiaoBrowserTarget({ browserBinary: config.browserBinary, allowSystemChrome: true });
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, ...(target.kind === 'executablePath' ? { executablePath: target.path } : target.kind === 'channel' ? { channel: target.channel } : {}),
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'] });
    const context = await browser.newContext({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    const frames: Buffer[] = [];
    for (const time of [image.mainTime, ...image.times]) {
      const png = await frame(time);
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.length > 20 * 1024 * 1024) throw new GalleryError(422, '译文画面为空、损坏或超过 20MB');
      frames.push(png);
    }
    await page.setContent(translatedGalleryHtml(image, frames), { waitUntil: 'load', timeout: 20_000 });
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images, img => img.decode())); });
    const overflow = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.caption')).some(caption => caption.scrollHeight > caption.clientHeight || caption.scrollWidth > caption.clientWidth));
    if (overflow) throw new GalleryError(422, '中文译文实际排版溢出，请拆分图片或缩短译文以保证可读性');
    await mkdir(path.dirname(output), { recursive: true });
    await page.screenshot({ path: output, type: 'png', animations: 'disabled', fullPage: false });
  } catch (error) {
    await rm(output, { force: true });
    if (error instanceof GalleryError) throw error;
    if (!browser) throw new GalleryError(422, '中文图集浏览器未就绪：请配置有效的本地 Chromium 浏览器路径，或运行 npx playwright install chromium 后重试。', 'gallery_browser_unavailable');
    throw new GalleryError(422, `中文译文图片生成失败：${error instanceof Error ? error.message : String(error)}`, 'gallery_translation_render_failed');
  } finally { await browser?.close(); }
}
