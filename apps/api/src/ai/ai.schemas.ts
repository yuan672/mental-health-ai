import { z } from 'zod';
import { env } from '../config/env';

export const aiChatRequestSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    conversationId: z.string().uuid().optional(),
    message: z.string().min(1).max(env.AI_MESSAGE_MAX_CHARACTERS),
  })
  .strict();

export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;
