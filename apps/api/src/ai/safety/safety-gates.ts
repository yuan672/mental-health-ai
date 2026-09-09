import { Inject, Injectable } from '@nestjs/common';
import { env } from '../../config/env';

export const PRE_GENERATION_SAFETY_GATE = Symbol('PRE_GENERATION_SAFETY_GATE');
export const POST_GENERATION_SAFETY_GATE = Symbol('POST_GENERATION_SAFETY_GATE');

export type PreGenerationSafetyInput = Readonly<{
  userId: string;
  conversationId: string;
  message: string;
}>;

export type PostGenerationSafetyInput = Readonly<{
  userId: string;
  conversationId: string;
  candidateSegment: string;
  previouslyApprovedText: string;
}>;

export interface PreGenerationSafetyGate {
  readonly productionSafe: boolean;
  check(input: PreGenerationSafetyInput, signal: AbortSignal): Promise<void>;
}

export interface PostGenerationSafetyGate {
  readonly productionSafe: boolean;
  approve(input: PostGenerationSafetyInput, signal: AbortSignal): Promise<string>;
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

  async check(): Promise<void> {}
}

@Injectable()
export class PassThroughPostGenerationSafetyGate implements PostGenerationSafetyGate {
  readonly productionSafe = false;

  async approve(input: PostGenerationSafetyInput): Promise<string> {
    return input.candidateSegment;
  }
}

@Injectable()
export class AiSafetyConfigurationGuard {
  constructor(
    @Inject(PRE_GENERATION_SAFETY_GATE)
    preGenerationGate: PreGenerationSafetyGate,
    @Inject(POST_GENERATION_SAFETY_GATE)
    postGenerationGate: PostGenerationSafetyGate,
  ) {
    assertAiSafetyConfiguration(
      env.APP_ENV,
      env.AI_CHAT_ENABLED,
      preGenerationGate,
      postGenerationGate,
    );
  }
}
