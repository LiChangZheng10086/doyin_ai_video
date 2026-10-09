export interface ResearchConfig { jinaEnabled: boolean; exaEnabled: boolean }
export type ResearchProvider = 'direct' | 'jina' | 'exa';
export type ResearchErrorCode = 'disabled' | 'not_found' | 'unsafe_url' | 'blocked' | 'rate_limited' | 'timeout' | 'too_large' | 'unsupported_format' | 'upstream';
export class ResearchError extends Error {
  constructor(readonly status: number, readonly code: ResearchErrorCode, message: string, readonly retryAfterSeconds?: number) { super(message); }
}
export interface ResearchCandidate {
  id: string; title: string; url: string; domain: string; snippet?: string; publishedAt?: string; provider: ResearchProvider;
}
export interface ResearchSearchResult {
  searchId: string; query: string; candidates: ResearchCandidate[]; fetchedAt: string; expiresAt: string; cached: boolean;
}
export interface ResearchReadResult {
  readId: string; url: string; title: string; kind: 'article' | 'topic' | 'unreadable'; status: 'readable' | 'needs_material';
  text: string; excerpt?: string; publishedAt?: string; readAt: string; expiresAt: string; hash: string; truncated: boolean;
  provider: ResearchProvider; candidates: ResearchCandidate[]; error?: {code: ResearchErrorCode; message: string};
}
export type ResearchContent = Omit<ResearchReadResult, 'readId' | 'expiresAt'>;
export type ResearchReadInput = {url: string} | {searchId: string; candidateId: string};
export interface ResearchSelection { readId: string; hash: string }
export interface ResearchStatus {
  config: ResearchConfig; configurationSource: 'desktop' | 'environment';
  providers: Record<'jina' | 'exa', {state:'unverified'|'ok'|'error'; checkedAt?:string; message?:string}>;
}
export function normalizeResearchConfig(value?: Partial<ResearchConfig>): ResearchConfig {
  return {jinaEnabled:value?.jinaEnabled === true, exaEnabled:value?.exaEnabled === true};
}
export function researchEnvironment(env: NodeJS.ProcessEnv): ResearchConfig {
  return {jinaEnabled:env.RESEARCH_JINA_ENABLED === '1',exaEnabled:env.RESEARCH_EXA_ENABLED === '1'};
}
