import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { getTheme } from "../theme";

interface Props { title: string; content: string; notes: string; themeId: string }

function wrapLines(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const p of text.split("\n")) {
    if (!p) { lines.push(""); continue; }
    let line = "";
    for (const ch of p) {
      const test = line + ch;
      if (test.length > maxChars && line) { lines.push(line); line = ch; }
      else line = test;
    }
    if (line) lines.push(line);
  }
  return lines;
}

export const ContentSlide: React.FC<Props> = ({ title, content, themeId }) => {
  const c = getTheme(themeId);
  const frame = useCurrentFrame();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  const contentOpacity = interpolate(frame, [10, 35], [0, 1], { extrapolateRight: "clamp" });

  // Parse markdown-like content
  const lines = content.split("\n");
  let bodyY = 200;

  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      {/* Top accent */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 6, backgroundColor: c.cyan }} />

      {/* Left bar */}
      <div style={{ position: "absolute", left: 50, top: 30, width: 6, height: 1860, backgroundColor: c.primary, opacity: 0.4 }} />
      <div style={{ position: "absolute", left: 50, top: 30, width: 3, height: 1860, backgroundColor: c.cyan }} />

      {/* Title */}
      <div style={{ position: "absolute", left: 120, top: 80, opacity: titleOpacity }}>
        <div style={{ fontSize: 36, fontWeight: 700, color: c.heading }}>{title}</div>
        <div style={{ marginTop: 12, width: 840, height: 2, backgroundColor: c.primary + "40" }} />
      </div>

      {/* Content */}
      <div style={{ position: "absolute", left: 120, top: 170, right: 120, opacity: contentOpacity, fontSize: 26, color: c.body, lineHeight: 1.7 }}>
        {lines.map((line, i) => {
          const s = line.trim();
          if (!s) return <div key={i} style={{ height: 20 }} />;

          if (s.startsWith("### ")) return <div key={i} style={{ fontSize: 24, fontWeight: 700, color: c.heading, marginTop: 10 }}>{s.slice(4)}</div>;
          if (s.startsWith("## ")) return <div key={i} style={{ fontSize: 28, fontWeight: 700, color: c.heading, marginTop: 10 }}>{s.slice(3)}</div>;
          if (s.startsWith("# ")) return <div key={i} style={{ fontSize: 34, fontWeight: 700, color: c.heading, marginTop: 10 }}>{s.slice(2)}</div>;
          if (s.startsWith("---")) return <div key={i} style={{ height: 2, backgroundColor: c.primary + "40", margin: "16px 0" }} />;

          if (s.startsWith("- ") || s.startsWith("❍ ")) {
            const text = s.startsWith("- ") ? s.slice(2) : s.slice(1);
            return (
              <div key={i} style={{ display: "flex", gap: 12, marginTop: 4 }}>
                <span style={{ color: c.bullet, flexShrink: 0 }}>◆</span>
                <span>{text}</span>
              </div>
            );
          }

          if (s.startsWith("```")) {
            const codeContent = lines.slice(i + 1).filter(l => !l.trim().startsWith("```"));
            return (
              <div key={i} style={{ marginTop: 10, padding: "10px 14px", backgroundColor: c.codeBg, borderLeft: `3px solid ${c.codeBorder}`, borderRadius: 4, fontSize: 18, fontFamily: "monospace", whiteSpace: "pre", overflowX: "auto" }}>
                {codeContent.join("\n")}
              </div>
            );
          }

          // Regular text
          return <div key={i} style={{ marginTop: 4 }}>{s}</div>;
        })}
      </div>
    </AbsoluteFill>
  );
};
