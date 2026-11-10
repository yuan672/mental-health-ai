import { z } from 'zod';
import { apiRequest } from './client';
export const diaryAccessPolicySchema = z
  .object({
    mode: z.enum(['none', 'selected', 'all']),
    notebookIds: z.array(z.uuid()).max(50),
    revision: z.int().min(0),
  })
  .strict();
export type DiaryAccessPolicy = z.infer<typeof diaryAccessPolicySchema>;
const policyResponse = z
  .object({
    success: z.literal(true),
    data: z.object({ policy: diaryAccessPolicySchema }).strict(),
  })
  .strict();
const referencesResponse = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        recorded: z.boolean(),
        entries: z
          .array(
            z
              .object({
                notebookId: z.uuid(),
                day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                revision: z.int().positive(),
                title: z.string(),
                available: z.boolean(),
              })
              .strict(),
          )
          .max(5),
      })
      .strict(),
  })
  .strict();
export const diaryMemoryApi = {
  policy: (signal?: AbortSignal) =>
    apiRequest('/diary/ai/access', policyResponse, signal ? { signal } : {}),
  save: (input: Omit<DiaryAccessPolicy, 'revision'> & { expectedRevision: number }) =>
    apiRequest('/diary/ai/access', policyResponse, { method: 'PATCH', body: input, csrf: true }),
  references: (turnId: string, signal?: AbortSignal) =>
    apiRequest(
      `/diary/ai/turns/${encodeURIComponent(turnId)}`,
      referencesResponse,
      signal ? { signal } : {},
    ),
};
