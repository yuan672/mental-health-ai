import { z } from 'zod';

const MAX_GROUNDED_ANSWER_CODE_POINTS = 16_000;
const PRIVATE_REFERENCE_ID = /^K[12]$/u;
const SOURCE_LIKE_TEXT = /(?:https?:\/\/|www\.|\[[^\]]+\]\([^)]+\)|\[(?:\d+|K[12])\]|【K[12]】)/iu;

export const INSUFFICIENT_KNOWLEDGE_MESSAGE =
  '目前提供的知识资料不足以支持对这个问题的可靠回答，我不想用猜测来回答你。你可以换一个更具体的问题，我们也可以继续梳理你的感受和需要。';

const groundedAnswerSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, 'Grounded answer must not be empty')
  .refine(
    (value) => Array.from(value).length <= MAX_GROUNDED_ANSWER_CODE_POINTS,
    'Grounded answer exceeds its code-point limit',
  )
  .refine((value) => !SOURCE_LIKE_TEXT.test(value), 'Grounded answer contains citation-like text');

const supportedEnvelopeSchema = z
  .object({
    status: z.literal('supported'),
    answer: groundedAnswerSchema,
    usedReferenceIds: z
      .array(z.string().regex(PRIVATE_REFERENCE_ID))
      .min(1)
      .max(2)
      .refine((identifiers) => new Set(identifiers).size === identifiers.length),
  })
  .strict();

const groundedProviderEnvelopeSchema = z.discriminatedUnion('status', [
  supportedEnvelopeSchema,
  z
    .object({
      status: z.literal('insufficient_evidence'),
      answer: z.literal(''),
      usedReferenceIds: z.array(z.never()).length(0),
    })
    .strict(),
]);

export type GroundedProviderEnvelope = z.infer<typeof groundedProviderEnvelopeSchema>;

export class GroundedResponseContractError extends Error {
  constructor(public readonly reason: 'malformed_envelope' | 'invalid_reference') {
    super(`Grounded response contract rejected: ${reason}`);
    this.name = GroundedResponseContractError.name;
  }
}

export function parseGroundedProviderEnvelope(
  raw: string,
  offeredReferenceIds: readonly string[],
): GroundedProviderEnvelope {
  let envelope: GroundedProviderEnvelope;
  try {
    const parsedJson: unknown = JSON.parse(raw);
    envelope = groundedProviderEnvelopeSchema.parse(parsedJson);
  } catch {
    throw new GroundedResponseContractError('malformed_envelope');
  }
  const offered = new Set(offeredReferenceIds);
  if (envelope.usedReferenceIds.some((identifier) => !offered.has(identifier))) {
    throw new GroundedResponseContractError('invalid_reference');
  }
  return envelope;
}
