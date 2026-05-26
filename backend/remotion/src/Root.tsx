import React from "react";
import { Composition } from "remotion";
import { VideoComposition } from "./VideoComposition";
import type { VideoInputProps } from "./types";

const defaultProps: VideoInputProps = {
  fps: 30,
  theme: "tech_blue",
  slides: [
    {
      id: 1,
      title: "标题",
      content: "副标题",
      notes: "",
      audioUrl: null,
      durationFrames: 90,
      layout: "title",
    },
    {
      id: 2,
      title: "内容",
      content: "内容正文",
      notes: "演讲稿",
      audioUrl: null,
      durationFrames: 150,
      layout: "content",
    },
  ],
};

export const Root: React.FC = () => (
  <Composition
    id="TechVideo"
    component={VideoComposition}
    durationInFrames={240}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => {
      const total = (props.slides || []).reduce(
        (acc: number, s: { durationFrames: number }) => acc + s.durationFrames,
        0,
      );
      return { durationInFrames: Math.max(total, 30), fps: props.fps || 30 };
    }}
  />
);
