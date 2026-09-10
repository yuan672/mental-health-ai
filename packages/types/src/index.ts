export type AppEnvironment = 'development' | 'staging' | 'production';

export type ApiErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};

export type ApiSuccessResponse<T> = {
  success: true;
  data: T;
};

export type ConversationMetadata = {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  isSaved: boolean;
};

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sequence: number;
  createdAt: string;
};

export type ConversationListResponse = ApiSuccessResponse<{
  conversations: ConversationMetadata[];
  nextCursor: string | null;
}>;

export type ConversationDetailResponse = ApiSuccessResponse<{
  conversation: ConversationMetadata;
}>;

export type ConversationMessagesResponse = ApiSuccessResponse<{
  messages: ConversationMessage[];
  nextCursor: string | null;
}>;

export type DeleteConversationResponse = ApiSuccessResponse<{ deleted: true }>;

export type DeleteConversationHistoryResponse = ApiSuccessResponse<{
  deleted: true;
  conversationCount: number;
}>;

export type QuotaResponse = ApiSuccessResponse<{
  quota: {
    dailyLimit: number;
    used: number;
    remaining: number;
    usageDate: string;
  };
}>;

export type CapabilitiesResponse = ApiSuccessResponse<{ aiChatEnabled: boolean }>;

export type AiPublicFinishReason = 'stop' | 'length' | 'content_filter' | 'tool_call' | 'unknown';

export type AiStreamEvent =
  | {
      type: 'turn.started';
      data: { turnId: string; conversationId: string };
    }
  | {
      type: 'message.segment';
      data: { turnId: string; sequence: number; text: string };
    }
  | {
      type: 'turn.completed';
      data: { turnId: string; assistantMessageId: string; finishReason: AiPublicFinishReason };
    }
  | {
      type: 'turn.failed';
      data: ApiErrorResponse['error'] & { turnId: string };
    };
