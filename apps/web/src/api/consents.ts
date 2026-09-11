import type {
  ConsentHistoryResponse,
  ConsentMutationRequest,
  ConsentMutationResponse,
} from '@mental-health/types';
import { apiRequest } from './client';
import { consentHistoryResponseSchema, consentMutationResponseSchema } from './schemas';

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

export function mutateConsent(
  request: ConsentMutationRequest,
  signal?: AbortSignal,
): Promise<ConsentMutationResponse> {
  return apiRequest('/consents', consentMutationResponseSchema, {
    method: 'POST',
    body: request,
    csrf: true,
    ...(signal ? { signal } : {}),
  });
}
