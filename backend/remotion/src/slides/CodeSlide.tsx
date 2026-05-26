import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { getTheme } from "../theme";

interface Props { title: string; content: string; notes: string; themeId: string }

export const CodeSlide: React.FC<Props> = ({ title, content, themeId }) => {
  const c = getTheme(themeId);
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  // Extract code from content (between ``` markers or use whole content)
  const codeMatch = content.match(/```(?:\w+)?\n([\s\S]*?)```/);
  const code = codeMatch ? codeMatch[1].trim() : content;

  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 6, backgroundColor: c.cyan }} />
      <div style={{ position: "absolute", left: 50, top: 30, width: 6, height: 1860, backgroundColor: c.primary, opacity: 0.4 }} />

      <div style={{ position: "absolute", left: 80, top: 80, right: 80, opacity }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: c.heading, marginBottom: 20 }}>{title}</div>

        <div style={{ backgroundColor: c.codeBg, borderRadius: 8, border: `1px solid ${c.codeBorder}`, padding: "20px 24px", overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#FF5F56" }} />
            <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#FFBD2E" }} />
            <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#27C93F" }} />
          </div>
          <pre style={{ fontSize: 20, fontFamily: "monospace", color: c.body, lineHeight: 1.6, whiteSpace: "pre-wrap", margin: 0 }}>
            {code}
          </pre>
        </div>
      </div>
    </AbsoluteFill>
  );
};
