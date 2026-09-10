import { Inject, Injectable } from '@nestjs/common';
import type { OutputSafetyReasonCode, RiskLevel } from '../safety.types';
import { DeterministicOutputSignalDetector } from './deterministic-output-signal-detector';
import {
  OUTPUT_SAFETY_CLASSIFIER,
  OutputSafetyClassifierUnavailableError,
  type OutputSafetyClassifier,
} from './output-safety-classifier';

export type OutputSafetyDecision =
  | Readonly<{ status: 'approved' }>
  | Readonly<{ status: 'blocked'; reasonCodes: readonly OutputSafetyReasonCode[] }>
  | Readonly<{
      status: 'unavailable';
      failureCategory: 'timeout' | 'provider' | 'malformed' | 'internal';
    }>;

@Injectable()
export class OutputSafetyCheck {
  readonly failClosed = true;
  readonly schemaValidated = true;

  constructor(
    private readonly deterministic: DeterministicOutputSignalDetector,
    @Inject(OUTPUT_SAFETY_CLASSIFIER)
    private readonly classifier: OutputSafetyClassifier,
  ) {}

  async evaluate(
    input: Readonly<{
      candidate: string;
      previouslyApprovedText: string;
      inputRiskLevel: RiskLevel;
    }>,
    signal: AbortSignal,
  ): Promise<OutputSafetyDecision> {
    const deterministicCodes = this.deterministic.detect(
      `${input.previouslyApprovedText}${input.candidate}`,
      input.inputRiskLevel === 'HIGH',
    );
    if (deterministicCodes.length > 0) {
      return { status: 'blocked', reasonCodes: deterministicCodes };
    }

    try {
      const result = await this.classifier.classify(input, signal);
      return result.decision === 'ALLOW'
        ? { status: 'approved' }
        : { status: 'blocked', reasonCodes: result.reasonCodes };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const category =
        error instanceof OutputSafetyClassifierUnavailableError ? error.category : 'internal';
      return { status: 'unavailable', failureCategory: category };
    }
  }
}
