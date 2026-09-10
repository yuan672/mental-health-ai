import { Inject, Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import type {
  PostGenerationSafetyGate,
  PreGenerationSafetyGate,
} from '../../ai/safety/safety-gates';
import { CrisisResourceRegistry } from '../crisis/crisis-resource.registry';
import { CrisisFlowService } from '../crisis/crisis-flow.service';
import { AuditLogRepository } from '../audit/audit-log.repository';
import { OutputSafetyCheck } from '../output/output-safety-check.service';
import { RiskEventRepository } from '../persistence/risk-event.repository';
import { RiskDetectionService } from '../risk/risk-detection.service';
import { HumanReviewQueueRepository } from '../review/human-review-queue.repository';
import {
  SAFETY_REVIEWER_AUTHORIZER,
  type SafetyReviewerAuthorizer,
} from '../review/safety-reviewer-authorizer';

export type SafetyReadinessCheck = Readonly<{
  key: string;
  ready: boolean;
}>;

@Injectable()
export class SafetyProductionReadinessService {
  constructor(
    private readonly audits: AuditLogRepository,
    private readonly crisisFlow: CrisisFlowService,
    private readonly outputSafety: OutputSafetyCheck,
    private readonly riskDetection: RiskDetectionService,
    private readonly riskEvents: RiskEventRepository,
    private readonly resources: CrisisResourceRegistry,
    private readonly reviewQueue: HumanReviewQueueRepository,
    @Inject(SAFETY_REVIEWER_AUTHORIZER)
    private readonly reviewerAuthorizer: SafetyReviewerAuthorizer,
  ) {}

  evaluate(
    preGate: PreGenerationSafetyGate,
    postGate: PostGenerationSafetyGate,
  ): Readonly<{ productionSafe: boolean; checks: readonly SafetyReadinessCheck[] }> {
    const checks: SafetyReadinessCheck[] = [
      { key: 'real_pre_gate_installed', ready: preGate.implementation === 'real' },
      { key: 'real_post_gate_installed', ready: postGate.implementation === 'real' },
      {
        key: 'risk_classifier_schema_validation',
        ready: this.riskDetection.schemaValidated,
      },
      {
        key: 'pre_safety_fail_closed',
        ready: this.riskDetection.failClosed,
      },
      {
        key: 'output_classifier_schema_validation',
        ready: this.outputSafety.schemaValidated,
      },
      {
        key: 'post_safety_fail_closed',
        ready: this.outputSafety.failClosed,
      },
      { key: 'crisis_flow_installed', ready: Boolean(this.crisisFlow) },
      { key: 'risk_event_persistence_available', ready: Boolean(this.riskEvents) },
      { key: 'review_queue_available', ready: Boolean(this.reviewQueue) },
      { key: 'audit_log_available', ready: Boolean(this.audits) },
      {
        key: 'gates_declare_production_safe',
        ready: preGate.productionSafe && postGate.productionSafe,
      },
      { key: 'verified_crisis_resources', ready: this.resources.isProductionReady() },
      { key: 'provider_privacy_reviewed', ready: env.SAFETY_PROVIDER_PRIVACY_APPROVED },
      { key: 'consent_reviewed', ready: env.SAFETY_CONSENT_APPROVED },
      {
        key: 'reviewer_access_ready',
        ready: env.SAFETY_REVIEWER_ACCESS_READY && this.reviewerAuthorizer.productionReady,
      },
      { key: 'safety_corpus_reviewed', ready: env.SAFETY_CORPUS_REVIEWED },
    ];
    return { productionSafe: checks.every((check) => check.ready), checks };
  }
}
