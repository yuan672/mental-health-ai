import type { KnowledgeReference, KnowledgeReferenceSource } from '@mental-health/types';
import type { StoredKnowledgeReference } from '../knowledge/knowledge-message-reference.repository';
import { knowledgeReferenceSchema } from '../ai/ai-public.schemas';

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function safeSourceUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username.length > 0 || parsed.password.length > 0) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function toPublicSource(
  source: StoredKnowledgeReference['sources'][number],
): KnowledgeReferenceSource {
  const base = {
    ordinal: source.ordinal,
    publisherName: source.publisherName,
    sourceTitle: source.sourceTitle,
    sourcePublishedAt: toIso(source.sourcePublishedAt),
    sourceVersionLabel: source.sourceVersionLabel,
    sourceLocator: source.sourceLocator,
    retrievedAt: source.retrievedAt.toISOString(),
  };
  const sourceUrl = safeSourceUrl(source.sourceUrl);
  return sourceUrl
    ? { ...base, linkState: 'available', sourceUrl }
    : { ...base, linkState: 'unavailable' };
}

export function toPublicKnowledgeReference(
  reference: StoredKnowledgeReference,
): KnowledgeReference {
  return knowledgeReferenceSchema.parse({
    articleKey: reference.articleKey,
    title: reference.title,
    version: reference.version,
    contentOrigin: reference.contentOrigin,
    reviewStatus: reference.reviewStatus,
    reviewedAt: toIso(reference.reviewedAt),
    availability:
      reference.publicationStatus === 'published' ? 'currently_published' : 'no_longer_available',
    sources: [...reference.sources]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(toPublicSource),
  });
}
