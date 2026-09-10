import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeSessionInvalidated } from '../api/session-events';
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
      `event: turn.started\ndata: {"mode":"persistent","turnId":"${TURN_ID}",`,
      `"conversationId":"${CONVERSATION_ID}"}\n\nevent: message.segment\ndata: {"mode":"persistent","turnId":"${TURN_ID}","sequence":1,"text":"你好。"}\n\n`,
    ];

    const events = [];
    for await (const event of parseAiEventStream(chunkedStream(source))) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'turn.started',
        data: { mode: 'persistent', turnId: TURN_ID, conversationId: CONVERSATION_ID },
      },
      {
        type: 'message.segment',
        data: { mode: 'persistent', turnId: TURN_ID, sequence: 1, text: '你好。' },
      },
    ]);
  });

  it('parses strict Incognito events without fabricated persistent identifiers', async () => {
    const generationId = '44444444-4444-4444-8444-444444444444';
    const events = [];
    for await (const event of parseAiEventStream(
      chunkedStream([
        `event: turn.started\ndata: {"mode":"incognito","generationId":"${generationId}"}\n\n`,
        `event: message.segment\ndata: {"mode":"incognito","generationId":"${generationId}","sequence":1,"text":"临时回复。"}\n\n`,
        `event: turn.completed\ndata: {"mode":"incognito","generationId":"${generationId}","finishReason":"stop"}\n\n`,
      ]),
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toMatch(/conversationId|assistantMessageId/u);
  });

  it('rejects a response mode that does not match the Incognito request', async () => {
    document.cookie = 'mh_csrf=csrf-test-token; Path=/';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          `event: turn.started\ndata: {"mode":"persistent","turnId":"${TURN_ID}","conversationId":"${CONVERSATION_ID}"}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    const result = await startAiChatStream(
      {
        mode: 'incognito',
        clientRequestId: TURN_ID,
        contextId: CONVERSATION_ID,
        message: 'synthetic-test',
      },
      new AbortController().signal,
      fetcher,
    );
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') throw new Error('Expected stream response');
    const events = result.events[Symbol.asyncIterator]();
    await expect(events.next()).rejects.toMatchObject({
      code: 'INVALID_STREAM_RESPONSE',
      status: 502,
    });
  });

  it('rejects a stream that closes without a terminal event', async () => {
    document.cookie = 'mh_csrf=csrf-test-token; Path=/';
    const generationId = '44444444-4444-4444-8444-444444444444';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          [
            `event: turn.started\ndata: {"mode":"incognito","generationId":"${generationId}"}\n\n`,
            `event: message.segment\ndata: {"mode":"incognito","generationId":"${generationId}","sequence":1,"text":"已审核片段。"}\n\n`,
          ].join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    const result = await startAiChatStream(
      {
        mode: 'incognito',
        clientRequestId: TURN_ID,
        contextId: CONVERSATION_ID,
        message: 'synthetic-test',
      },
      new AbortController().signal,
      fetcher,
    );
    if (result.kind !== 'stream') throw new Error('Expected stream response');

    const consume = async () => {
      for await (const event of result.events) {
        // Consume the complete response to verify a clean EOF is not treated as completion.
        void event;
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: 'INVALID_STREAM_RESPONSE',
      status: 502,
    });
  });

  it('uses POST, cookies, CSRF, body, and AbortSignal without EventSource', async () => {
    document.cookie = 'mh_csrf=csrf-test-token; Path=/';
    const signal = new AbortController().signal;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          `event: turn.started\ndata: {"mode":"persistent","turnId":"${TURN_ID}","conversationId":"${CONVERSATION_ID}"}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );

    const result = await startAiChatStream(
      {
        mode: 'persistent',
        clientRequestId: TURN_ID,
        conversationId: CONVERSATION_ID,
        message: 'synthetic-test',
      },
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
      mode: 'persistent',
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
        { mode: 'persistent', clientRequestId: TURN_ID, message: 'synthetic-test' },
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

  it('invalidates the Web session when streaming returns 401', async () => {
    document.cookie = 'mh_csrf=csrf-test-token; Path=/';
    const invalidated = vi.fn();
    const unsubscribe = subscribeSessionInvalidated(invalidated);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { success: false, error: { code: 'UNAUTHENTICATED', message: '请先登录' } },
          { status: 401 },
        ),
      );

    await expect(
      startAiChatStream(
        { mode: 'persistent', clientRequestId: TURN_ID, message: 'synthetic-test' },
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(invalidated).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
