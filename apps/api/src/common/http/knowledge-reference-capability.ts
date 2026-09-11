import type { Response } from 'express';
import { ValidationError } from '../errors';

export const KNOWLEDGE_REFERENCES_CAPABILITY_HEADER = 'X-MH-Knowledge-References';
export const KNOWLEDGE_REFERENCES_CAPABILITY_VERSION = '1';

export type KnowledgeReferenceRepresentation = 'v1' | 'v2';

export function parseKnowledgeReferenceCapability(
  headerValue: string | string[] | undefined,
): KnowledgeReferenceRepresentation {
  if (headerValue === undefined || headerValue === '') return 'v1';
  if (headerValue === KNOWLEDGE_REFERENCES_CAPABILITY_VERSION) return 'v2';
  throw new ValidationError('不支持的知识引用协议版本');
}

export function applyKnowledgeReferenceResponseHeaders(
  response: Pick<Response, 'setHeader' | 'vary'>,
  representation: KnowledgeReferenceRepresentation,
): void {
  response.vary(KNOWLEDGE_REFERENCES_CAPABILITY_HEADER);
  if (representation === 'v2') {
    response.setHeader(
      KNOWLEDGE_REFERENCES_CAPABILITY_HEADER,
      KNOWLEDGE_REFERENCES_CAPABILITY_VERSION,
    );
  }
}
