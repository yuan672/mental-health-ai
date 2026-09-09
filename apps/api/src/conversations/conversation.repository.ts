import {
  and,
  asc,
  conversations,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  messages,
  or,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

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

@Injectable()
export class ConversationRepository {
  constructor(private readonly databaseService: DatabaseService) {}

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
      return true;
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
