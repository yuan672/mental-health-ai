import { Inject, Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import {
  LLM_PROVIDER,
  LLMProviderFailure,
  LLMUnsupportedCapabilityError,
  type LLMProvider,
} from '../../ai/providers/llm-provider';
import { PromptService } from '../../ai/prompts/prompt.service';
import {
  harmSubjectSchema,
  riskCategorySchema,
  riskLevelSchema,
  riskReasonCodeSchema,
  type HarmSubject,
  type RiskCategory,
  type RiskLevel,
  type RiskReasonCode,
  type SafetyAssessmentContext,
} from '../safety.types';

export const RISK_CLASSIFIER = Symbol('RISK_CLASSIFIER');

export type RiskClassifierResult = Readonly<{
  candidateLevel: RiskLevel;
  harmSubject: HarmSubject;
  categories: readonly RiskCategory[];
  temporality: 'CURRENT' | 'HISTORICAL' | 'HYPOTHETICAL' | 'UNKNOWN';
  ideation: 'NONE' | 'PASSIVE' | 'ACTIVE' | 'UNKNOWN';
  intent: 'ABSENT' | 'PRESENT' | 'UNKNOWN';
  plan: 'ABSENT' | 'PRESENT' | 'UNKNOWN';
  means: 'ABSENT' | 'PRESENT' | 'UNKNOWN';
  immediacy: 'NONE' | 'POTENTIAL' | 'IMMINENT' | 'IN_PROGRESS' | 'UNKNOWN';
  confidence: number;
  reasonCodes: readonly RiskReasonCode[];
  classifierKey: string;
  classifierVersion: string;
}>;

export class RiskClassifierUnavailableError extends Error {
  constructor(
    public readonly category: 'timeout' | 'provider' | 'malformed' | 'unsupported' | 'internal',
  ) {
    super(`Risk classifier unavailable: ${category}`);
    this.name = RiskClassifierUnavailableError.name;
  }
}

export interface RiskClassifier {
  classify(
    requestId: string,
    context: SafetyAssessmentContext,
    signal: AbortSignal,
  ): Promise<RiskClassifierResult>;
}

@Injectable()
export class LlmRiskClassifier implements RiskClassifier {
  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LLMProvider,
    private readonly prompts: PromptService,
  ) {}

  async classify(
    requestId: string,
    context: SafetyAssessmentContext,
    signal: AbortSignal,
  ): Promise<RiskClassifierResult> {
    const prompt = this.prompts.getRiskClassificationPrompt();
    const timeoutSignal = AbortSignal.timeout(env.SAFETY_CLASSIFIER_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      const candidate = await this.provider.classifyRisk(
        {
          requestId,
          messages: [{ role: 'system', content: prompt.content }, ...context.messages],
          maxOutputTokens: Math.min(512, env.LLM_MAX_OUTPUT_TOKENS),
        },
        { signal: combinedSignal },
      );
      if (signal.aborted) throw signal.reason;
      if (timeoutSignal.aborted) {
        throw new RiskClassifierUnavailableError('timeout');
      }
      return {
        candidateLevel: riskLevelSchema.parse(candidate.candidateLevel),
        harmSubject: harmSubjectSchema.parse(candidate.harmSubject),
        categories: candidate.harmTargets.map((value) => riskCategorySchema.parse(value)),
        temporality: candidate.temporality,
        ideation: candidate.ideation,
        intent: candidate.intent,
        plan: candidate.plan,
        means: candidate.means,
        immediacy: candidate.immediacy,
        confidence: candidate.confidence,
        reasonCodes: candidate.reasonCodes.map((value) => riskReasonCodeSchema.parse(value)),
        classifierKey: prompt.key,
        classifierVersion: prompt.version,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeoutSignal.aborted) {
        throw new RiskClassifierUnavailableError('timeout');
      }
      if (error instanceof LLMUnsupportedCapabilityError) {
        throw new RiskClassifierUnavailableError('unsupported');
      }
      if (error instanceof LLMProviderFailure) {
        throw new RiskClassifierUnavailableError(
          error.category === 'timeout'
            ? 'timeout'
            : error.category === 'malformed_response'
              ? 'malformed'
              : 'provider',
        );
      }
      throw new RiskClassifierUnavailableError('malformed');
    }
  }
}
