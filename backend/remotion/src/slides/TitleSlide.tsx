import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { getTheme } from "../theme";

interface Props { title: string; content: string; notes: string; themeId: string }

export const TitleSlide: React.FC<Props> = ({ title, content, themeId }) => {
  const c = getTheme(themeId);
  const frame = useCurrentFrame();

  const titleOpacity = interpolate(frame, [0, 25], [0, 1], { extrapolateRight: "clamp" });
  const titleY = interpolate(frame, [0, 25], [60, 0], { extrapolateRight: "clamp" });
  const subOpacity = interpolate(frame, [15, 40], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: c.bg, padding: 80 }}>
      {/* Top accent line */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 6, backgroundColor: c.cyan }} />

      {/* Glow bar at bottom */}
      <div style={{ position: "absolute", bottom: 15, left: 0, right: 0, height: 15, backgroundColor: c.glow, opacity: 0.6 }} />

      {/* Background decorations */}
      <div style={{ position: "absolute", top: 80, right: -100, width: 400, height: 400, borderRadius: "50%", backgroundColor: c.bgAccent, opacity: 0.5 }} />
      <div style={{ position: "absolute", bottom: 200, left: -80, width: 300, height: 300, borderRadius: "50%", backgroundColor: c.bgAccent, opacity: 0.4 }} />

      {/* Left accent bar */}
      <div style={{ position: "absolute", left: 60, top: 350, width: 6, height: 700, backgroundColor: c.primary, opacity: 0.7 }} />

      {/* Title */}
      <div style={{ position: "absolute", left: 120, top: 480, opacity: titleOpacity, transform: `translateY(${titleY}px)` }}>
        <div style={{ fontSize: 56, fontWeight: 700, color: c.title, lineHeight: 1.3, maxWidth: 840 }}>
          {title}
        </div>
        <div style={{ marginTop: 16, width: Math.min(title.length * 28 + 40, 880), height: 4, backgroundColor: c.cyan }} />
      </div>

      {/* Subtitle */}
      {content && (
        <div style={{ position: "absolute", left: 120, top: 630, opacity: subOpacity }}>
          <div style={{ fontSize: 24, color: c.subtitle, lineHeight: 1.6, maxWidth: 800 }}>
            {content.slice(0, 200)}
          </div>
        </div>
      )}

      {/* Bottom-right decoration */}
      <div style={{ position: "absolute", bottom: 70, right: 50, width: 280, height: 4, backgroundColor: c.primary, opacity: 0.5 }} />
      <div style={{ position: "absolute", bottom: 100, right: 50, width: 150, height: 4, backgroundColor: c.cyan }} />
    </AbsoluteFill>
  );
};
