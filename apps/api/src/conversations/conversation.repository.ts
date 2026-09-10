import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  conversations,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  messages,
  or,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';

export type ConversationRecord = {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date | null;
  isSaved: boolean;
  deletedAt: Date | null;
};

function activeOwnedConversation(userId: string, conversationId: string, now: Date) {
  return and(
    eq(conversations.id, conversationId),
    eq(conversations.userId, userId),
    isNull(conversations.deletedAt),
    or(eq(conversations.isSaved, true), gt(conversations.expiresAt, now)),
  );
}

function activeOwnedConversations(userId: string, now: Date) {
  return and(
    eq(conversations.userId, userId),
    isNull(conversations.deletedAt),
    or(eq(conversations.isSaved, true), gt(conversations.expiresAt, now)),
  );
}

export type ConversationListCursor = Readonly<{
  createdAt: Date;
  id: string;
}>;

export type DeleteAllConversationsResult = Readonly<{
  conversationCount: number;
  messageCount: number;
}>;

@Injectable()
export class ConversationRepository {
  constructor(
    private readonly audits: AuditLogRepository,
    private readonly databaseService: DatabaseService,
  ) {}

  async create(input: ConversationRecord): Promise<ConversationRecord> {
    const [conversation] = await this.databaseService.database
      .insert(conversations)
      .values(input)
      .returning();

    if (!conversation) {
      throw new Error('Conversation insert returned no record');
    }
    return conversation;
  }

  async findActiveOwnedById(
    userId: string,
    conversationId: string,
    now: Date,
  ): Promise<ConversationRecord | null> {
    const [conversation] = await this.databaseService.database
      .select()
      .from(conversations)
      .where(activeOwnedConversation(userId, conversationId, now))
      .limit(1);

    return conversation ?? null;
  }

  listActiveOwned(
    userId: string,
    now: Date,
    limit: number,
    cursor: ConversationListCursor | null,
  ): Promise<ConversationRecord[]> {
    const cursorPredicate = cursor
      ? or(
          lt(conversations.createdAt, cursor.createdAt),
          and(eq(conversations.createdAt, cursor.createdAt), lt(conversations.id, cursor.id)),
        )
      : undefined;

    return this.databaseService.database
      .select()
      .from(conversations)
      .where(and(activeOwnedConversations(userId, now), cursorPredicate))
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(limit);
  }

  async save(
    userId: string,
    conversationId: string,
    now: Date,
  ): Promise<ConversationRecord | null> {
    const [conversation] = await this.databaseService.database
      .update(conversations)
      .set({ isSaved: true, expiresAt: null })
      .where(activeOwnedConversation(userId, conversationId, now))
      .returning();

    return conversation ?? null;
  }

  async delete(userId: string, conversationId: string, now: Date): Promise<boolean> {
    return this.databaseService.database.transaction(async (transaction) => {
      const [conversation] = await transaction
        .update(conversations)
        .set({ deletedAt: now })
        .where(activeOwnedConversation(userId, conversationId, now))
        .returning({ id: conversations.id });

      if (!conversation) {
        return false;
      }

      await transaction.delete(messages).where(eq(messages.conversationId, conversation.id));
      await this.audits.appendWithinTransaction(transaction, {
        actorType: 'user',
        actorId: userId,
        action: 'conversation_deleted',
        resourceType: 'conversation',
        resourceId: conversation.id,
        idempotencyKey: `conversation_deleted:${userId}:${conversation.id}`,
        safeMetadata: {},
        occurredAt: now,
      });
      return true;
    });
  }

  async deleteAll(userId: string, now: Date): Promise<DeleteAllConversationsResult> {
    return this.databaseService.database.transaction(async (transaction) => {
      const selected = await transaction
        .update(conversations)
        .set({ deletedAt: now })
        .where(and(eq(conversations.userId, userId), isNull(conversations.deletedAt)))
        .returning({ id: conversations.id });

      if (selected.length === 0) {
        return { conversationCount: 0, messageCount: 0 };
      }

      const deletedMessages = await transaction
        .delete(messages)
        .where(
          inArray(
            messages.conversationId,
            selected.map((conversation) => conversation.id),
          ),
        )
        .returning({ id: messages.id });

      await this.audits.appendWithinTransaction(transaction, {
        actorType: 'user',
        actorId: userId,
        action: 'conversation_history_deleted',
        resourceType: 'conversation_history',
        resourceId: userId,
        idempotencyKey: `conversation_history_deleted:${userId}:${randomUUID()}`,
        safeMetadata: {
          conversationCount: selected.length,
          messageCount: deletedMessages.length,
        },
        occurredAt: now,
      });

      return {
        conversationCount: selected.length,
        messageCount: deletedMessages.length,
      };
    });
  }

  async purgeExpired(now: Date, batchSize: number): Promise<number> {
    return this.databaseService.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          or(
            isNotNull(conversations.deletedAt),
            and(eq(conversations.isSaved, false), lte(conversations.expiresAt, now)),
          ),
        )
        .orderBy(asc(conversations.id))
        .limit(batchSize);

      if (candidates.length === 0) {
        return 0;
      }

      const deleted = await transaction
        .delete(conversations)
        .where(
          inArray(
            conversations.id,
            candidates.map((candidate) => candidate.id),
          ),
        )
        .returning({ id: conversations.id });

      return deleted.length;
    });
  }
}
