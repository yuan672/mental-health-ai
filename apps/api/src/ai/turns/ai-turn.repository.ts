import {
  aiTurns,
  and,
  conversations,
  eq,
  gt,
  inArray,
  isNull,
  messages,
  or,
  sql,
  users,
  type AiTurnStatus,
  type AppTransaction,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { KnowledgeMessageReferenceRepository } from '../../knowledge/knowledge-message-reference.repository';
import { QuotaLimitReachedError, QuotaRepository } from '../../quota/quota.repository';
import { AuditLogRepository } from '../../safety/audit/audit-log.repository';
import { RiskEventRepository } from '../../safety/persistence/risk-event.repository';
import { requiresRiskEvent, type RiskDecision } from '../../safety/safety.types';

export type AiTurnRecord = {
  id: string;
  userId: string;
  conversationId: string;
  clientRequestId: string;
  status: AiTurnStatus;
  promptKey: string;
  promptVersion: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  failureCode: string | null;
  leaseExpiresAt: Date;
  createdAt: Date;
  startedAt: Date;
  completedAt: Date | null;
};

export class ActiveAiTurnError extends Error {
  constructor(public readonly turn: AiTurnRecord) {
    super('Conversation already has an active AI turn');
    this.name = ActiveAiTurnError.name;
  }
}

function activeOwnedConversation(userId: string, conversationId: string, now: Date) {
  return and(
    eq(conversations.id, conversationId),
    eq(conversations.userId, userId),
    isNull(conversations.deletedAt),
    or(eq(conversations.isSaved, true), gt(conversations.expiresAt, now)),
  );
}

@Injectable()
export class AiTurnRepository {
  constructor(
    private readonly audits: AuditLogRepository,
    private readonly databaseService: DatabaseService,
    private readonly knowledgeReferences: KnowledgeMessageReferenceRepository,
    private readonly quotaRepository: QuotaRepository,
    private readonly riskEvents: RiskEventRepository,
  ) {}

  async findByClientRequestId(
    userId: string,
    clientRequestId: string,
  ): Promise<AiTurnRecord | null> {
    const [turn] = await this.databaseService.database
      .select()
      .from(aiTurns)
      .where(and(eq(aiTurns.userId, userId), eq(aiTurns.clientRequestId, clientRequestId)))
      .limit(1);
    return turn ?? null;
  }

  async claim(input: {
    id: string;
    userId: string;
    conversationId: string;
    clientRequestId: string;
    promptKey: string;
    promptVersion: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<{ created: boolean; turn: AiTurnRecord } | null> {
    return this.databaseService.database.transaction(async (transaction) => {
      await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for('update');

      const [existing] = await transaction
        .select()
        .from(aiTurns)
        .where(
          and(eq(aiTurns.userId, input.userId), eq(aiTurns.clientRequestId, input.clientRequestId)),
        )
        .limit(1);
      if (existing) {
        return { created: false, turn: existing };
      }

      const [conversation] = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(activeOwnedConversation(input.userId, input.conversationId, input.now))
        .limit(1)
        .for('update');
      if (!conversation) {
        return null;
      }

      const [active] = await transaction
        .select()
        .from(aiTurns)
        .where(
          and(
            eq(aiTurns.conversationId, input.conversationId),
            inArray(aiTurns.status, ['claimed', 'streaming']),
          ),
        )
        .limit(1)
        .for('update');
      if (active && active.leaseExpiresAt.getTime() > input.now.getTime()) {
        throw new ActiveAiTurnError(active);
      }
      if (active) {
        await transaction
          .update(aiTurns)
          .set({ status: 'failed', failureCode: 'STALE_TURN', completedAt: input.now })
          .where(eq(aiTurns.id, active.id));
      }

      const [turn] = await transaction
        .insert(aiTurns)
        .values({
          id: input.id,
          userId: input.userId,
          conversationId: input.conversationId,
          clientRequestId: input.clientRequestId,
          status: 'claimed',
          promptKey: input.promptKey,
          promptVersion: input.promptVersion,
          leaseExpiresAt: input.leaseExpiresAt,
          createdAt: input.now,
          startedAt: input.now,
        })
        .returning();
      if (!turn) {
        throw new Error('AI turn insert returned no record');
      }
      return { created: true, turn };
    });
  }

  async start(input: {
    turnId: string;
    userId: string;
    conversationId: string;
    userMessageId: string;
    userMessageContent: string;
    usageDate: string;
    dailyLimit: number;
    promptKey: string;
    promptVersion: string;
    riskDecision: RiskDecision;
    now: Date;
  }): Promise<AiTurnRecord | null> {
    return this.databaseService.database.transaction(async (transaction) => {
      const [conversation] = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(activeOwnedConversation(input.userId, input.conversationId, input.now))
        .limit(1)
        .for('update');
      if (!conversation) {
        return null;
      }

      const [turn] = await transaction
        .select()
        .from(aiTurns)
        .where(and(eq(aiTurns.id, input.turnId), eq(aiTurns.userId, input.userId)))
        .limit(1)
        .for('update');
      if (!turn || turn.status !== 'claimed') {
        return null;
      }

      const quota = await this.quotaRepository.consumeWithinTransaction(transaction, {
        userId: input.userId,
        usageDate: input.usageDate,
        dailyLimit: input.dailyLimit,
        idempotencyKey: input.turnId,
        now: input.now,
      });
      if (quota.status === 'limit_reached') {
        throw new QuotaLimitReachedError();
      }

      const sequenceNumber = await this.nextMessageSequence(transaction, input.conversationId);
      await transaction.insert(messages).values({
        id: input.userMessageId,
        conversationId: input.conversationId,
        role: 'user',
        sequenceNumber,
        content: input.userMessageContent,
        createdAt: input.now,
      });

      if (requiresRiskEvent(input.riskDecision)) {
        await this.riskEvents.persistWithinTransaction(transaction, {
          userId: input.userId,
          conversationId: input.conversationId,
          aiTurnId: input.turnId,
          triggerMessageId: input.userMessageId,
          clientRequestId: turn.clientRequestId,
          isIncognito: false,
          decision: input.riskDecision,
          createdAt: input.now,
        });
      }

      const [started] = await transaction
        .update(aiTurns)
        .set({
          status: 'streaming',
          userMessageId: input.userMessageId,
          promptKey: input.promptKey,
          promptVersion: input.promptVersion,
        })
        .where(eq(aiTurns.id, input.turnId))
        .returning();
      return started ?? null;
    });
  }

  async completeTrusted(input: {
    turnId: string;
    userId: string;
    conversationId: string;
    userMessageId: string;
    userMessageContent: string;
    assistantMessageId: string;
    assistantContent: string;
    promptKey: string;
    promptVersion: string;
    riskDecision: RiskDecision;
    templateKey: string;
    templateVersion: string;
    now: Date;
  }): Promise<AiTurnRecord | null> {
    return this.databaseService.database.transaction(async (transaction) => {
      const [conversation] = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(activeOwnedConversation(input.userId, input.conversationId, input.now))
        .limit(1)
        .for('update');
      if (!conversation) return null;

      const [turn] = await transaction
        .select()
        .from(aiTurns)
        .where(
          and(
            eq(aiTurns.id, input.turnId),
            eq(aiTurns.userId, input.userId),
            eq(aiTurns.status, 'claimed'),
          ),
        )
        .limit(1)
        .for('update');
      if (!turn) return null;

      const userSequence = await this.nextMessageSequence(transaction, input.conversationId);
      await transaction.insert(messages).values({
        id: input.userMessageId,
        conversationId: input.conversationId,
        role: 'user',
        sequenceNumber: userSequence,
        content: input.userMessageContent,
        createdAt: input.now,
      });
      const assistantSequence = await this.nextMessageSequence(transaction, input.conversationId);
      await transaction.insert(messages).values({
        id: input.assistantMessageId,
        conversationId: input.conversationId,
        role: 'assistant',
        sequenceNumber: assistantSequence,
        content: input.assistantContent,
        createdAt: input.now,
      });

      if (requiresRiskEvent(input.riskDecision)) {
        await this.riskEvents.persistWithinTransaction(transaction, {
          userId: input.userId,
          conversationId: input.conversationId,
          aiTurnId: input.turnId,
          triggerMessageId: input.userMessageId,
          clientRequestId: turn.clientRequestId,
          isIncognito: false,
          decision: input.riskDecision,
          createdAt: input.now,
          trustedAction: {
            action:
              input.riskDecision.level === 'CRITICAL'
                ? 'crisis_flow_triggered'
                : 'trusted_safety_response_created',
            templateKey: input.templateKey,
            templateVersion: input.templateVersion,
          },
        });
      } else if (input.riskDecision.status === 'unavailable') {
        await this.audits.appendWithinTransaction(transaction, {
          actorType: 'system',
          actorId: null,
          action: 'safety_assessment_unavailable',
          resourceType: 'ai_turn',
          resourceId: input.turnId,
          idempotencyKey: `safety-assessment-unavailable:${input.turnId}`,
          safeMetadata: { failureCategory: input.riskDecision.failureCategory },
          occurredAt: input.now,
        });
      }

      const [completed] = await transaction
        .update(aiTurns)
        .set({
          status: 'completed',
          userMessageId: input.userMessageId,
          assistantMessageId: input.assistantMessageId,
          promptKey: input.promptKey,
          promptVersion: input.promptVersion,
          failureCode: null,
          completedAt: input.now,
        })
        .where(eq(aiTurns.id, input.turnId))
        .returning();
      return completed ?? null;
    });
  }

  async failAfterSafetyDecision(input: {
    turnId: string;
    userId: string;
    conversationId: string;
    decision: RiskDecision;
    failureCode: string;
    now: Date;
  }): Promise<void> {
    await this.databaseService.database.transaction(async (transaction) => {
      const [turn] = await transaction
        .select()
        .from(aiTurns)
        .where(
          and(
            eq(aiTurns.id, input.turnId),
            eq(aiTurns.userId, input.userId),
            eq(aiTurns.status, 'claimed'),
          ),
        )
        .limit(1)
        .for('update');
      if (!turn) return;

      if (requiresRiskEvent(input.decision)) {
        await this.riskEvents.persistWithinTransaction(transaction, {
          userId: input.userId,
          conversationId: input.conversationId,
          aiTurnId: input.turnId,
          triggerMessageId: null,
          clientRequestId: turn.clientRequestId,
          isIncognito: false,
          decision: input.decision,
          createdAt: input.now,
        });
      }

      await transaction
        .update(aiTurns)
        .set({ status: 'failed', failureCode: input.failureCode, completedAt: input.now })
        .where(eq(aiTurns.id, input.turnId));
    });
  }

  async complete(input: {
    turnId: string;
    userId: string;
    conversationId: string;
    assistantMessageId: string;
    assistantContent: string;
    now: Date;
  }): Promise<AiTurnRecord | null> {
    return this.databaseService.database.transaction(async (transaction) => {
      const [conversation] = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(activeOwnedConversation(input.userId, input.conversationId, input.now))
        .limit(1)
        .for('update');
      if (!conversation) {
        return null;
      }

      const [turn] = await transaction
        .select()
        .from(aiTurns)
        .where(
          and(
            eq(aiTurns.id, input.turnId),
            eq(aiTurns.userId, input.userId),
            eq(aiTurns.status, 'streaming'),
          ),
        )
        .limit(1)
        .for('update');
      if (!turn) {
        return null;
      }

      const sequenceNumber = await this.nextMessageSequence(transaction, input.conversationId);
      await transaction.insert(messages).values({
        id: input.assistantMessageId,
        conversationId: input.conversationId,
        role: 'assistant',
        sequenceNumber,
        content: input.assistantContent,
        createdAt: input.now,
      });

      const [completed] = await transaction
        .update(aiTurns)
        .set({
          status: 'completed',
          assistantMessageId: input.assistantMessageId,
          completedAt: input.now,
          failureCode: null,
        })
        .where(eq(aiTurns.id, input.turnId))
        .returning();
      return completed ?? null;
    });
  }

  async completeGrounded(input: {
    turnId: string;
    userId: string;
    conversationId: string;
    assistantMessageId: string;
    assistantContent: string;
    articleVersionIds: readonly string[];
    now: Date;
  }): Promise<AiTurnRecord | null> {
    return this.databaseService.database.transaction(async (transaction) => {
      const [conversation] = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(activeOwnedConversation(input.userId, input.conversationId, input.now))
        .limit(1)
        .for('update');
      if (!conversation) {
        return null;
      }

      const [turn] = await transaction
        .select()
        .from(aiTurns)
        .where(
          and(
            eq(aiTurns.id, input.turnId),
            eq(aiTurns.userId, input.userId),
            eq(aiTurns.status, 'streaming'),
          ),
        )
        .limit(1)
        .for('update');
      if (!turn) {
        return null;
      }

      const sequenceNumber = await this.nextMessageSequence(transaction, input.conversationId);
      await transaction.insert(messages).values({
        id: input.assistantMessageId,
        conversationId: input.conversationId,
        role: 'assistant',
        sequenceNumber,
        content: input.assistantContent,
        createdAt: input.now,
      });
      await this.knowledgeReferences.persistWithinTransaction(transaction, {
        assistantMessageId: input.assistantMessageId,
        articleVersionIds: input.articleVersionIds,
      });

      const [completed] = await transaction
        .update(aiTurns)
        .set({
          status: 'completed',
          assistantMessageId: input.assistantMessageId,
          completedAt: input.now,
          failureCode: null,
        })
        .where(eq(aiTurns.id, input.turnId))
        .returning();
      return completed ?? null;
    });
  }

  async finish(
    turnId: string,
    userId: string,
    status: 'failed' | 'cancelled',
    failureCode: string,
    now: Date,
  ): Promise<void> {
    await this.databaseService.database
      .update(aiTurns)
      .set({ status, failureCode, completedAt: now })
      .where(
        and(
          eq(aiTurns.id, turnId),
          eq(aiTurns.userId, userId),
          inArray(aiTurns.status, ['claimed', 'streaming']),
        ),
      );
  }

  private async nextMessageSequence(
    transaction: AppTransaction,
    conversationId: string,
  ): Promise<number> {
    const [sequence] = await transaction
      .select({ next: sql<number>`COALESCE(MAX(${messages.sequenceNumber}), 0) + 1` })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    return Number(sequence?.next ?? 1);
  }
}
