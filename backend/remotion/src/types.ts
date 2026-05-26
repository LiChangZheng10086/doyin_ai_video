// Data contract between Python backend and Remotion

export type SlideLayout = "title" | "content" | "code" | "summary";

export interface RemotionSlide {
  id: number;
  title: string;
  content: string;
  notes: string;
  audioUrl: string | null;
  durationFrames: number;
  layout: SlideLayout;
}

export type ThemeId = "tech_blue" | "clean_white" | "warm_orange";

export interface VideoInputProps {
  slides: RemotionSlide[];
  theme: ThemeId;
  fps: number;
}
