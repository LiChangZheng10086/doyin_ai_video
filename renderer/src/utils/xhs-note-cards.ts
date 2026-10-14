import type { XhsNoteDraft } from '../../../src/lib/xhs-notes';

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
const WIDTH = 1080;
const HEIGHT = 1440;
const MARGIN = 88;

export function wrapCardText(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const { segment } of segmenter.segment(paragraph)) {
      if (measure(segment) > maxWidth) throw new Error('图卡文字过宽，请拆分内容后重新生成');
      if (line && measure(line + segment) > maxWidth) { lines.push(line); line = segment; }
      else line += segment;
    }
    lines.push(line);
  }
  return lines;
}

export function layoutCardText(card: XhsNoteDraft['cards'][number], measure: (text: string, size: number, bold: boolean) => number) {
  for (const bodySize of [44, 42, 40, 38, 36]) {
    const titleSize = bodySize + 20;
    const title = card.title ? wrapCardText(card.title, WIDTH - 2 * MARGIN, text => measure(text, titleSize, true)) : [];
    const body = card.body ? wrapCardText(card.body, WIDTH - 2 * MARGIN, text => measure(text, bodySize, false)) : [];
    const titleHeight = title.length * titleSize * 1.4;
    const bodyHeight = body.length * bodySize * 1.65;
    const gap = title.length && body.length ? 48 : 0;
    if (titleHeight + gap + bodyHeight <= HEIGHT - 2 * MARGIN - 72) {
      return { title, body, titleSize, bodySize, gap, titleHeight };
    }
  }
  throw new Error('图卡文字放不下，请把这张拆成多张，或精简文字后重新生成；不会裁掉文字');
}

export async function renderXhsNoteCards(cards: XhsNoteDraft['cards']): Promise<File[]> {
  if (!cards.length || cards.length > 18) throw new Error('请准备 1～18 张文字图卡');
  await document.fonts.ready;
  const files: File[] = [];
  for (const [index, card] of cards.entries()) {
    if (!card.title.trim() && !card.body.trim()) throw new Error(`第 ${index + 1} 张图卡为空，请填写内容`);
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('本机无法生成图卡，请改用上传图片');
    const font = (size: number, bold: boolean) => `${bold ? 600 : 400} ${size}px ${FONT}`;
    const layout = layoutCardText(card, (text, size, bold) => { ctx.font = font(size, bold); return ctx.measureText(text).width; });
    ctx.fillStyle = '#14171c'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#fe2c55'; ctx.fillRect(MARGIN, MARGIN, 64, 8);
    ctx.textBaseline = 'top'; ctx.fillStyle = '#e6eaf0';
    let y = MARGIN + 40;
    ctx.font = font(layout.titleSize, true);
    for (const line of layout.title) { ctx.fillText(line, MARGIN, y); y += layout.titleSize * 1.4; }
    y += layout.gap;
    ctx.font = font(layout.bodySize, false);
    for (const line of layout.body) { ctx.fillText(line, MARGIN, y); y += layout.bodySize * 1.65; }
    ctx.fillStyle = '#98a2b3'; ctx.font = font(28, false);
    ctx.fillText(`${index + 1} / ${cards.length}`, MARGIN, HEIGHT - MARGIN - 28);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图卡导出失败，请重试')), 'image/png'));
    files.push(new File([blob], `小红书图卡-${String(index + 1).padStart(2, '0')}.png`, { type: 'image/png' }));
  }
  return files;
}
