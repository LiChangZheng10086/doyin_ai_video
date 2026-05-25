"""
Video Generator — renders PPT slides as video with Ken Burns zoom + TTS audio.

Uses the same theme system as ppt_generator.py for visual consistency.
Each slide is rendered as a 1920×1080 PIL image, then composed with
moviepy into an MP4 with subtle Ken Burns zoom and TTS voiceover.
"""

import logging
import re
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Fonts — macOS system fonts for Chinese rendering
# ---------------------------------------------------------------------------

FONT_REGULAR = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_MONO = "/System/Library/Fonts/Menlo.ttc"

# ---------------------------------------------------------------------------
# Theme colours (mirrors ppt_generator.py but without python-pptx dependency)
# ---------------------------------------------------------------------------

THEMES = {
    "tech_blue": {
        "bg":         (0x08, 0x0D, 0x20),
        "bg_accent":  (0x0F, 0x17, 0x3A),
        "primary":    (0x1A, 0x56, 0xDB),
        "cyan":       (0x00, 0xD4, 0xFF),
        "cyan_dim":   (0x00, 0x8A, 0xBB),
        "accent":     (0x7C, 0x3A, 0xED),
        "title":      (0xFF, 0xFF, 0xFF),
        "subtitle":   (0x8A, 0xB4, 0xFF),
        "heading":    (0x00, 0xD4, 0xFF),
        "body":       (0xE0, 0xE8, 0xF5),
        "muted":      (0x5A, 0x6A, 0x8A),
        "bullet":     (0x00, 0xD4, 0xFF),
        "code_bg":    (0x12, 0x1A, 0x33),
        "code_border":(0x1A, 0x56, 0xDB),
        "line":       (0x1A, 0x3A, 0x6A),
        "glow":       (0x00, 0xB4, 0xD8),
    },
    "clean_white": {
        "bg":         (0x1A, 0x1A, 0x2E),
        "bg_accent":  (0x22, 0x22, 0x38),
        "primary":    (0x2D, 0x34, 0x3E),
        "cyan":       (0xE0, 0x6D, 0x06),
        "cyan_dim":   (0xA0, 0x50, 0x00),
        "accent":     (0xF5, 0x9E, 0x0B),
        "title":      (0xFF, 0xFF, 0xFF),
        "subtitle":   (0xBB, 0xC1, 0xCC),
        "heading":    (0xE0, 0x6D, 0x06),
        "body":       (0xE0, 0xE4, 0xEA),
        "muted":      (0x7A, 0x84, 0x96),
        "bullet":     (0xE0, 0x6D, 0x06),
        "code_bg":    (0x2A, 0x2A, 0x3E),
        "code_border":(0xE0, 0x6D, 0x06),
        "line":       (0x2A, 0x2A, 0x40),
        "glow":       (0xE0, 0x6D, 0x06),
    },
    "warm_orange": {
        "bg":         (0x12, 0x0A, 0x08),
        "bg_accent":  (0x22, 0x12, 0x0A),
        "primary":    (0xFF, 0x6B, 0x35),
        "cyan":       (0xFF, 0x8A, 0x50),
        "cyan_dim":   (0xC0, 0x50, 0x20),
        "accent":     (0xFF, 0xCC, 0x80),
        "title":      (0xFF, 0xFF, 0xFF),
        "subtitle":   (0xFF, 0xC0, 0xA0),
        "heading":    (0xFF, 0x8A, 0x50),
        "body":       (0xF0, 0xE8, 0xE0),
        "muted":      (0x90, 0x70, 0x60),
        "bullet":     (0xFF, 0x6B, 0x35),
        "code_bg":    (0x1E, 0x14, 0x10),
        "code_border":(0xFF, 0x6B, 0x35),
        "line":       (0x3A, 0x20, 0x18),
        "glow":       (0xFF, 0x8A, 0x50),
    },
}

DEFAULT_THEME = "tech_blue"

# Frame dimensions — portrait 9:16 for Douyin
W, H = 1080, 1920

# ---------------------------------------------------------------------------
# Font helpers
# ---------------------------------------------------------------------------

_FONT_CACHE: dict[str, ImageFont.FreeTypeFont] = {}


def _font(size: int, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont:
    key = f"{size}_{bold}_{mono}"
    if key not in _FONT_CACHE:
        path = FONT_MONO if mono else FONT_REGULAR
        _FONT_CACHE[key] = ImageFont.truetype(str(path), size)
    return _FONT_CACHE[key]


# ---------------------------------------------------------------------------
# Drawing helpers
# ---------------------------------------------------------------------------

def _draw_rect(draw, x, y, w, h, color):
    draw.rectangle([x, y, x + w, y + h], fill=color)


def _draw_circle(draw, cx, cy, r, color):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)


def _text_lines(draw, text: str, x: int, y: int, font, color, max_w: int, line_h: int):
    """Draw text with word wrapping. Returns final y."""
    chars_per_line = max_w // (font.getbbox("A")[2] - font.getbbox("A")[0] + 2)
    words = text.replace(" ", "\n").split("\n")
    lines = []
    for w in words:
        if not lines:
            lines.append(w)
        elif len(lines[-1]) + len(w) + 1 < chars_per_line:
            lines[-1] += " " + w
        else:
            lines.append(w)

    cy = y
    for line in lines:
        if cy > H - 20:
            break
        draw.text((x, cy), line, font=font, fill=color)
        cy += line_h
    return cy


def _wrap_text(text: str, font, max_width: int) -> list[str]:
    """Wrap text to fit max_width pixels. Preserves intentional line breaks."""
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        line = ""
        for char in paragraph:
            test = line + char
            if font.getbbox(test)[2] > max_width and line:
                lines.append(line)
                line = char
            else:
                line = test
        if line:
            lines.append(line)
    return lines


SUBTITLE_BAR_H = 150  # height of subtitle bar at bottom
SUBTITLE_FONT_SIZE = 24


def _draw_subtitle_bar(img: Image.Image, text: str, theme_colors: dict):
    """Draw a subtitle bar at the bottom of the frame with wrapped text."""
    draw = ImageDraw.Draw(img)
    bar_y = H - SUBTITLE_BAR_H

    # Black subtitle background
    _draw_rect(draw, 0, bar_y, W, SUBTITLE_BAR_H, (0x00, 0x00, 0x00))
    # Top accent border line
    _draw_rect(draw, 0, bar_y, W, 3, theme_colors["cyan"])

    if not text:
        return

    sub_font = _font(SUBTITLE_FONT_SIZE)
    wrapped = _wrap_text(text.strip()[:150], sub_font, W - 100)

    # Center text vertically in the bar
    line_h = SUBTITLE_FONT_SIZE + 6
    total_h = len(wrapped) * line_h
    start_y = bar_y + (SUBTITLE_BAR_H - total_h) // 2

    for i, line in enumerate(wrapped):
        tw = sub_font.getbbox(line)[2]
        tx = (W - tw) // 2
        ty = start_y + i * line_h
        draw.text((tx, ty), line, font=sub_font, fill=(0xFF, 0xFF, 0xFF))


# ---------------------------------------------------------------------------
# Slide renderers
# ---------------------------------------------------------------------------

class SlideRenderer:
    """Renders slides as 1920×1080 PIL Images using a given theme."""

    def __init__(self, theme_id: str):
        self.c = dict(THEMES.get(theme_id, THEMES[DEFAULT_THEME]))

    # ---- Title slide ----

    def render_title(self, title: str, subtitle: str) -> Image.Image:
        img = Image.new("RGB", (W, H), self.c["bg"])
        draw = ImageDraw.Draw(img)

        # Decorative circles
        _draw_circle(draw, 900, 100, 280, self.c["bg_accent"])
        _draw_circle(draw, 60, 1400, 250, self.c["bg_accent"])

        # Top accent line
        _draw_rect(draw, 0, 0, W, 6, self.c["cyan"])

        # Left vertical accent bar
        _draw_rect(draw, 60, 350, 6, 900, self.c["primary"])

        # Bottom glow bar
        _draw_rect(draw, 0, 1905, W, 15, self.c["cyan"])

        # Title text
        title_font = _font(56, bold=True)
        draw.text((120, 480), title, font=title_font, fill=self.c["title"])

        # Title underline
        title_w = title_font.getbbox(title)[2]
        _draw_rect(draw, 120, 570, min(title_w + 40, 880), 4, self.c["cyan"])

        # Subtitle
        if subtitle:
            sub_font = _font(24)
            draw.text((120, 630), subtitle[:200], font=sub_font, fill=self.c["subtitle"])

        # Bottom-right decoration
        _draw_rect(draw, 750, 1850, 280, 4, self.c["primary"])
        _draw_rect(draw, 750, 1820, 150, 4, self.c["cyan"])

        return img

    # ---- Content slide ----

    def render_content(self, title: str, content: str, page_num: int) -> Image.Image:
        img = Image.new("RGB", (W, H), self.c["bg"])
        draw = ImageDraw.Draw(img)

        # Subtle bg decoration (top-right circle)
        _draw_circle(draw, 900, 0, 200, self.c["bg_accent"])

        # Top accent line
        _draw_rect(draw, 0, 0, W, 6, self.c["cyan"])

        # Left accent bars
        _draw_rect(draw, 50, 30, 6, 1860, self.c["primary"])
        _draw_rect(draw, 50, 30, 3, 1860, self.c["cyan"])

        # Title
        title_font = _font(36, bold=True)
        draw.text((120, 70), title, font=title_font, fill=self.c["heading"])

        # Separator
        _draw_rect(draw, 120, 130, 840, 2, self.c["line"])

        # Content area
        self._draw_content(draw, content, x=120, y=170, max_w=840, max_h=1600)

        # Page number
        page_font = _font(14)
        draw.text((1000, 1880), str(page_num), font=page_font, fill=self.c["muted"])

        return img

    # ---- Content parser ----

    def _draw_content(self, draw, content: str, x: int, y: int, max_w: int, max_h: int):
        """Parse markdown-like content and draw it on the slide."""
        lines = content.split("\n")
        cy = y
        code_block = False
        code_lines = []

        body_font = _font(26)
        heading_font = _font(36, bold=True)
        sub_heading_font = _font(30, bold=True)
        small_heading_font = _font(26, bold=True)
        code_font = _font(18, mono=True)
        bullet_font = _font(26)

        for line in lines:
            if cy > y + max_h - 30:
                break
            stripped = line.strip()

            # Code block
            if stripped.startswith("```"):
                if code_block:
                    # Render accumulated code
                    if code_lines:
                        # Code background
                        code_h = min(len(code_lines) * 32 + 20, 400)
                        _draw_rect(draw, x - 10, cy - 5, max_w + 20, code_h, self.c["code_bg"])
                        _draw_rect(draw, x - 10, cy - 5, max_w + 20, code_h, self.c["code_border"])
                        for cl in code_lines:
                            draw.text((x + 10, cy + 5), cl[:120], font=code_font, fill=self.c["body"])
                            cy += 30
                        cy += 10
                    code_lines = []
                    code_block = False
                else:
                    code_block = True
                    code_lines = []
                continue

            if code_block:
                code_lines.append(stripped)
                continue

            # Empty line
            if not stripped:
                cy += 20
                continue

            # Level-3 heading (###)
            if stripped.startswith("### "):
                cy += 10
                draw.text((x, cy), stripped[4:], font=small_heading_font, fill=self.c["heading"])
                cy += 40
                continue

            # Level-2 heading (##)
            if stripped.startswith("## "):
                cy += 10
                draw.text((x, cy), stripped[3:], font=sub_heading_font, fill=self.c["heading"])
                cy += 45
                continue

            # Level-1 heading (#)
            if stripped.startswith("# "):
                cy += 10
                draw.text((x, cy), stripped[2:], font=heading_font, fill=self.c["heading"])
                cy += 55
                continue

            # Bullet
            if stripped.startswith("- ") or stripped.startswith("❍ "):
                text = stripped[2:] if stripped.startswith("- ") else stripped[1:]
                draw.text((x, cy), "◆  ", font=bullet_font, fill=self.c["bullet"])
                # Wrap bullet text
                bullet_lines = _wrap_text(text, body_font, max_w - 60)
                for i, bl in enumerate(bullet_lines):
                    if i == 0:
                        draw.text((x + 60, cy), bl, font=body_font, fill=self.c["body"])
                    else:
                        cy += 36
                        draw.text((x + 60, cy), bl, font=body_font, fill=self.c["body"])
                cy += 40
                continue

            # Bold text
            if "**" in stripped:
                parts = re.split(r"(\*\*.*?\*\*)", stripped)
                cx = x
                for part in parts:
                    if part.startswith("**") and part.endswith("**"):
                        draw.text((cx, cy), part[2:-2], font=sub_heading_font, fill=self.c["heading"])
                        cx += sub_heading_font.getbbox(part[2:-2])[2] + 4
                    else:
                        draw.text((cx, cy), part, font=body_font, fill=self.c["body"])
                        cx += body_font.getbbox(part)[2] + 4
                cy += 40
                continue

            # Regular text — wrap
            text_lines = _wrap_text(stripped, body_font, max_w)
            for tl in text_lines:
                draw.text((x, cy), tl, font=body_font, fill=self.c["body"])
                cy += 36
            cy += 6

        # Handle unclosed code block
        if code_lines:
            code_h = min(len(code_lines) * 32 + 20, 400)
            _draw_rect(draw, x - 10, cy - 5, max_w + 20, code_h, self.c["code_bg"])
            _draw_rect(draw, x - 10, cy - 5, max_w + 20, code_h, self.c["code_border"])
            for cl in code_lines:
                draw.text((x + 10, cy + 5), cl[:120], font=code_font, fill=self.c["body"])
                cy += 30


# ---------------------------------------------------------------------------
# Video assembly
# ---------------------------------------------------------------------------

def _make_slide_clip(pil_img: Image.Image, duration: float):
    """Create a moviepy clip from a PIL image with Ken Burns zoom."""
    from moviepy import ImageClip
    from moviepy.video.fx import Resize

    arr = np.array(pil_img)
    clip = ImageClip(arr).with_duration(duration)

    # Subtle Ken Burns: zoom from 100% → 108% over the duration
    zoom_func = lambda t: 1.0 + 0.08 * min(t / duration, 1.0)
    clip = clip.with_effects([Resize(zoom_func)])

    return clip


async def generate_video(
    slides_content: list[dict],
    theme_id: str,
    task_id: str,
    slide_audio_paths: Optional[list[str]] = None,
) -> str:
    """
    Generate MP4 video from slide content with per-slide audio sync.

    Each slide gets its own TTS audio → precise per-slide duration.
    Subtitles (notes text) are rendered directly on each frame.

    Args:
        slides_content: [{"title", "content", "notes"}, ...]
        theme_id: Theme key
        task_id: Output filename
        slide_audio_paths: Per-slide TTS audio paths, same length as slides_content.
                           None entries fall back to default duration.

    Returns:
        Path to output .mp4 file
    """
    from moviepy import concatenate_videoclips, AudioFileClip

    slides = slides_content or [{"title": "内容", "content": "无内容"}]
    renderer = SlideRenderer(theme_id)
    n = len(slides)

    if slide_audio_paths is None:
        slide_audio_paths = [None] * n

    # --- Render each slide + determine per-slide duration from its audio ---
    logger.info(f"[Video] 开始渲染 {n} 页")
    audio_clips: list = []
    clips: list = []

    for i, slide in enumerate(slides):
        title = slide.get("title", "")
        content = slide.get("content", "")
        notes = slide.get("notes", "")

        # 1. Render slide image
        if i == 0:
            img = renderer.render_title(title, content[:300])
        else:
            img = renderer.render_content(title, content, i + 1)
        _draw_subtitle_bar(img, notes, renderer.c)

        # 2. Get per-slide audio & duration
        duration = 6.0  # default fallback
        slide_audio_clip = None
        if i < len(slide_audio_paths) and slide_audio_paths[i]:
            try:
                slide_audio_clip = AudioFileClip(slide_audio_paths[i])
                duration = slide_audio_clip.duration + 0.5  # small breathing room
                audio_clips.append(slide_audio_clip)
            except Exception as e:
                logger.warning(f"[Video] 第{i+1}页音频加载失败: {e}")

        # 3. Create video clip with precise duration
        clip = _make_slide_clip(img, duration)
        if slide_audio_clip:
            clip = clip.with_audio(slide_audio_clip)
        clips.append(clip)

        logger.debug(f"[Video]  第{i+1}页 '{title[:20]}': {duration:.1f}s")

    total_duration = sum(c.duration for c in clips)
    logger.info(f"[Video] 合成视频: {n} 页, {total_duration:.1f}s")

    # --- Concatenate (each clip carries its own audio) ---
    final_video = concatenate_videoclips(clips, method="chain")

    # --- Write output ---
    output_dir = DATA_DIR / "videos"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = str(output_dir / f"{task_id}.mp4")

    logger.info(f"[Video] 输出: {output_path}")
    import asyncio
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: final_video.write_videofile(
            output_path,
            fps=24,
            codec="libx264",
            audio_codec="aac",
            bitrate="3000k",
            threads=2,
            preset="medium",
            logger=None,
        ),
    )

    final_video.close()
    for ac in audio_clips:
        try:
            ac.close()
        except Exception:
            pass
    logger.info(f"[Video] 完成: {output_path}")
    return output_path
