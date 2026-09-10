import { Inject, Injectable } from '@nestjs/common';
import type { RiskDecision, SafetyAssessmentContext } from '../safety.types';
import { SafetyOperationalLoggingService } from '../logging/safety-operational-logging.service';
import { DeterministicSignalDetector } from './deterministic-signal-detector';
import {
  RISK_CLASSIFIER,
  RiskClassifierUnavailableError,
  type RiskClassifier,
} from './risk-classifier';
import { RiskDecisionPolicy } from './risk-decision.policy';

@Injectable()
export class RiskDetectionService {
  readonly failClosed = true;
  readonly schemaValidated = true;

  constructor(
    private readonly deterministic: DeterministicSignalDetector,
    private readonly logging: SafetyOperationalLoggingService,
    private readonly policy: RiskDecisionPolicy,
    @Inject(RISK_CLASSIFIER) private readonly classifier: RiskClassifier,
  ) {}

  async assess(
    turnId: string,
    context: SafetyAssessmentContext,
    signal: AbortSignal,
  ): Promise<RiskDecision> {
    const startedAt = Date.now();
    const deterministicSignals = this.deterministic.detect(context);
    const classifierStartedAt = Date.now();
    try {
      const candidate = await this.classifier.classify(turnId, context, signal);
      const classifierDuration = Date.now() - classifierStartedAt;
      const decision = this.policy.decide(deterministicSignals, candidate);
      this.logging.riskDetectionCompleted(
        { turnId },
        {
          classifierKey: candidate.classifierKey,
          classifierVersion: candidate.classifierVersion,
          riskDetectionDurationMs: Date.now() - startedAt,
          riskClassifierDurationMs: classifierDuration,
          decisionPath: decision.status === 'assessed' ? decision.detectionSource : 'hybrid',
        },
      );
      return decision;
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const unavailable =
        error instanceof RiskClassifierUnavailableError
          ? error
          : new RiskClassifierUnavailableError('internal');
      const classifierDuration = Date.now() - classifierStartedAt;
      const decision = this.policy.decide(deterministicSignals, null, unavailable.category);
      if (decision.status === 'unavailable') {
        this.logging.riskDetectionUnavailable(
          { turnId },
          {
            classifierKey: 'risk-classification',
            classifierVersion: '2026-09-10',
            riskDetectionDurationMs: Date.now() - startedAt,
            riskClassifierDurationMs: classifierDuration,
            failureCategory: unavailable.category,
          },
        );
      } else {
        this.logging.riskDetectionCompleted(
          { turnId },
          {
            classifierKey: null,
            classifierVersion: null,
            riskDetectionDurationMs: Date.now() - startedAt,
            riskClassifierDurationMs: classifierDuration,
            decisionPath: 'deterministic',
          },
        );
      }
      return decision;
    }
  }
}
