import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAiEventStream, startAiChatStream } from './chat-stream-client';

const TURN_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('AI fetch stream client', () => {
  afterEach(() => {
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });

  it('parses SSE frames split across network chunks', async () => {
    const source = [
      `event: turn.started\ndata: {"turnId":"${TURN_ID}",`,
      `"conversationId":"${CONVERSATION_ID}"}\n\nevent: message.segment\ndata: {"turnId":"${TURN_ID}","sequence":1,"text":"你好。"}\n\n`,
    ];

    const events = [];
    for await (const event of parseAiEventStream(chunkedStream(source))) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'turn.started',
        data: { turnId: TURN_ID, conversationId: CONVERSATION_ID },
      },
      {
        type: 'message.segment',
        data: { turnId: TURN_ID, sequence: 1, text: '你好。' },
      },
    ]);
  });

  it('uses POST, cookies, CSRF, body, and AbortSignal without EventSource', async () => {
    document.cookie = 'mh_csrf=csrf-test-token; Path=/';
    const signal = new AbortController().signal;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          `event: turn.started\ndata: {"turnId":"${TURN_ID}","conversationId":"${CONVERSATION_ID}"}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );

    const result = await startAiChatStream(
      { clientRequestId: TURN_ID, conversationId: CONVERSATION_ID, message: 'synthetic-test' },
      signal,
      fetcher,
    );

    expect(result.kind).toBe('stream');
    expect(fetcher).toHaveBeenCalledWith(
      new URL('/ai/chat/stream', 'http://localhost:3001'),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        signal,
        headers: expect.objectContaining({ 'x-csrf-token': 'csrf-test-token' }),
      }),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      clientRequestId: TURN_ID,
      conversationId: CONVERSATION_ID,
      message: 'synthetic-test',
    });
  });

  it('returns an existing idempotent turn response without starting another stream', async () => {
    document.cookie = 'mh_csrf=csrf-test-token; Path=/';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          success: true,
          data: {
            turn: {
              id: TURN_ID,
              conversationId: CONVERSATION_ID,
              status: 'failed',
              assistantMessageId: null,
            },
          },
        },
        { headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      startAiChatStream(
        { clientRequestId: TURN_ID, message: 'synthetic-test' },
        new AbortController().signal,
        fetcher,
      ),
    ).resolves.toEqual({
      kind: 'existing',
      turn: {
        id: TURN_ID,
        conversationId: CONVERSATION_ID,
        status: 'failed',
        assistantMessageId: null,
      },
    });
  });
});
