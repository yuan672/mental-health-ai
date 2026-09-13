import {
  KNOWLEDGE_REFERENCES_CAPABILITY_HEADER,
  KNOWLEDGE_REFERENCES_CAPABILITY_VERSION,
  type AiChatRequest,
  type AiStreamEventV2,
} from '@mental-health/types';
import { z } from 'zod';
import { parseApiError, readCsrfToken } from '../api/client';
import { knowledgeReferencesSchema } from '../api/schemas';
import { notifySessionInvalidated } from '../api/session-events';
import { publicEnv } from '../config/env';

const finishReasonSchema = z.enum(['stop', 'length', 'content_filter', 'tool_call', 'unknown']);
const aiStreamEventSchema = z.union([
  z.object({
    type: z.literal('turn.started'),
    data: z.discriminatedUnion('mode', [
      z
        .object({
          mode: z.literal('persistent'),
          turnId: z.string().uuid(),
          conversationId: z.string().uuid(),
        })
        .strict(),
      z.object({ mode: z.literal('incognito'), generationId: z.string().uuid() }).strict(),
    ]),
  }),
  z.object({
    type: z.literal('message.segment'),
    data: z.discriminatedUnion('mode', [
      z
        .object({
          mode: z.literal('persistent'),
          turnId: z.string().uuid(),
          sequence: z.number().int().positive(),
          text: z.string(),
          deliveryMode: z.enum(['immediate', 'commit_with_references']),
        })
        .strict(),
      z
        .object({
          mode: z.literal('incognito'),
          generationId: z.string().uuid(),
          sequence: z.number().int().positive(),
          text: z.string(),
          deliveryMode: z.enum(['immediate', 'commit_with_references']),
        })
        .strict(),
    ]),
  }),
  z.union([
    z.object({
      type: z.literal('turn.completed'),
      data: z
        .object({
          mode: z.literal('persistent'),
          turnId: z.string().uuid(),
          assistantMessageId: z.string().uuid(),
          finishReason: finishReasonSchema,
          deliveryMode: z.literal('immediate'),
          knowledgeReferences: knowledgeReferencesSchema.length(0),
        })
        .strict(),
    }),
    z.object({
      type: z.literal('turn.completed'),
      data: z
        .object({
          mode: z.literal('persistent'),
          turnId: z.string().uuid(),
          assistantMessageId: z.string().uuid(),
          finishReason: finishReasonSchema,
          deliveryMode: z.literal('commit_with_references'),
          knowledgeReferences: knowledgeReferencesSchema.min(1),
        })
        .strict(),
    }),
    z.object({
      type: z.literal('turn.completed'),
      data: z
        .object({
          mode: z.literal('incognito'),
          generationId: z.string().uuid(),
          finishReason: finishReasonSchema,
          deliveryMode: z.literal('immediate'),
          knowledgeReferences: knowledgeReferencesSchema.length(0),
        })
        .strict(),
    }),
    z.object({
      type: z.literal('turn.completed'),
      data: z
        .object({
          mode: z.literal('incognito'),
          generationId: z.string().uuid(),
          finishReason: finishReasonSchema,
          deliveryMode: z.literal('commit_with_references'),
          knowledgeReferences: knowledgeReferencesSchema.min(1),
        })
        .strict(),
    }),
  ]),
  z.object({
    type: z.literal('turn.failed'),
    data: z.discriminatedUnion('mode', [
      z
        .object({
          mode: z.literal('persistent'),
          turnId: z.string().uuid(),
          code: z.string().min(1),
          message: z.string().min(1),
        })
        .strict(),
      z
        .object({
          mode: z.literal('incognito'),
          generationId: z.string().uuid(),
          code: z.string().min(1),
          message: z.string().min(1),
        })
        .strict(),
    ]),
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

export type AiChatStreamInput = Readonly<AiChatRequest>;

export type ExistingAiTurn = z.infer<typeof existingTurnResponseSchema>['data']['turn'];

export type AiChatConnection =
  | Readonly<{ kind: 'existing'; turn: ExistingAiTurn }>
  | Readonly<{ kind: 'stream'; events: AsyncIterable<AiStreamEventV2> }>;

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

function parseFrame(frame: string): AiStreamEventV2 | null {
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
  return aiStreamEventSchema.parse({ type: eventType, data: JSON.parse(data) }) as AiStreamEventV2;
}

export async function* parseAiEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<AiStreamEventV2> {
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

async function* validateStreamMode(
  events: AsyncIterable<AiStreamEventV2>,
  expectedMode: AiChatRequest['mode'],
): AsyncIterable<AiStreamEventV2> {
  let terminalReceived = false;
  for await (const event of events) {
    if (event.data.mode !== expectedMode) {
      throw new AiChatRequestError('INVALID_STREAM_RESPONSE', 'AI 响应模式与请求不一致', 502);
    }
    if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      terminalReceived = true;
    }
    yield event;
    if (terminalReceived) return;
  }
  if (!terminalReceived) {
    throw new AiChatRequestError('INVALID_STREAM_RESPONSE', 'AI 响应未正常结束', 502);
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
      [KNOWLEDGE_REFERENCES_CAPABILITY_HEADER]: KNOWLEDGE_REFERENCES_CAPABILITY_VERSION,
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

  if (
    response.headers.get(KNOWLEDGE_REFERENCES_CAPABILITY_HEADER) !==
    KNOWLEDGE_REFERENCES_CAPABILITY_VERSION
  ) {
    throw new AiChatRequestError(
      'CLIENT_CAPABILITY_REQUIRED',
      '当前版本无法安全显示知识引用，请更新后重试',
      406,
    );
  }

  if (contentType.includes('application/json')) {
    if (input.mode === 'incognito') {
      throw new AiChatRequestError('INVALID_STREAM_RESPONSE', '无痕响应格式无效', 502);
    }
    const existing = existingTurnResponseSchema.parse(await response.json());
    return { kind: 'existing', turn: existing.data.turn };
  }
  if (!contentType.includes('text/event-stream') || !response.body) {
    throw new AiChatRequestError('INVALID_STREAM_RESPONSE', 'AI 响应格式无效', 502);
  }
  return {
    kind: 'stream',
    events: validateStreamMode(parseAiEventStream(response.body), input.mode),
  };
}
