export interface GalleryImage {
  mainTime: number;
  times: number[];
  bandTop: number;
  bandBottom: number;
  mainFraction: number;
  mainCrop?: { left: number; right: number; top: number; bottom: number };
}

export interface GalleryDraft {
  title: string;
  description: string;
  hashtags: string[];
  images: GalleryImage[];
}

export interface Gallery extends GalleryDraft {
  id: string;
  sourceJobId: string;
  version: number;
  status: 'draft' | 'running' | 'ready' | 'failed';
  error?: string;
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
  imageCount: number;
  violations: { message: string }[];
  copyLimits: { titleMax: number; descriptionMax: number; hashtagMax: number };
}

export interface GallerySource {
  width: number;
  height: number;
  duration: number;
  imageLimit?: number;
}

export interface GalleryQuote {
  segmentIndex: number;
  text: string;
  start: number;
  end: number;
}

export interface GalleryPlan {
  id: string;
  transcriptHash: string;
  previewHashes?: string[];
  sourceFingerprint: string;
  images: { title: string; quotes: GalleryQuote[]; image: GalleryImage }[];
  warnings: string[];
  excluded: { segmentIndex: number; reason: string }[];
}

export interface GalleryPlanInput {
  version: number;
  targetLines?: 6 | 7 | 8 | 9;
  bandTop?: number;
  bandBottom?: number;
}
