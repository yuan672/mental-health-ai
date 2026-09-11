import type {
  AiStreamEvent,
  AiStreamEventV2,
  ConversationMessagesResponseV2,
  KnowledgeReference,
  KnowledgeReferenceSource,
} from '@mental-health/types';
import { z } from 'zod';
import { ClientCapabilityRequiredError } from '../common/errors';

export const KNOWLEDGE_REFERENCE_MAX_COUNT = 2;
export const KNOWLEDGE_REFERENCE_MAX_SOURCES = 20;

function boundedCodePointText(maximum: number) {
  return z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= maximum);
}

const isoDateTimeSchema = z.string().datetime({ offset: true });

const credentialFreeHttpsUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' && parsed.username.length === 0 && parsed.password.length === 0
    );
  });

const referenceSourceShape = {
  ordinal: z.number().int().positive().max(KNOWLEDGE_REFERENCE_MAX_SOURCES),
  publisherName: boundedCodePointText(160),
  sourceTitle: boundedCodePointText(320),
  sourcePublishedAt: isoDateTimeSchema.nullable(),
  sourceVersionLabel: boundedCodePointText(120).nullable(),
  sourceLocator: boundedCodePointText(160).nullable(),
  retrievedAt: isoDateTimeSchema,
};

export const knowledgeReferenceSourceSchema = z.discriminatedUnion('linkState', [
  z
    .object({
      linkState: z.literal('available'),
      ...referenceSourceShape,
      sourceUrl: credentialFreeHttpsUrlSchema,
    })
    .strict(),
  z
    .object({
      linkState: z.literal('unavailable'),
      ...referenceSourceShape,
    })
    .strict(),
]) satisfies z.ZodType<KnowledgeReferenceSource>;

export const knowledgeReferenceSchema = z
  .object({
    articleKey: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    title: boundedCodePointText(160),
    version: z.number().int().positive(),
    contentOrigin: z.enum(['curated', 'synthetic_fixture']),
    reviewStatus: z.enum(['unverified', 'source_verified']),
    reviewedAt: isoDateTimeSchema.nullable(),
    availability: z.enum(['currently_published', 'no_longer_available']),
    sources: z.array(knowledgeReferenceSourceSchema).min(1).max(KNOWLEDGE_REFERENCE_MAX_SOURCES),
  })
  .strict()
  .superRefine((reference, context) => {
    const ordinals = reference.sources.map((source) => source.ordinal);
    if (new Set(ordinals).size !== ordinals.length) {
      context.addIssue({ code: 'custom', path: ['sources'], message: '来源顺序必须唯一' });
    }
    if (reference.contentOrigin === 'curated' && reference.reviewStatus !== 'source_verified') {
      context.addIssue({
        code: 'custom',
        path: ['reviewStatus'],
        message: '正式内容引用必须具备来源核验状态',
      });
    }
    if (
      reference.contentOrigin === 'synthetic_fixture' &&
      reference.reviewStatus !== 'unverified'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reviewStatus'],
        message: '合成测试引用必须保持未核验状态',
      });
    }
    if (reference.reviewStatus === 'source_verified' && reference.reviewedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['reviewedAt'],
        message: '来源核验引用缺少核验时间',
      });
    }
    if (reference.reviewStatus === 'unverified' && reference.reviewedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['reviewedAt'],
        message: '未核验引用不得携带核验时间',
      });
    }
  }) satisfies z.ZodType<KnowledgeReference>;

export const knowledgeReferencesSchema = z
  .array(knowledgeReferenceSchema)
  .max(KNOWLEDGE_REFERENCE_MAX_COUNT);

const conversationMessageV2Schema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    sequence: z.number().int().positive(),
    createdAt: isoDateTimeSchema,
    knowledgeReferences: knowledgeReferencesSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.role === 'user' && message.knowledgeReferences.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['knowledgeReferences'],
        message: '用户消息不能携带知识引用',
      });
    }
  });

export const conversationMessagesResponseV2Schema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        messages: z.array(conversationMessageV2Schema),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<ConversationMessagesResponseV2>;

const finishReasonSchema = z.enum(['stop', 'length', 'content_filter', 'tool_call', 'unknown']);
const publicErrorShape = { code: z.string().min(1).max(64), message: z.string().min(1).max(256) };
const deliveryModeSchema = z.enum(['immediate', 'commit_with_references']);

const persistentStartedSchema = z
  .object({
    type: z.literal('turn.started'),
    data: z
      .object({
        mode: z.literal('persistent'),
        turnId: z.string().uuid(),
        conversationId: z.string().uuid(),
      })
      .strict(),
  })
  .strict();

const incognitoStartedSchema = z
  .object({
    type: z.literal('turn.started'),
    data: z.object({ mode: z.literal('incognito'), generationId: z.string().uuid() }).strict(),
  })
  .strict();

const persistentSegmentSchema = z
  .object({
    type: z.literal('message.segment'),
    data: z
      .object({
        mode: z.literal('persistent'),
        turnId: z.string().uuid(),
        sequence: z.number().int().positive(),
        text: boundedCodePointText(16_000),
        deliveryMode: deliveryModeSchema,
      })
      .strict(),
  })
  .strict();

const incognitoSegmentSchema = z
  .object({
    type: z.literal('message.segment'),
    data: z
      .object({
        mode: z.literal('incognito'),
        generationId: z.string().uuid(),
        sequence: z.number().int().positive(),
        text: boundedCodePointText(16_000),
        deliveryMode: deliveryModeSchema,
      })
      .strict(),
  })
  .strict();

const immediateCompletionShape = {
  deliveryMode: z.literal('immediate'),
  knowledgeReferences: z.array(knowledgeReferenceSchema).length(0),
};

const groundedCompletionShape = {
  deliveryMode: z.literal('commit_with_references'),
  knowledgeReferences: z.array(knowledgeReferenceSchema).min(1).max(KNOWLEDGE_REFERENCE_MAX_COUNT),
};

const persistentCompletionBase = {
  mode: z.literal('persistent'),
  turnId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  finishReason: finishReasonSchema,
};

const incognitoCompletionBase = {
  mode: z.literal('incognito'),
  generationId: z.string().uuid(),
  finishReason: finishReasonSchema,
};

const persistentCompletionSchema = z.union([
  z
    .object({
      type: z.literal('turn.completed'),
      data: z.object({ ...persistentCompletionBase, ...immediateCompletionShape }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.completed'),
      data: z.object({ ...persistentCompletionBase, ...groundedCompletionShape }).strict(),
    })
    .strict(),
]);

const incognitoCompletionSchema = z.union([
  z
    .object({
      type: z.literal('turn.completed'),
      data: z.object({ ...incognitoCompletionBase, ...immediateCompletionShape }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.completed'),
      data: z.object({ ...incognitoCompletionBase, ...groundedCompletionShape }).strict(),
    })
    .strict(),
]);

const persistentFailedSchema = z
  .object({
    type: z.literal('turn.failed'),
    data: z
      .object({ mode: z.literal('persistent'), turnId: z.string().uuid(), ...publicErrorShape })
      .strict(),
  })
  .strict();

const incognitoFailedSchema = z
  .object({
    type: z.literal('turn.failed'),
    data: z
      .object({
        mode: z.literal('incognito'),
        generationId: z.string().uuid(),
        ...publicErrorShape,
      })
      .strict(),
  })
  .strict();

export const aiStreamEventV2Schema = z.union([
  persistentStartedSchema,
  incognitoStartedSchema,
  persistentSegmentSchema,
  incognitoSegmentSchema,
  persistentCompletionSchema,
  incognitoCompletionSchema,
  persistentFailedSchema,
  incognitoFailedSchema,
]);

export function parseAiStreamEventV2(input: unknown): AiStreamEventV2 {
  return aiStreamEventV2Schema.parse(input) as AiStreamEventV2;
}

export function toImmediateAiStreamEventV2(event: AiStreamEvent): AiStreamEventV2 {
  if (event.type === 'message.segment') {
    return parseAiStreamEventV2({
      ...event,
      data: { ...event.data, deliveryMode: 'immediate' },
    });
  }
  if (event.type === 'turn.completed') {
    return parseAiStreamEventV2({
      ...event,
      data: { ...event.data, deliveryMode: 'immediate', knowledgeReferences: [] },
    });
  }
  return parseAiStreamEventV2(event);
}

export function toAiStreamEventV1(event: AiStreamEvent | AiStreamEventV2): AiStreamEvent {
  if (event.type === 'message.segment' && 'deliveryMode' in event.data) {
    if (event.data.deliveryMode !== 'immediate') {
      throw new ClientCapabilityRequiredError();
    }
    return event.data.mode === 'persistent'
      ? {
          type: event.type,
          data: {
            mode: event.data.mode,
            turnId: event.data.turnId,
            sequence: event.data.sequence,
            text: event.data.text,
          },
        }
      : {
          type: event.type,
          data: {
            mode: event.data.mode,
            generationId: event.data.generationId,
            sequence: event.data.sequence,
            text: event.data.text,
          },
        };
  }
  if (event.type === 'turn.completed' && 'deliveryMode' in event.data) {
    if (event.data.deliveryMode !== 'immediate' || event.data.knowledgeReferences.length > 0) {
      throw new ClientCapabilityRequiredError();
    }
    return event.data.mode === 'persistent'
      ? {
          type: event.type,
          data: {
            mode: event.data.mode,
            turnId: event.data.turnId,
            assistantMessageId: event.data.assistantMessageId,
            finishReason: event.data.finishReason,
          },
        }
      : {
          type: event.type,
          data: {
            mode: event.data.mode,
            generationId: event.data.generationId,
            finishReason: event.data.finishReason,
          },
        };
  }
  return event as AiStreamEvent;
}
