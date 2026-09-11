import { z } from 'zod';

const MAX_GROUNDED_ANSWER_CODE_POINTS = 16_000;
const PRIVATE_REFERENCE_ID = /^K[12]$/u;
const SOURCE_LIKE_TEXT = /(?:https?:\/\/|www\.|\[[^\]]+\]\([^)]+\)|\[(?:\d+|K[12])\]|【K[12]】)/iu;

const groundedAnswerSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, 'Grounded answer must not be empty')
  .refine(
    (value) => Array.from(value).length <= MAX_GROUNDED_ANSWER_CODE_POINTS,
    'Grounded answer exceeds its code-point limit',
  )
  .refine((value) => !SOURCE_LIKE_TEXT.test(value), 'Grounded answer contains citation-like text');

const groundedProviderEnvelopeSchema = z
  .object({
    answer: groundedAnswerSchema,
    usedReferenceIds: z
      .array(z.string().regex(PRIVATE_REFERENCE_ID))
      .min(1)
      .max(2)
      .refine((identifiers) => new Set(identifiers).size === identifiers.length),
  })
  .strict();

export type GroundedProviderEnvelope = z.infer<typeof groundedProviderEnvelopeSchema>;

export function parseGroundedProviderEnvelope(
  raw: string,
  offeredReferenceIds: readonly string[],
): GroundedProviderEnvelope {
  const parsedJson: unknown = JSON.parse(raw);
  const envelope = groundedProviderEnvelopeSchema.parse(parsedJson);
  const offered = new Set(offeredReferenceIds);
  if (envelope.usedReferenceIds.some((identifier) => !offered.has(identifier))) {
    throw new Error('Grounded response selected an unknown reference');
  }
  return envelope;
}
