import type {
  AiDeliveryMode,
  AiPublicFinishReason,
  AiStreamEventV2,
  KnowledgeReference,
} from '@mental-health/types';

export type ChatStreamState = Readonly<{
  status: 'idle' | 'submitting' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  persistence: 'uncommitted' | 'committed' | 'ephemeral' | 'persistence-failed';
  mode: 'persistent' | 'incognito' | null;
  turnId: string | null;
  generationId: string | null;
  conversationId: string | null;
  assistantMessageId: string | null;
  text: string;
  pendingText: string;
  deliveryMode: AiDeliveryMode | null;
  knowledgeReferences: KnowledgeReference[];
  lastSequence: number;
  finishReason: AiPublicFinishReason | null;
  error: Readonly<{ code: string; message: string }> | null;
}>;

export const initialChatStreamState: ChatStreamState = {
  status: 'idle',
  persistence: 'uncommitted',
  mode: null,
  turnId: null,
  generationId: null,
  conversationId: null,
  assistantMessageId: null,
  text: '',
  pendingText: '',
  deliveryMode: null,
  knowledgeReferences: [],
  lastSequence: 0,
  finishReason: null,
  error: null,
};

export function beginChatStream(): ChatStreamState {
  return { ...initialChatStreamState, status: 'submitting' };
}

function eventOperationId(event: AiStreamEventV2): string {
  return event.data.mode === 'persistent' ? event.data.turnId : event.data.generationId;
}

function stateOperationId(state: ChatStreamState): string | null {
  return state.mode === 'incognito' ? state.generationId : state.turnId;
}

export function cancelChatStream(state: ChatStreamState): ChatStreamState {
  return {
    ...state,
    status: 'cancelled',
    persistence: state.text ? 'persistence-failed' : 'uncommitted',
    pendingText: '',
    error: null,
  };
}

export function failChatStream(
  state: ChatStreamState,
  code: string,
  message: string,
): ChatStreamState {
  return {
    ...state,
    status: 'failed',
    persistence: state.text ? 'persistence-failed' : 'uncommitted',
    pendingText: '',
    error: { code, message },
  };
}

export function reduceChatStreamEvent(
  state: ChatStreamState,
  event: AiStreamEventV2,
): ChatStreamState {
  switch (event.type) {
    case 'turn.started':
      if (state.status !== 'submitting') {
        throw new Error('AI stream start is duplicated or out of order');
      }
      return {
        ...initialChatStreamState,
        status: 'streaming',
        persistence: 'uncommitted',
        mode: event.data.mode,
        turnId: event.data.mode === 'persistent' ? event.data.turnId : null,
        generationId: event.data.mode === 'incognito' ? event.data.generationId : null,
        conversationId: event.data.mode === 'persistent' ? event.data.conversationId : null,
      };
    case 'message.segment':
      if (
        state.status !== 'streaming' ||
        state.mode !== event.data.mode ||
        stateOperationId(state) !== eventOperationId(event) ||
        event.data.sequence !== state.lastSequence + 1 ||
        (state.deliveryMode !== null && state.deliveryMode !== event.data.deliveryMode)
      ) {
        throw new Error('AI stream segment sequence is invalid');
      }
      return {
        ...state,
        text: event.data.deliveryMode === 'immediate' ? state.text + event.data.text : state.text,
        pendingText:
          event.data.deliveryMode === 'commit_with_references'
            ? state.pendingText + event.data.text
            : state.pendingText,
        deliveryMode: event.data.deliveryMode,
        lastSequence: event.data.sequence,
      };
    case 'turn.completed':
      if (
        state.status !== 'streaming' ||
        state.mode !== event.data.mode ||
        stateOperationId(state) !== eventOperationId(event) ||
        state.deliveryMode !== event.data.deliveryMode ||
        (event.data.deliveryMode === 'commit_with_references' && state.pendingText.length === 0)
      ) {
        throw new Error('AI stream completion does not match the active turn');
      }
      return {
        ...state,
        status: 'completed',
        persistence: event.data.mode === 'persistent' ? 'committed' : 'ephemeral',
        text: event.data.deliveryMode === 'commit_with_references' ? state.pendingText : state.text,
        pendingText: '',
        knowledgeReferences: event.data.knowledgeReferences,
        assistantMessageId: event.data.mode === 'persistent' ? event.data.assistantMessageId : null,
        finishReason: event.data.finishReason,
      };
    case 'turn.failed':
      if (
        stateOperationId(state) &&
        (state.mode !== event.data.mode || stateOperationId(state) !== eventOperationId(event))
      ) {
        throw new Error('AI stream failure does not match the active turn');
      }
      return {
        ...state,
        status: 'failed',
        persistence: state.text ? 'persistence-failed' : 'uncommitted',
        pendingText: '',
        mode: event.data.mode,
        turnId: event.data.mode === 'persistent' ? event.data.turnId : null,
        generationId: event.data.mode === 'incognito' ? event.data.generationId : null,
        error: { code: event.data.code, message: event.data.message },
      };
  }
}
