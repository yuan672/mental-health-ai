import { z } from 'zod';

export const profileResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        email: z.string().email(),
        accountCreatedAt: z.string().datetime({ offset: true }),
        adultEligibility: z
          .object({ verified: z.literal(true), verifiedAt: z.string().datetime({ offset: true }) })
          .strict(),
      })
      .strict(),
  })
  .strict();
