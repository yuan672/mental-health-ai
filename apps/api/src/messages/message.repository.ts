import {
  and,
  asc,
  conversations,
  desc,
  eq,
  gt,
  isNull,
  lt,
  messages,
  or,
  sql,
  type AppTransaction,
  type MessageRole,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type MessageRecord = {
  id: string;
  conversationId: string;
  role: MessageRole;
  sequenceNumber: number;
  content: string;
  createdAt: Date;
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
export class MessageRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async append(input: {
    id: string;
    userId: string;
    conversationId: string;
    role: MessageRole;
    content: string;
    createdAt: Date;
  }): Promise<MessageRecord | null> {
    return this.databaseService.database.transaction(async (transaction) => {
      const [conversation] = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(activeOwnedConversation(input.userId, input.conversationId, input.createdAt))
        .limit(1)
        .for('update');

      if (!conversation) {
        return null;
      }

      const [sequence] = await transaction
        .select({
          next: sql<number>`COALESCE(MAX(${messages.sequenceNumber}), 0) + 1`,
        })
        .from(messages)
        .where(eq(messages.conversationId, input.conversationId));

      const [message] = await transaction
        .insert(messages)
        .values({
          id: input.id,
          conversationId: input.conversationId,
          role: input.role,
          sequenceNumber: Number(sequence?.next ?? 1),
          content: input.content,
          createdAt: input.createdAt,
        })
        .returning();

      if (!message) {
        throw new Error('Message insert returned no record');
      }
      return message;
    });
  }

  async readActiveOwned(
    userId: string,
    conversationId: string,
    now: Date,
  ): Promise<MessageRecord[] | null> {
    const [conversation] = await this.databaseService.database
      .select({ id: conversations.id })
      .from(conversations)
      .where(activeOwnedConversation(userId, conversationId, now))
      .limit(1);

    if (!conversation) {
      return null;
    }

    return this.databaseService.database
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.sequenceNumber));
  }

  async readActiveOwnedPage(
    userId: string,
    conversationId: string,
    now: Date,
    limit: number,
    beforeSequence: number | null,
  ): Promise<MessageRecord[] | null> {
    return this.databaseService.database.transaction(
      (transaction) =>
        this.readActiveOwnedPageWithinTransaction(
          transaction,
          userId,
          conversationId,
          now,
          limit,
          beforeSequence,
        ),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async readActiveOwnedPageWithinTransaction(
    transaction: AppTransaction,
    userId: string,
    conversationId: string,
    now: Date,
    limit: number,
    beforeSequence: number | null,
  ): Promise<MessageRecord[] | null> {
    const [conversation] = await transaction
      .select({ id: conversations.id })
      .from(conversations)
      .where(activeOwnedConversation(userId, conversationId, now))
      .limit(1);

    if (!conversation) {
      return null;
    }

    return transaction
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          beforeSequence === null ? undefined : lt(messages.sequenceNumber, beforeSequence),
        ),
      )
      .orderBy(desc(messages.sequenceNumber))
      .limit(limit);
  }
}
