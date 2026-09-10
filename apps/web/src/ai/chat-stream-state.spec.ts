import { describe, expect, it } from 'vitest';
import { initialChatStreamState, reduceChatStreamEvent } from './chat-stream-state';

const TURN_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';

describe('chat stream reducer', () => {
  it('builds an incrementally rendered completed message', () => {
    const started = reduceChatStreamEvent(initialChatStreamState, {
      type: 'turn.started',
      data: { turnId: TURN_ID, conversationId: CONVERSATION_ID },
    });
    const first = reduceChatStreamEvent(started, {
      type: 'message.segment',
      data: { turnId: TURN_ID, sequence: 1, text: '先听见你。' },
    });
    const second = reduceChatStreamEvent(first, {
      type: 'message.segment',
      data: { turnId: TURN_ID, sequence: 2, text: '我们慢慢来。' },
    });
    const completed = reduceChatStreamEvent(second, {
      type: 'turn.completed',
      data: { turnId: TURN_ID, assistantMessageId: MESSAGE_ID, finishReason: 'stop' },
    });

    expect(completed).toMatchObject({
      status: 'completed',
      text: '先听见你。我们慢慢来。',
      lastSequence: 2,
      assistantMessageId: MESSAGE_ID,
      finishReason: 'stop',
    });
  });

  it('rejects gaps and duplicates in segment sequence', () => {
    const started = reduceChatStreamEvent(initialChatStreamState, {
      type: 'turn.started',
      data: { turnId: TURN_ID, conversationId: CONVERSATION_ID },
    });
    expect(() =>
      reduceChatStreamEvent(started, {
        type: 'message.segment',
        data: { turnId: TURN_ID, sequence: 2, text: 'out-of-order' },
      }),
    ).toThrow('segment sequence');
  });

  it('moves an active turn into a failed state without completing partial text', () => {
    const started = reduceChatStreamEvent(initialChatStreamState, {
      type: 'turn.started',
      data: { turnId: TURN_ID, conversationId: CONVERSATION_ID },
    });
    const failed = reduceChatStreamEvent(started, {
      type: 'turn.failed',
      data: { turnId: TURN_ID, code: 'AI_PROVIDER_UNAVAILABLE', message: '暂时不可用' },
    });

    expect(failed).toMatchObject({
      status: 'failed',
      assistantMessageId: null,
      error: { code: 'AI_PROVIDER_UNAVAILABLE' },
    });
  });

  it('keeps an already displayed trusted safety segment when persistence later fails', () => {
    const started = reduceChatStreamEvent(initialChatStreamState, {
      type: 'turn.started',
      data: { turnId: TURN_ID, conversationId: CONVERSATION_ID },
    });
    const safetyPrompt = reduceChatStreamEvent(started, {
      type: 'message.segment',
      data: { turnId: TURN_ID, sequence: 1, text: '请立即寻求现实世界的帮助。' },
    });
    const failed = reduceChatStreamEvent(safetyPrompt, {
      type: 'turn.failed',
      data: { turnId: TURN_ID, code: 'DATABASE_ERROR', message: '安全响应未能保存' },
    });

    expect(failed).toMatchObject({
      status: 'failed',
      text: '请立即寻求现实世界的帮助。',
      assistantMessageId: null,
      error: { code: 'DATABASE_ERROR', message: '安全响应未能保存' },
    });
  });
});
