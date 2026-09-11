import type { ApiSuccessResponse } from './index.js';

export const KNOWLEDGE_CONTENT_ORIGINS = ['curated', 'synthetic_fixture'] as const;
export const KNOWLEDGE_REVIEW_STATUSES = [
  'unverified',
  'source_verified',
  'professional_reviewed',
] as const;

export type KnowledgeContentOrigin = (typeof KNOWLEDGE_CONTENT_ORIGINS)[number];
export type KnowledgeReviewStatus = (typeof KNOWLEDGE_REVIEW_STATUSES)[number];

export type KnowledgeContentBlock =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; style: 'ordered' | 'unordered'; items: string[] }
  | { type: 'callout'; tone: 'information' | 'important'; text: string };

export type KnowledgeArticleSource = {
  publisherName: string;
  sourceTitle: string;
  sourceUrl: string;
  sourcePublishedAt: string | null;
  sourceVersionLabel: string | null;
  sourceLocator: string | null;
  retrievedAt: string;
};

export type KnowledgeArticleSummary = {
  articleKey: string;
  title: string;
  summary: string;
  version: number;
  contentOrigin: KnowledgeContentOrigin;
  reviewStatus: KnowledgeReviewStatus;
  reviewedAt: string | null;
  publishedAt: string;
  sourcePublishers: string[];
};

export type KnowledgeArticleDetail = KnowledgeArticleSummary & {
  contentBlocks: KnowledgeContentBlock[];
  sources: KnowledgeArticleSource[];
};

export type KnowledgeArticleListResponse = ApiSuccessResponse<{
  items: KnowledgeArticleSummary[];
  nextCursor: string | null;
}>;

export type KnowledgeArticleDetailResponse = ApiSuccessResponse<{
  article: KnowledgeArticleDetail;
}>;
