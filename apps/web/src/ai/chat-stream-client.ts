import type { AiStreamEvent } from '@mental-health/types';
import { z } from 'zod';
import { parseApiError, readCsrfToken } from '../api/client';
import { notifySessionInvalidated } from '../api/session-events';
import { publicEnv } from '../config/env';

const aiStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn.started'),
    data: z.object({ turnId: z.string().uuid(), conversationId: z.string().uuid() }).strict(),
  }),
  z.object({
    type: z.literal('message.segment'),
    data: z
      .object({
        turnId: z.string().uuid(),
        sequence: z.number().int().positive(),
        text: z.string(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal('turn.completed'),
    data: z
      .object({
        turnId: z.string().uuid(),
        assistantMessageId: z.string().uuid(),
        finishReason: z.enum(['stop', 'length', 'content_filter', 'tool_call', 'unknown']),
      })
      .strict(),
  }),
  z.object({
    type: z.literal('turn.failed'),
    data: z
      .object({ turnId: z.string().uuid(), code: z.string().min(1), message: z.string().min(1) })
      .strict(),
  }),
]);

const existingTurnResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    turn: z.object({
      id: z.string().uuid(),
      conversationId: z.string().uuid(),
      status: z.enum(['claimed', 'streaming', 'completed', 'failed', 'cancelled']),
      assistantMessageId: z.string().uuid().nullable(),
    }),
  }),
});

export type AiChatStreamInput = Readonly<{
  clientRequestId: string;
  conversationId?: string;
  message: string;
}>;

export type ExistingAiTurn = z.infer<typeof existingTurnResponseSchema>['data']['turn'];

export type AiChatConnection =
  | Readonly<{ kind: 'existing'; turn: ExistingAiTurn }>
  | Readonly<{ kind: 'stream'; events: AsyncIterable<AiStreamEvent> }>;

export class AiChatRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = AiChatRequestError.name;
  }
}

function nextFrame(buffer: string): { frame: string; remainder: string } | null {
  const boundary = /\r?\n\r?\n/u.exec(buffer);
  if (!boundary || boundary.index === undefined) {
    return null;
  }
  return {
    frame: buffer.slice(0, boundary.index),
    remainder: buffer.slice(boundary.index + boundary[0].length),
  };
}

function parseFrame(frame: string): AiStreamEvent | null {
  const eventType = frame
    .split(/\r?\n/u)
    .find((line) => line.startsWith('event:'))
    ?.slice(6)
    .trim();
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!eventType || !data) {
    return null;
  }
  return aiStreamEventSchema.parse({ type: eventType, data: JSON.parse(data) });
}

export async function* parseAiEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<AiStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const item = await reader.read();
      buffer += decoder.decode(item.value, { stream: !item.done });
      let frame = nextFrame(buffer);
      while (frame) {
        buffer = frame.remainder;
        const event = parseFrame(frame.frame);
        if (event) {
          yield event;
        }
        frame = nextFrame(buffer);
      }
      if (item.done) {
        break;
      }
    }
    if (buffer.trim().length > 0) {
      throw new Error('AI event stream ended with an incomplete frame');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function startAiChatStream(
  input: AiChatStreamInput,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<AiChatConnection> {
  const csrfToken = readCsrfToken();
  if (!csrfToken) {
    throw new AiChatRequestError('CSRF_TOKEN_MISSING', '安全校验信息缺失，请刷新后重试', 400);
  }

  const response = await fetcher(new URL('/ai/chat/stream', publicEnv.VITE_API_BASE_URL), {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(input),
    signal,
  });
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    const error = await parseApiError(response);
    if (response.status === 401) {
      notifySessionInvalidated();
    }
    throw new AiChatRequestError(error.code, error.message, response.status);
  }

  if (contentType.includes('application/json')) {
    const existing = existingTurnResponseSchema.parse(await response.json());
    return { kind: 'existing', turn: existing.data.turn };
  }
  if (!contentType.includes('text/event-stream') || !response.body) {
    throw new AiChatRequestError('INVALID_STREAM_RESPONSE', 'AI 响应格式无效', 502);
  }
  return { kind: 'stream', events: parseAiEventStream(response.body) };
}
