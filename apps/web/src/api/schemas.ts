import { z } from 'zod';

export const sessionResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      user: z.object({ id: z.string().uuid() }).strict(),
      session: z
        .object({ id: z.string().uuid(), expiresAt: z.string().datetime({ offset: true }) })
        .strict(),
    }),
  })
  .strict();

export const logoutResponseSchema = z
  .object({ success: z.literal(true), data: z.object({ loggedOut: z.literal(true) }).strict() })
  .strict();

export const registrationRequirementsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        registrationEnabled: z.boolean(),
        minimumAge: z.literal(18),
        requiredConsents: z.array(
          z
            .object({
              type: z.enum(['terms_of_service', 'privacy_policy']),
              version: z.string().min(1).max(64),
              displayKey: z.enum(['consent.termsOfService', 'consent.privacyPolicy']),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export const registrationResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        user: z.object({ id: z.string().uuid() }).strict(),
        ageVerification: z
          .object({
            verified: z.literal(true),
            method: z.string().min(1),
            verifiedAt: z.string().datetime({ offset: true }),
          })
          .strict(),
        consents: z.array(
          z
            .object({
              consentType: z.string().min(1),
              consentVersion: z.string().min(1),
              status: z.literal('accepted'),
              acceptedAt: z.string().datetime({ offset: true }),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

const conversationMetadataSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    isSaved: z.boolean(),
  })
  .strict();

export const conversationListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        conversations: z.array(conversationMetadataSchema),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const conversationDetailResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ conversation: conversationMetadataSchema }).strict(),
  })
  .strict();

export const conversationMessagesResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        messages: z.array(
          z
            .object({
              id: z.string().uuid(),
              role: z.enum(['user', 'assistant']),
              content: z.string(),
              sequence: z.number().int().positive(),
              createdAt: z.string().datetime({ offset: true }),
            })
            .strict(),
        ),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const deleteConversationResponseSchema = z
  .object({ success: z.literal(true), data: z.object({ deleted: z.literal(true) }).strict() })
  .strict();

export const deleteHistoryResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({ deleted: z.literal(true), conversationCount: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();

export const quotaResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        quota: z
          .object({
            dailyLimit: z.number().int().positive(),
            used: z.number().int().nonnegative(),
            remaining: z.number().int().nonnegative(),
            usageDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const capabilitiesResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ aiChatEnabled: z.boolean() }).strict(),
  })
  .strict();
