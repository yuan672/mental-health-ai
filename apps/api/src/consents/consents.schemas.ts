import { z } from 'zod';

export const consentMutationSchema = z
  .object({
    consentType: z.string().min(1).max(64),
    consentVersion: z.string().min(1).max(64),
    action: z.enum(['accept', 'withdraw']),
  })
  .strict();

export type ConsentMutationRequest = z.infer<typeof consentMutationSchema>;
