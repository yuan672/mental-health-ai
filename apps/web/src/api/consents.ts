import type { ConsentHistoryResponse } from '@mental-health/types';
import { apiRequest } from './client';
import { consentHistoryResponseSchema } from './schemas';

export function getConsentHistory(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ConsentHistoryResponse> {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return apiRequest(
    `/consents?${query.toString()}`,
    consentHistoryResponseSchema,
    signal ? { signal } : {},
  );
}
