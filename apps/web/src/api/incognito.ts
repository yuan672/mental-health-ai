import type {
  CreateIncognitoContextResponse,
  EndIncognitoContextResponse,
} from '@mental-health/types';
import { apiRequest } from './client';
import { createIncognitoContextResponseSchema, endIncognitoContextResponseSchema } from './schemas';

export function createIncognitoContext(
  signal?: AbortSignal,
): Promise<CreateIncognitoContextResponse> {
  return apiRequest('/incognito-contexts', createIncognitoContextResponseSchema, {
    method: 'POST',
    csrf: true,
    ...(signal ? { signal } : {}),
  });
}

export function endIncognitoContext(
  contextId: string,
  signal?: AbortSignal,
): Promise<EndIncognitoContextResponse> {
  return apiRequest(
    `/incognito-contexts/${encodeURIComponent(contextId)}`,
    endIncognitoContextResponseSchema,
    { method: 'DELETE', csrf: true, ...(signal ? { signal } : {}) },
  );
}
