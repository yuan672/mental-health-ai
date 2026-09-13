import { z } from 'zod';

export const accountDeletionRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    currentPassword: z.string().min(1).max(128),
    acknowledgeIrreversible: z.literal(true),
  })
  .strict();

export type AccountDeletionRequest = z.infer<typeof accountDeletionRequestSchema>;
