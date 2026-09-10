import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type {
  LLMFinishReason,
  LLMProviderFailureCategory,
  LLMTokenUsage,
} from '../providers/llm-provider';

export type AiCancellationSource = 'user' | 'client_disconnect' | 'timeout';

type TurnMetadata = Readonly<{
  userId: string;
  conversationId?: string;
  turnId: string;
}>;

@Injectable()
export class AiOperationalLoggingService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AiOperationalLoggingService.name);
  }

  turnStarted(metadata: TurnMetadata, provider: string, model: string): void {
    this.logger.info({
      event: 'llm_request_started',
      eventCategory: 'ai_operational',
      ...metadata,
      provider,
      model,
    });
  }

  firstSegment(metadata: TurnMetadata, timeToFirstTokenMs: number): void {
    this.logger.info({
      event: 'llm_first_segment',
      eventCategory: 'ai_operational',
      ...metadata,
      timeToFirstTokenMs,
    });
  }

  turnCompleted(
    metadata: TurnMetadata,
    details: Readonly<{
      provider: string;
      model: string;
      providerRequestId: string | null;
      durationMs: number;
      timeToFirstTokenMs: number | null;
      usage: LLMTokenUsage;
      finishReason: LLMFinishReason;
    }>,
  ): void {
    this.logger.info({
      event: 'llm_request_completed',
      eventCategory: 'ai_operational',
      ...metadata,
      provider: details.provider,
      model: details.model,
      providerRequestId: details.providerRequestId,
      durationMs: details.durationMs,
      timeToFirstTokenMs: details.timeToFirstTokenMs,
      inputTokenCount: details.usage.inputTokens,
      outputTokenCount: details.usage.outputTokens,
      totalTokenCount: details.usage.totalTokens,
      finishReason: details.finishReason,
    });
  }

  turnFailed(
    metadata: TurnMetadata,
    failureCategory: LLMProviderFailureCategory | 'persistence' | 'safety' | 'internal',
    durationMs: number,
  ): void {
    this.logger.warn({
      event: 'llm_request_failed',
      eventCategory: 'ai_operational',
      ...metadata,
      failureCategory,
      durationMs,
    });
  }

  turnCancelled(
    metadata: TurnMetadata,
    cancellationSource: AiCancellationSource,
    durationMs: number,
  ): void {
    this.logger.info({
      event: 'llm_request_cancelled',
      eventCategory: 'ai_operational',
      ...metadata,
      cancellationSource,
      durationMs,
    });
  }
}
