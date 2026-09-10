import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  LLM_PROVIDER,
  LLMProviderFailure,
  type LLMProvider,
} from '../../ai/providers/llm-provider';
import { env } from '../../config/env';
import { PromptService } from '../../ai/prompts/prompt.service';
import {
  outputSafetyReasonCodeSchema,
  type OutputSafetyReasonCode,
  type RiskLevel,
} from '../safety.types';

export const OUTPUT_SAFETY_CLASSIFIER = Symbol('OUTPUT_SAFETY_CLASSIFIER');

const resultSchema = z
  .object({
    decision: z.enum(['ALLOW', 'BLOCK']),
    reasonCodes: z.array(outputSafetyReasonCodeSchema).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'ALLOW' && value.reasonCodes.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCodes'],
        message: 'ALLOW cannot include block reason codes',
      });
    }
    if (value.decision === 'BLOCK' && value.reasonCodes.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCodes'],
        message: 'BLOCK requires at least one reason code',
      });
    }
  });

export type OutputSafetyClassifierResult = Readonly<{
  decision: 'ALLOW' | 'BLOCK';
  reasonCodes: readonly OutputSafetyReasonCode[];
  classifierKey: string;
  classifierVersion: string;
}>;

export class OutputSafetyClassifierUnavailableError extends Error {
  constructor(public readonly category: 'timeout' | 'provider' | 'malformed' | 'internal') {
    super(`Output safety classifier unavailable: ${category}`);
    this.name = OutputSafetyClassifierUnavailableError.name;
  }
}

export interface OutputSafetyClassifier {
  classify(
    input: Readonly<{
      candidate: string;
      previouslyApprovedText: string;
      inputRiskLevel: RiskLevel;
    }>,
    signal: AbortSignal,
  ): Promise<OutputSafetyClassifierResult>;
}

@Injectable()
export class LlmOutputSafetyClassifier implements OutputSafetyClassifier {
  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LLMProvider,
    private readonly prompts: PromptService,
  ) {}

  async classify(
    input: Readonly<{
      candidate: string;
      previouslyApprovedText: string;
      inputRiskLevel: RiskLevel;
    }>,
    signal: AbortSignal,
  ): Promise<OutputSafetyClassifierResult> {
    const prompt = this.prompts.getOutputSafetyClassificationPrompt();
    const timeoutSignal = AbortSignal.timeout(env.SAFETY_CLASSIFIER_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      const result = await this.provider.chat(
        {
          requestId: randomUUID(),
          messages: [
            { role: 'system', content: prompt.content },
            {
              role: 'user',
              content: JSON.stringify({
                inputRiskLevel: input.inputRiskLevel,
                previouslyApprovedText: input.previouslyApprovedText,
                candidate: input.candidate,
              }),
            },
          ],
          maxOutputTokens: 256,
          temperature: 0,
          responseFormat: 'json',
        },
        { signal: combinedSignal },
      );
      return {
        ...resultSchema.parse(JSON.parse(result.content)),
        classifierKey: prompt.key,
        classifierVersion: prompt.version,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeoutSignal.aborted) {
        throw new OutputSafetyClassifierUnavailableError('timeout');
      }
      if (error instanceof LLMProviderFailure) {
        throw new OutputSafetyClassifierUnavailableError('provider');
      }
      throw new OutputSafetyClassifierUnavailableError(
        error instanceof SyntaxError || error instanceof z.ZodError ? 'malformed' : 'internal',
      );
    }
  }
}
