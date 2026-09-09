export type AppEnvironment = 'development' | 'staging' | 'production';

export type ApiErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};

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
