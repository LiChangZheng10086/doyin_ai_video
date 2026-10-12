export interface GalleryImage {
  mainTime: number;
  times: number[];
  bandTop: number;
  bandBottom: number;
  mainFraction: number;
  compact?: boolean;
  filmstrip?: boolean;
  translatedCaptions?: string[];
  mainCrop?: { left: number; right: number; top: number; bottom: number };
}

export interface GalleryDraft {
  title: string;
  description: string;
  hashtags: string[];
  bgm?: string;
  images: GalleryImage[];
}

export interface Gallery extends GalleryDraft {
  contentPlan?: GalleryContentPlan;
  operation?: GalleryOperation;
  mode?: 'native' | 'translated';
  translation?: GalleryTranslation;
  id: string;
  sourceJobId: string;
  version: number;
  status: 'draft' | 'running' | 'ready' | 'failed';
  error?: string;
  copyError?: string;
  copyReference?: { transcriptHash: string; sourceFingerprint: string; translationHash?: string; notes: string[] };
  plan?: GalleryPlan;
  appliedPlanId?: string;
  generated?: {
    id: string;
    draftHash: string;
    sourceFingerprint: string;
    hashes: string[];
    transcriptHash?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface GalleryPreview {
  previewRevision: string;
  bgm?: string;
  imageCount: number;
  violations: { message: string }[];
  copyLimits: { titleMax: number; descriptionMax: number; hashtagMax: number };
}

export interface GallerySource {
  width: number;
  height: number;
  duration: number;
  imageLimit?: number;
  copyLimits?: GalleryPreview['copyLimits'];
}

export interface GalleryQuote {
  originalText?: string;
  segmentIndex: number;
  text: string;
  start: number;
  end: number;
  verification?: 'ocr' | 'pixels' | 'translation';
}

export interface GalleryPlan {
  mode?: 'native' | 'translated';
  scope?: 'full' | 'range' | 'selection';
  coverage?: { start: number; end: number; duration: number; totalSegments: number; selectedSegments: number };
  id: string;
  transcriptHash: string;
  previewHashes?: string[];
  sourceFingerprint: string;
  images: { title: string; quotes: GalleryQuote[]; image: GalleryImage }[];
  warnings: string[];
  blockedReason?: string;
  excluded: { segmentIndex: number; reason: string }[];
}

export interface GalleryTranslationCue {
  segmentIndex: number;
  original: string;
  text: string;
  start: number;
  end: number;
}

export interface GalleryTranslation {
  transcriptHash: string;
  sourceFingerprint: string;
  start: number;
  end: number;
  cues: GalleryTranslationCue[];
}

export interface GalleryPlanInput {
  version: number;
  fullVideo?: boolean;
  targetLines?: number;
  bandTop?: number;
  bandBottom?: number;
  contentPlanId?: string;
  contentConfirmed?: boolean;
}

export interface GalleryContentItem extends GalleryQuote {
  id: string;
  selected: boolean;
  reason: string;
}

export interface GalleryContentPlan {
  id: string;
  transcriptHash: string;
  sourceFingerprint: string;
  targetLines: number;
  items: GalleryContentItem[];
  estimatedImages: number;
  method: 'manual' | 'ai';
  createdAt: string;
  confirmedAt?: string;
}

export interface GalleryOperation {
  id: string;
  actorId?: string;
  kind: 'content' | 'candidates' | 'render';
  status: 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'interrupted';
  stage: 'content' | 'ocr' | 'candidates' | 'render' | 'copy';
  completed: number;
  total: number;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export interface GalleryOperationInput extends GalleryPlanInput {
  kind: GalleryOperation['kind'];
  planId?: string;
  subtitlesConfirmed?: boolean;
}

export interface GalleryWorkControl {
  checkpoint?: () => Promise<void>;
  progress?: (completed: number, total: number) => Promise<void>;
}
