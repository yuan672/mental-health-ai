import type {
  AiChatRequest as SharedAiChatRequest,
  IncognitoAiChatRequest,
  PersistentAiChatRequest,
} from '@mental-health/types';
import { z } from 'zod';
import { env } from '../config/env';

const baseChatFields = {
  clientRequestId: z.string().uuid(),
  message: z.string().min(1).max(env.AI_MESSAGE_MAX_CHARACTERS),
};

export const persistentAiChatRequestSchema = z
  .object({
    mode: z.literal('persistent'),
    ...baseChatFields,
    conversationId: z.string().uuid().optional(),
  })
  .strict() satisfies z.ZodType<PersistentAiChatRequest>;

export const incognitoAiChatRequestSchema = z
  .object({
    mode: z.literal('incognito'),
    ...baseChatFields,
    contextId: z.string().uuid(),
  })
  .strict() satisfies z.ZodType<IncognitoAiChatRequest>;

export const aiChatRequestSchema = z.discriminatedUnion('mode', [
  persistentAiChatRequestSchema,
  incognitoAiChatRequestSchema,
]) satisfies z.ZodType<SharedAiChatRequest>;

export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;
