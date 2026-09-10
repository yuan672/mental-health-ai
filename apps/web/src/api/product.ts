import type { CapabilitiesResponse, QuotaResponse } from '@mental-health/types';
import { apiRequest } from './client';
import { capabilitiesResponseSchema, quotaResponseSchema } from './schemas';

export function getCapabilities(signal?: AbortSignal): Promise<CapabilitiesResponse> {
  return apiRequest('/capabilities', capabilitiesResponseSchema, signal ? { signal } : {});
}

export function getQuota(signal?: AbortSignal): Promise<QuotaResponse> {
  return apiRequest('/quota', quotaResponseSchema, signal ? { signal } : {});
}
