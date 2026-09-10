import { Inject, Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import { SafetyContextBuilder } from '../../safety/context/safety-context.builder';
import { SafetyOperationalLoggingService } from '../../safety/logging/safety-operational-logging.service';
import { OutputSafetyCheck } from '../../safety/output/output-safety-check.service';
import { RiskDetectionService } from '../../safety/risk/risk-detection.service';
import type { RiskDecision, SafetyTarget } from '../../safety/safety.types';
import { TrustedSafetyTemplateRegistry } from '../../safety/templates/trusted-safety-template.registry';
import { SafetyProductionReadinessService } from '../../safety/readiness/safety-production-readiness.service';

export const PRE_GENERATION_SAFETY_GATE = Symbol('PRE_GENERATION_SAFETY_GATE');
export const POST_GENERATION_SAFETY_GATE = Symbol('POST_GENERATION_SAFETY_GATE');

export type PreGenerationSafetyInput = Readonly<{
  turnId: string;
  userId: string;
  target: SafetyTarget;
  message: string;
  now?: Date;
}>;

export type PostGenerationSafetyInput = Readonly<{
  userId: string;
  turnId: string;
  target: SafetyTarget;
  candidateSegment: string;
  previouslyApprovedText: string;
  riskDecision: RiskDecision;
}>;

export type PostGenerationSafetyResult =
  | Readonly<{ status: 'approved'; text: string }>
  | Readonly<{
      status: 'replacement';
      text: string;
      cause: 'blocked' | 'classifier_unavailable';
    }>;

export interface PreGenerationSafetyGate {
  readonly productionSafe: boolean;
  readonly implementation?: 'pass-through' | 'real';
  check(input: PreGenerationSafetyInput, signal: AbortSignal): Promise<RiskDecision>;
}

export interface PostGenerationSafetyGate {
  readonly productionSafe: boolean;
  readonly implementation?: 'pass-through' | 'real';
  approve(
    input: PostGenerationSafetyInput,
    signal: AbortSignal,
  ): Promise<PostGenerationSafetyResult>;
}

export function assertAiSafetyConfiguration(
  appEnvironment: 'development' | 'test' | 'staging' | 'production',
  aiChatEnabled: boolean,
  preGenerationGate: PreGenerationSafetyGate,
  postGenerationGate: PostGenerationSafetyGate,
): void {
  const protectedEnvironment = appEnvironment === 'staging' || appEnvironment === 'production';
  if (
    aiChatEnabled &&
    protectedEnvironment &&
    (!preGenerationGate.productionSafe || !postGenerationGate.productionSafe)
  ) {
    throw new Error('AI chat cannot use pass-through safety gates in Staging or Production');
  }
}

@Injectable()
export class PassThroughPreGenerationSafetyGate implements PreGenerationSafetyGate {
  readonly productionSafe = false;
  readonly implementation = 'pass-through' as const;

  async check(): Promise<RiskDecision> {
    return {
      status: 'assessed',
      level: 'LOW',
      harmSubject: 'UNKNOWN',
      categories: [],
      reasonCodes: [],
      policyFlags: [],
      route: 'ALLOW_NORMAL_GENERATION',
      bufferingMode: 'semantic',
      detectionSource: 'deterministic',
      policyVersion: 'pass-through',
      classifierKey: null,
      classifierVersion: null,
    };
  }
}

@Injectable()
export class PassThroughPostGenerationSafetyGate implements PostGenerationSafetyGate {
  readonly productionSafe = false;
  readonly implementation = 'pass-through' as const;

  async approve(input: PostGenerationSafetyInput): Promise<PostGenerationSafetyResult> {
    return { status: 'approved', text: input.candidateSegment };
  }
}

@Injectable()
export class RealPreGenerationSafetyGate implements PreGenerationSafetyGate {
  readonly productionSafe = false;
  readonly implementation = 'real' as const;

  constructor(
    private readonly contextBuilder: SafetyContextBuilder,
    private readonly riskDetection: RiskDetectionService,
  ) {}

  async check(input: PreGenerationSafetyInput, signal: AbortSignal): Promise<RiskDecision> {
    if (signal.aborted) throw signal.reason;
    const context = await this.contextBuilder.build(
      input.userId,
      input.target,
      input.message,
      input.now,
    );
    if (signal.aborted) throw signal.reason;
    return this.riskDetection.assess(input.turnId, context, signal);
  }
}

@Injectable()
export class RealPostGenerationSafetyGate implements PostGenerationSafetyGate {
  readonly productionSafe = false;
  readonly implementation = 'real' as const;

  constructor(
    private readonly logging: SafetyOperationalLoggingService,
    private readonly outputSafety: OutputSafetyCheck,
    private readonly templates: TrustedSafetyTemplateRegistry,
  ) {}

  async approve(
    input: PostGenerationSafetyInput,
    signal: AbortSignal,
  ): Promise<PostGenerationSafetyResult> {
    if (signal.aborted) throw signal.reason;
    const startedAt = Date.now();
    const decision = await this.outputSafety.evaluate(
      {
        candidate: input.candidateSegment,
        previouslyApprovedText: input.previouslyApprovedText,
        inputRiskLevel:
          input.riskDecision.status === 'assessed' ? input.riskDecision.level : 'HIGH',
      },
      signal,
    );
    if (decision.status === 'approved') {
      return { status: 'approved', text: input.candidateSegment };
    }
    const unavailable = decision.status === 'unavailable';
    this.logging.outputSafetyStopped(
      { turnId: input.turnId },
      {
        outputSafetyDurationMs: Date.now() - startedAt,
        decisionPath: unavailable ? 'classifier_unavailable' : 'blocked',
        ...(unavailable ? { failureCategory: decision.failureCategory } : {}),
      },
    );
    const template = this.templates.get(
      unavailable ? 'output-classifier-unavailable' : 'output-blocked-replacement',
    );
    return {
      status: 'replacement',
      text: template.content,
      cause: unavailable ? 'classifier_unavailable' : 'blocked',
    };
  }
}

@Injectable()
export class AiSafetyConfigurationGuard {
  constructor(
    @Inject(PRE_GENERATION_SAFETY_GATE)
    preGenerationGate: PreGenerationSafetyGate,
    @Inject(POST_GENERATION_SAFETY_GATE)
    postGenerationGate: PostGenerationSafetyGate,
    readiness: SafetyProductionReadinessService,
  ) {
    const protectedEnvironment = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
    const result = readiness.evaluate(preGenerationGate, postGenerationGate);
    if (env.AI_CHAT_ENABLED && protectedEnvironment && !result.productionSafe) {
      const blockers = result.checks.filter((check) => !check.ready).map((check) => check.key);
      throw new Error(`AI chat safety readiness failed: ${blockers.join(',')}`);
    }
  }
}
