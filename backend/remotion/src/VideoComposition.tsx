import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, Audio, interpolate, useCurrentFrame } from "remotion";
import { TitleSlide } from "./slides/TitleSlide";
import { ContentSlide } from "./slides/ContentSlide";
import { CodeSlide } from "./slides/CodeSlide";
import { SummarySlide } from "./slides/SummarySlide";
import { getTheme } from "./theme";
import type { VideoInputProps, RemotionSlide } from "./types";

function SlideRenderer({ slide, themeId }: { slide: RemotionSlide; themeId: string }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  const props = { title: slide.title, content: slide.content, notes: slide.notes, themeId };

  return (
    <AbsoluteFill style={{ opacity }}>
      {slide.layout === "title" && <TitleSlide {...props} />}
      {slide.layout === "code" && <CodeSlide {...props} />}
      {slide.layout === "summary" && <SummarySlide {...props} />}
      {slide.layout === "content" && <ContentSlide {...props} />}
    </AbsoluteFill>
  );
}

export const VideoComposition: React.FC<VideoInputProps> = ({ slides, theme }) => {
  const offsets = useMemo(() => {
    let cur = 0;
    return slides.map((s) => {
      const start = cur;
      cur += s.durationFrames;
      return start;
    });
  }, [slides]);

  return (
    <AbsoluteFill>
      {slides.map((slide, i) => (
        <Sequence key={slide.id} from={offsets[i]} durationInFrames={slide.durationFrames}>
          <SlideRenderer slide={slide} themeId={theme} />
          {slide.audioUrl && <Audio src={slide.audioUrl} />}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
