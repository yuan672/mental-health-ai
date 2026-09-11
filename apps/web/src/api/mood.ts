import type {
  CreateMoodEntryRequest,
  CreateMoodEntryResponse,
  DeleteMoodEntryResponse,
  DeleteMoodHistoryResponse,
  MoodCreationStatusResponse,
  MoodEntryResponse,
  MoodHistoryResponse,
  ProfileResponse,
  UpdateMoodEntryRequest,
} from '@mental-health/types';
import { apiRequest } from './client';
import {
  createMoodEntryResponseSchema,
  deleteMoodEntryResponseSchema,
  deleteMoodHistoryResponseSchema,
  moodCreationStatusResponseSchema,
  moodEntryResponseSchema,
  moodHistoryResponseSchema,
  profileResponseSchema,
} from './schemas';

export function createMoodEntry(
  body: CreateMoodEntryRequest,
  signal?: AbortSignal,
): Promise<CreateMoodEntryResponse> {
  return apiRequest('/mood-entries', createMoodEntryResponseSchema, {
    method: 'POST',
    csrf: true,
    body,
    ...(signal ? { signal } : {}),
  });
}

export function getMoodCreationStatus(
  clientRequestId: string,
  signal?: AbortSignal,
): Promise<MoodCreationStatusResponse> {
  return apiRequest(
    `/mood-entries/creation-status/${encodeURIComponent(clientRequestId)}`,
    moodCreationStatusResponseSchema,
    signal ? { signal } : {},
  );
}

export function listMoodEntries(
  days: 7 | 30,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<MoodHistoryResponse> {
  const query = new URLSearchParams({ days: String(days), limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return apiRequest(
    `/mood-entries?${query.toString()}`,
    moodHistoryResponseSchema,
    signal ? { signal } : {},
  );
}

export function getMoodEntry(id: string, signal?: AbortSignal): Promise<MoodEntryResponse> {
  return apiRequest(
    `/mood-entries/${encodeURIComponent(id)}`,
    moodEntryResponseSchema,
    signal ? { signal } : {},
  );
}

export function updateMoodEntry(
  id: string,
  body: UpdateMoodEntryRequest,
  signal?: AbortSignal,
): Promise<MoodEntryResponse> {
  return apiRequest(`/mood-entries/${encodeURIComponent(id)}`, moodEntryResponseSchema, {
    method: 'PATCH',
    csrf: true,
    body,
    ...(signal ? { signal } : {}),
  });
}

export function deleteMoodEntry(
  id: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<DeleteMoodEntryResponse> {
  return apiRequest(`/mood-entries/${encodeURIComponent(id)}`, deleteMoodEntryResponseSchema, {
    method: 'DELETE',
    csrf: true,
    body: { expectedRevision },
    ...(signal ? { signal } : {}),
  });
}

export function deleteAllMoodEntries(signal?: AbortSignal): Promise<DeleteMoodHistoryResponse> {
  return apiRequest('/mood-entries', deleteMoodHistoryResponseSchema, {
    method: 'DELETE',
    csrf: true,
    ...(signal ? { signal } : {}),
  });
}

export function getProfile(signal?: AbortSignal): Promise<ProfileResponse> {
  return apiRequest('/profile', profileResponseSchema, signal ? { signal } : {});
}
