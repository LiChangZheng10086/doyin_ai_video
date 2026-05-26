import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { getTheme } from "../theme";

interface Props { title: string; content: string; notes: string; themeId: string }

export const SummarySlide: React.FC<Props> = ({ title, content, themeId }) => {
  const c = getTheme(themeId);
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const scale = interpolate(frame, [0, 25], [0.85, 1], { extrapolateRight: "clamp" });

  const lines = content.split("\n").filter((l) => l.trim());

  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 6, backgroundColor: c.cyan }} />
      <div style={{ position: "absolute", bottom: 15, left: 0, right: 0, height: 15, backgroundColor: c.glow, opacity: 0.4 }} />

      <div
        style={{
          position: "absolute", left: 80, right: 80, top: 400,
          opacity, transform: `scale(${scale})`,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 48, fontWeight: 700, color: c.title, marginBottom: 20 }}>
          {title || "总结"}
        </div>
        <div style={{ width: 100, height: 4, backgroundColor: c.cyan, margin: "0 auto 40px" }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {lines.map((line, i) => (
            <div
              key={i}
              style={{
                fontSize: 28, color: c.body, lineHeight: 1.6,
                opacity: interpolate(frame, [20 + i * 5, 30 + i * 5], [0, 1], { extrapolateRight: "clamp" }),
              }}
            >
              {line.startsWith("- ") ? line.slice(2) : line}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
