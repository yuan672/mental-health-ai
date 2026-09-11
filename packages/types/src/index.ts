import type { ConsentType } from './consents.js';

export * from './consents.js';
export * from './knowledge.js';
export * from './mood.js';

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

export type AuthSession = {
  user: { id: string };
  session: { id: string; expiresAt: string };
};

export type AuthSessionResponse = ApiSuccessResponse<AuthSession>;

export type LoginResponse = AuthSessionResponse;

export type RegistrationRequirement = {
  type: ConsentType;
  version: string;
  displayKey: 'consent.termsOfService' | 'consent.privacyPolicy';
  documentKey: string;
  documentRevision: string;
  documentUrl: string;
};

export type RegistrationRequirementsResponse = ApiSuccessResponse<{
  registrationEnabled: boolean;
  minimumAge: 18;
  requiredConsents: RegistrationRequirement[];
}>;

export type RegistrationResponse = ApiSuccessResponse<{
  user: { id: string };
  ageVerification: {
    verified: true;
    method: string;
    verifiedAt: string;
  };
  consents: Array<{
    consentType: ConsentType;
    consentVersion: string;
    status: 'accepted';
    acceptedAt: string;
  }>;
}>;

export type LogoutResponse = ApiSuccessResponse<{ loggedOut: true }>;

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

export type PersistentAiChatRequest = {
  mode: 'persistent';
  clientRequestId: string;
  conversationId?: string | undefined;
  message: string;
};

export type IncognitoAiChatRequest = {
  mode: 'incognito';
  clientRequestId: string;
  contextId: string;
  message: string;
};

export type AiChatRequest = PersistentAiChatRequest | IncognitoAiChatRequest;

export type PersistentAiStreamEvent =
  | {
      type: 'turn.started';
      data: { mode: 'persistent'; turnId: string; conversationId: string };
    }
  | {
      type: 'message.segment';
      data: { mode: 'persistent'; turnId: string; sequence: number; text: string };
    }
  | {
      type: 'turn.completed';
      data: {
        mode: 'persistent';
        turnId: string;
        assistantMessageId: string;
        finishReason: AiPublicFinishReason;
      };
    }
  | {
      type: 'turn.failed';
      data: ApiErrorResponse['error'] & { mode: 'persistent'; turnId: string };
    };

export type IncognitoAiStreamEvent =
  | {
      type: 'turn.started';
      data: { mode: 'incognito'; generationId: string };
    }
  | {
      type: 'message.segment';
      data: { mode: 'incognito'; generationId: string; sequence: number; text: string };
    }
  | {
      type: 'turn.completed';
      data: {
        mode: 'incognito';
        generationId: string;
        finishReason: AiPublicFinishReason;
      };
    }
  | {
      type: 'turn.failed';
      data: ApiErrorResponse['error'] & { mode: 'incognito'; generationId: string };
    };

export type AiStreamEvent = PersistentAiStreamEvent | IncognitoAiStreamEvent;

export type CreateIncognitoContextResponse = ApiSuccessResponse<{
  context: { id: string; expiresAt: string };
}>;

export type EndIncognitoContextResponse = ApiSuccessResponse<{ ended: true }>;
