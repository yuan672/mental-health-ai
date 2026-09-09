import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AITurnInProgressError,
  DatabaseError,
  NotFoundError,
  QuotaExceededError,
} from '../../common/errors';
import { env } from '../../config/env';
import { ConversationLoggingService } from '../../conversations/conversation-logging.service';
import { QuotaPolicyService } from '../../quota/quota-policy.service';
import { QuotaLimitReachedError } from '../../quota/quota.repository';
import { ActiveAiTurnError, AiTurnRepository, type AiTurnRecord } from './ai-turn.repository';

export type ClaimedAiTurn = Readonly<{
  created: boolean;
  turn: AiTurnRecord;
}>;

export type CompletedAiTurn = AiTurnRecord & { assistantMessageId: string };

@Injectable()
export class AiTurnService {
  constructor(
    private readonly logging: ConversationLoggingService,
    private readonly policy: QuotaPolicyService,
    private readonly repository: AiTurnRepository,
  ) {}

  async findByClientRequestId(
    userId: string,
    clientRequestId: string,
  ): Promise<AiTurnRecord | null> {
    try {
      return await this.repository.findByClientRequestId(userId, clientRequestId);
    } catch {
      throw new DatabaseError();
    }
  }

  async claim(input: {
    userId: string;
    conversationId: string;
    clientRequestId: string;
    promptKey: string;
    promptVersion: string;
    now: Date;
  }): Promise<ClaimedAiTurn> {
    const turnId = randomUUID();
    const leaseExpiresAt = new Date(
      input.now.getTime() + env.LLM_TOTAL_TIMEOUT_MS + env.LLM_LEASE_SAFETY_MARGIN_MS,
    );

    try {
      const claimed = await this.repository.claim({
        id: turnId,
        ...input,
        leaseExpiresAt,
      });
      if (!claimed) {
        throw new NotFoundError('对话不存在');
      }
      return claimed;
    } catch (error) {
      if (error instanceof ActiveAiTurnError) {
        throw new AITurnInProgressError();
      }
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new DatabaseError();
    }
  }

  async start(turn: AiTurnRecord, userMessageContent: string, now: Date): Promise<AiTurnRecord> {
    const userMessageId = randomUUID();
    try {
      const started = await this.repository.start({
        turnId: turn.id,
        userId: turn.userId,
        conversationId: turn.conversationId,
        userMessageId,
        userMessageContent,
        usageDate: this.policy.getUsageDate(now),
        dailyLimit: this.policy.getDailyLimit(turn.userId),
        now,
      });
      if (!started) {
        throw new NotFoundError('AI 对话请求不存在');
      }
      this.logging.messageAppended(turn.userId, turn.conversationId, userMessageId, 'user');
      return started;
    } catch (error) {
      if (error instanceof QuotaLimitReachedError) {
        throw new QuotaExceededError();
      }
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new DatabaseError();
    }
  }

  async complete(
    turn: AiTurnRecord,
    assistantContent: string,
    now: Date,
  ): Promise<CompletedAiTurn> {
    const assistantMessageId = randomUUID();
    try {
      const completed = await this.repository.complete({
        turnId: turn.id,
        userId: turn.userId,
        conversationId: turn.conversationId,
        assistantMessageId,
        assistantContent,
        now,
      });
      if (!completed?.assistantMessageId) {
        throw new NotFoundError('AI 对话请求不存在');
      }
      this.logging.messageAppended(
        turn.userId,
        turn.conversationId,
        assistantMessageId,
        'assistant',
      );
      return completed as CompletedAiTurn;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new DatabaseError();
    }
  }

  async finish(
    turn: AiTurnRecord,
    status: 'failed' | 'cancelled',
    failureCode: string,
    now = new Date(),
  ): Promise<void> {
    try {
      await this.repository.finish(turn.id, turn.userId, status, failureCode, now);
    } catch {
      throw new DatabaseError();
    }
  }
}
