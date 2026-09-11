import type { ApiSuccessResponse } from './index.js';
import type { KnowledgeContentOrigin } from './knowledge.js';

export const KNOWLEDGE_REFERENCES_CAPABILITY_HEADER = 'X-MH-Knowledge-References' as const;
export const KNOWLEDGE_REFERENCES_CAPABILITY_VERSION = '1' as const;

export type AiDeliveryMode = 'immediate' | 'commit_with_references';
export type KnowledgeReferenceAvailability = 'currently_published' | 'no_longer_available';
export type KnowledgeReferenceReviewStatus = 'unverified' | 'source_verified';

type KnowledgeReferenceSourceBase = {
  ordinal: number;
  publisherName: string;
  sourceTitle: string;
  sourcePublishedAt: string | null;
  sourceVersionLabel: string | null;
  sourceLocator: string | null;
  retrievedAt: string;
};

export type AvailableKnowledgeReferenceSource = KnowledgeReferenceSourceBase & {
  linkState: 'available';
  sourceUrl: string;
};

export type UnavailableKnowledgeReferenceSource = KnowledgeReferenceSourceBase & {
  linkState: 'unavailable';
};

export type KnowledgeReferenceSource =
  AvailableKnowledgeReferenceSource | UnavailableKnowledgeReferenceSource;

export type KnowledgeReference = {
  articleKey: string;
  title: string;
  version: number;
  contentOrigin: KnowledgeContentOrigin;
  reviewStatus: KnowledgeReferenceReviewStatus;
  reviewedAt: string | null;
  availability: KnowledgeReferenceAvailability;
  sources: KnowledgeReferenceSource[];
};

export type ConversationMessageV2 = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sequence: number;
  createdAt: string;
  knowledgeReferences: KnowledgeReference[];
};

export type ConversationMessagesResponseV2 = ApiSuccessResponse<{
  messages: ConversationMessageV2[];
  nextCursor: string | null;
}>;
