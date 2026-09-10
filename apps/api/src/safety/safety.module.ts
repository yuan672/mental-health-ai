import { Module } from '@nestjs/common';
import { ConservativeTokenEstimator } from '../ai/context/token-estimator';
import { IncognitoRuntimeModule } from '../ai/incognito/incognito-runtime.module';
import { LlmProviderModule } from '../ai/providers/llm-provider.module';
import { PromptModule } from '../ai/prompts/prompt.module';
import {
  POST_GENERATION_SAFETY_GATE,
  PRE_GENERATION_SAFETY_GATE,
  RealPostGenerationSafetyGate,
  RealPreGenerationSafetyGate,
} from '../ai/safety/safety-gates';
import { ConversationModule } from '../conversations/conversation.module';
import { MessageModule } from '../messages/message.module';
import { AuditModule } from './audit/audit.module';
import { SafetyContextBuilder } from './context/safety-context.builder';
import { CrisisFlowService } from './crisis/crisis-flow.service';
import { CrisisResourceRegistry } from './crisis/crisis-resource.registry';
import { SafetyOperationalLoggingService } from './logging/safety-operational-logging.service';
import { DeterministicOutputSignalDetector } from './output/deterministic-output-signal-detector';
import {
  LlmOutputSafetyClassifier,
  OUTPUT_SAFETY_CLASSIFIER,
} from './output/output-safety-classifier';
import { OutputSafetyCheck } from './output/output-safety-check.service';
import { RiskEventRepository } from './persistence/risk-event.repository';
import { RiskEventService } from './persistence/risk-event.service';
import { RiskEventRetentionPolicy } from './persistence/safety-retention.policy';
import { SafetyProductionReadinessService } from './readiness/safety-production-readiness.service';
import { DeterministicSignalDetector } from './risk/deterministic-signal-detector';
import { LlmRiskClassifier, RISK_CLASSIFIER } from './risk/risk-classifier';
import { RiskDecisionPolicy } from './risk/risk-decision.policy';
import { RiskDetectionService } from './risk/risk-detection.service';
import { HumanReviewQueueRepository } from './review/human-review-queue.repository';
import { HumanReviewQueueService } from './review/human-review-queue.service';
import {
  DefaultDenySafetyReviewerAuthorizer,
  SAFETY_REVIEWER_AUTHORIZER,
} from './review/safety-reviewer-authorizer';
import { TrustedSafetyTemplateRegistry } from './templates/trusted-safety-template.registry';

@Module({
  imports: [
    ConversationModule,
    AuditModule,
    IncognitoRuntimeModule,
    LlmProviderModule,
    MessageModule,
    PromptModule,
  ],
  providers: [
    ConservativeTokenEstimator,
    CrisisFlowService,
    CrisisResourceRegistry,
    DefaultDenySafetyReviewerAuthorizer,
    DeterministicOutputSignalDetector,
    DeterministicSignalDetector,
    HumanReviewQueueRepository,
    HumanReviewQueueService,
    LlmOutputSafetyClassifier,
    LlmRiskClassifier,
    OutputSafetyCheck,
    RealPostGenerationSafetyGate,
    RealPreGenerationSafetyGate,
    RiskDecisionPolicy,
    RiskDetectionService,
    RiskEventRepository,
    RiskEventRetentionPolicy,
    RiskEventService,
    SafetyContextBuilder,
    SafetyOperationalLoggingService,
    SafetyProductionReadinessService,
    TrustedSafetyTemplateRegistry,
    { provide: RISK_CLASSIFIER, useExisting: LlmRiskClassifier },
    { provide: OUTPUT_SAFETY_CLASSIFIER, useExisting: LlmOutputSafetyClassifier },
    { provide: PRE_GENERATION_SAFETY_GATE, useExisting: RealPreGenerationSafetyGate },
    { provide: POST_GENERATION_SAFETY_GATE, useExisting: RealPostGenerationSafetyGate },
    {
      provide: SAFETY_REVIEWER_AUTHORIZER,
      useExisting: DefaultDenySafetyReviewerAuthorizer,
    },
  ],
  exports: [
    AuditModule,
    CrisisFlowService,
    HumanReviewQueueService,
    POST_GENERATION_SAFETY_GATE,
    PRE_GENERATION_SAFETY_GATE,
    RiskEventRepository,
    RiskEventService,
    SafetyOperationalLoggingService,
    SafetyProductionReadinessService,
    TrustedSafetyTemplateRegistry,
  ],
})
export class SafetyModule {}
