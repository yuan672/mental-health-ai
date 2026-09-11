import { z } from 'zod';

const emailSchema = z.string().trim().email().max(320);

export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine(
    (password) =>
      [/[a-z]/u, /[A-Z]/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u].filter((pattern) => pattern.test(password))
        .length >= 3,
    { message: 'Password must use at least three character classes' },
  );

const registrationConsentSchema = z
  .object({
    consentType: z.string().min(1).max(64),
    consentVersion: z.string().min(1).max(64),
    documentKey: z.string().min(1).max(128),
    documentRevision: z.string().min(1).max(64),
    accepted: z.literal(true),
  })
  .strict();

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    ageVerification: z
      .object({
        evidenceToken: z.string().min(1).max(256),
      })
      .strict(),
    consents: z.array(registrationConsentSchema).min(2).max(2),
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
