import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AITurnInProgressError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  QuotaExceededError,
} from '../../common/errors';
import { env } from '../../config/env';
import { ConversationLoggingService } from '../../conversations/conversation-logging.service';
import { QuotaPolicyService } from '../../quota/quota-policy.service';
import { QuotaLimitReachedError } from '../../quota/quota.repository';
import { ActiveAiTurnError, AiTurnRepository, type AiTurnRecord } from './ai-turn.repository';
import type { RiskDecision } from '../../safety/safety.types';

export type ClaimedAiTurn = Readonly<{
  created: boolean;
  turn: AiTurnRecord;
}>;

export type CompletedAiTurn = AiTurnRecord & { assistantMessageId: string };

export class AiTurnCompletionResultUnknownError extends Error {
  constructor() {
    super('AI turn completion result is unknown');
    this.name = AiTurnCompletionResultUnknownError.name;
  }
}

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
      if (!claimed.created && claimed.turn.conversationId !== input.conversationId) {
        throw new ConflictError('客户端请求与原对话不一致');
      }
      return claimed;
    } catch (error) {
      if (error instanceof ActiveAiTurnError) {
        throw new AITurnInProgressError();
      }
      if (error instanceof NotFoundError) {
        throw error;
      }
      if (error instanceof ConflictError) {
        throw error;
      }
      throw new DatabaseError();
    }
  }

  async start(
    turn: AiTurnRecord,
    userMessageContent: string,
    prompt: Readonly<{ key: string; version: string }>,
    riskDecision: RiskDecision,
    now: Date,
  ): Promise<AiTurnRecord> {
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
        promptKey: prompt.key,
        promptVersion: prompt.version,
        riskDecision,
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

  async completeTrusted(
    turn: AiTurnRecord,
    input: Readonly<{
      userMessageContent: string;
      assistantContent: string;
      promptKey: string;
      promptVersion: string;
      riskDecision: RiskDecision;
      templateKey: string;
      templateVersion: string;
    }>,
    now: Date,
  ): Promise<CompletedAiTurn> {
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    try {
      const completed = await this.repository.completeTrusted({
        turnId: turn.id,
        userId: turn.userId,
        conversationId: turn.conversationId,
        userMessageId,
        userMessageContent: input.userMessageContent,
        assistantMessageId,
        assistantContent: input.assistantContent,
        promptKey: input.promptKey,
        promptVersion: input.promptVersion,
        riskDecision: input.riskDecision,
        templateKey: input.templateKey,
        templateVersion: input.templateVersion,
        now,
      });
      if (!completed?.assistantMessageId) {
        throw new NotFoundError('AI 对话请求不存在');
      }
      this.logging.messageAppended(turn.userId, turn.conversationId, userMessageId, 'user');
      this.logging.messageAppended(
        turn.userId,
        turn.conversationId,
        assistantMessageId,
        'assistant',
      );
      return completed as CompletedAiTurn;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
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

  async completeGrounded(
    turn: AiTurnRecord,
    assistantContent: string,
    articleVersionIds: readonly string[],
    now: Date,
    reconciliationTimeoutMs = 2_000,
  ): Promise<CompletedAiTurn> {
    const assistantMessageId = randomUUID();
    try {
      const completed = await this.repository.completeGrounded({
        turnId: turn.id,
        userId: turn.userId,
        conversationId: turn.conversationId,
        assistantMessageId,
        assistantContent,
        articleVersionIds,
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
      try {
        const committed = await this.repository.findCommittedGroundedCompletion({
          turnId: turn.id,
          userId: turn.userId,
          assistantMessageId,
          assistantContent,
          articleVersionIds,
          lockTimeoutMs: reconciliationTimeoutMs,
        });
        if (committed?.assistantMessageId) {
          this.logging.messageAppended(
            turn.userId,
            turn.conversationId,
            assistantMessageId,
            'assistant',
          );
          return committed as CompletedAiTurn;
        }
      } catch {
        throw new AiTurnCompletionResultUnknownError();
      }
      throw new DatabaseError();
    }
  }

  async failAfterSafetyDecision(
    turn: AiTurnRecord,
    decision: RiskDecision,
    failureCode: string,
    now = new Date(),
  ): Promise<void> {
    try {
      await this.repository.failAfterSafetyDecision({
        turnId: turn.id,
        userId: turn.userId,
        conversationId: turn.conversationId,
        decision,
        failureCode,
        now,
      });
    } catch {
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

  async settleBeforeProviderFailure(
    turn: AiTurnRecord,
    status: 'failed' | 'cancelled',
    failureCode: string,
    now = new Date(),
  ): Promise<void> {
    try {
      await this.repository.settleBeforeProviderFailure({
        turnId: turn.id,
        userId: turn.userId,
        status,
        failureCode,
        now,
      });
    } catch {
      throw new DatabaseError();
    }
  }
}
