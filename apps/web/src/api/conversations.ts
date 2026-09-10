import type {
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationMessagesResponse,
  DeleteConversationHistoryResponse,
  DeleteConversationResponse,
} from '@mental-health/types';
import { apiRequest } from './client';
import {
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  conversationMessagesResponseSchema,
  deleteConversationResponseSchema,
  deleteHistoryResponseSchema,
} from './schemas';

function pagedPath(path: string, cursor?: string | null): string {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return `${path}?${query.toString()}`;
}

export function listConversations(
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<ConversationListResponse> {
  return apiRequest(
    pagedPath('/conversations', cursor),
    conversationListResponseSchema,
    signal ? { signal } : {},
  );
}

export function getConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationDetailResponse> {
  return apiRequest(
    `/conversations/${encodeURIComponent(conversationId)}`,
    conversationDetailResponseSchema,
    signal ? { signal } : {},
  );
}

export function listMessages(
  conversationId: string,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<ConversationMessagesResponse> {
  return apiRequest(
    pagedPath(`/conversations/${encodeURIComponent(conversationId)}/messages`, cursor),
    conversationMessagesResponseSchema,
    signal ? { signal } : {},
  );
}

export function saveConversation(conversationId: string): Promise<ConversationDetailResponse> {
  return apiRequest(
    `/conversations/${encodeURIComponent(conversationId)}/save`,
    conversationDetailResponseSchema,
    { method: 'POST', csrf: true },
  );
}

export function deleteConversation(conversationId: string): Promise<DeleteConversationResponse> {
  return apiRequest(
    `/conversations/${encodeURIComponent(conversationId)}`,
    deleteConversationResponseSchema,
    { method: 'DELETE', csrf: true },
  );
}

export function deleteAllConversations(): Promise<DeleteConversationHistoryResponse> {
  return apiRequest('/conversations', deleteHistoryResponseSchema, {
    method: 'DELETE',
    csrf: true,
  });
}
