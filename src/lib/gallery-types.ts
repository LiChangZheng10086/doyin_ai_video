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
  generated?: {
    id: string;
    draftHash: string;
    sourceFingerprint: string;
    hashes: string[];
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
