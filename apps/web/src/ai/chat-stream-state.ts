import type { AiPublicFinishReason, AiStreamEvent } from '@mental-health/types';

export type ChatStreamState = Readonly<{
  status: 'idle' | 'streaming' | 'completed' | 'failed';
  turnId: string | null;
  conversationId: string | null;
  assistantMessageId: string | null;
  text: string;
  lastSequence: number;
  finishReason: AiPublicFinishReason | null;
  error: Readonly<{ code: string; message: string }> | null;
}>;

export const initialChatStreamState: ChatStreamState = {
  status: 'idle',
  turnId: null,
  conversationId: null,
  assistantMessageId: null,
  text: '',
  lastSequence: 0,
  finishReason: null,
  error: null,
};

export function reduceChatStreamEvent(
  state: ChatStreamState,
  event: AiStreamEvent,
): ChatStreamState {
  switch (event.type) {
    case 'turn.started':
      return {
        ...initialChatStreamState,
        status: 'streaming',
        turnId: event.data.turnId,
        conversationId: event.data.conversationId,
      };
    case 'message.segment':
      if (
        state.status !== 'streaming' ||
        state.turnId !== event.data.turnId ||
        event.data.sequence !== state.lastSequence + 1
      ) {
        throw new Error('AI stream segment sequence is invalid');
      }
      return {
        ...state,
        text: state.text + event.data.text,
        lastSequence: event.data.sequence,
      };
    case 'turn.completed':
      if (state.status !== 'streaming' || state.turnId !== event.data.turnId) {
        throw new Error('AI stream completion does not match the active turn');
      }
      return {
        ...state,
        status: 'completed',
        assistantMessageId: event.data.assistantMessageId,
        finishReason: event.data.finishReason,
      };
    case 'turn.failed':
      if (state.turnId && state.turnId !== event.data.turnId) {
        throw new Error('AI stream failure does not match the active turn');
      }
      return {
        ...state,
        status: 'failed',
        turnId: event.data.turnId,
        error: { code: event.data.code, message: event.data.message },
      };
  }
}
