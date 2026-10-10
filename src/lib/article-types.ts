import type { ArticleDraft } from './article-draft.js';
import type { ArticleSourceRead } from './article-sources.js';

export const ARTICLE_STEPS = ['diagnose', 'evidence', 'outline', 'draft', 'review', 'illustrations'] as const;
export type ArticleStep = typeof ARTICLE_STEPS[number];
export interface ArticleTopic {
  id: string; title: string; audience: string; question: string; thesis: string;
  hook: string; angle: string; researchQuestions: string[];
}
export interface ArticleFact { id: string; claim: string; sourceId: string; quote: string }
export interface ArticleOutline {
  thesis: string; opening: string; sections: Array<{ heading: string; points: string[]; factIds: string[] }>; gaps: string[];
}
export interface ResearchDraft extends ArticleDraft { sections: Array<ArticleDraft['sections'][number] & { factIds: string[] }> }
export interface ArticleIllustration { purpose: string; section: number; caption: string; prompt: string }
export interface ArticleMaterial extends ArticleSourceRead { id: string; included: boolean; kind: 'web' | 'text'; depth: 0 | 1 }
export interface ArticleRecord {
  id: string; version: number; keyword: string; createdAt: string; updatedAt: string;
  requirements: { audience: string; purpose: string; viewpoint: string; styleSample: string; domain: string; structure: string; length: string };
  hotspot?: { sourceId: string; itemId: string; title: string; url: string; fetchedAt?: string };
  topics: ArticleTopic[]; selectedTopic?: string; sources: ArticleMaterial[];
  facts: ArticleFact[]; issues: string[]; outline?: ArticleOutline; draft?: ResearchDraft;
  revision?: ResearchDraft; reviewNotes: string[]; illustrations: ArticleIllustration[];
  adopted: 'draft' | 'revision'; reviewed: boolean; materialConfirmed: boolean; outlineConfirmed: boolean;
  author: string; digest: string; coverAssetId: string; bodyImageAssetIds: string[];
  layoutTemplate?: string;
  bodyImagePlacements?: Array<{ section: number; caption?: string }>;
  steps: Record<ArticleStep, 'pending' | 'running' | 'succeeded' | 'failed'>;
  running?: ArticleStep | 'read' | 'package'; error?: string;
  reference: Partial<Record<ArticleStep, unknown>>;
}
export interface ArticlePreview { version: number; previewRevision: string; html: string; title: string; sourceCount: number }
