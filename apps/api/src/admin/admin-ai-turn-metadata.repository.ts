import {
  aiTurns,
  and,
  conversations,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  or,
  type AppTransaction,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type {
  AdminAiTurnStatus,
  StoredAdminAiTurnMetadata,
} from './admin-ai-turn-metadata.schemas';

export type AdminAiTurnMetadataCursorPosition = Readonly<{ createdAt: Date; id: string }>;

export type AdminAiTurnMetadataRepositoryQuery = Readonly<{
  status: AdminAiTurnStatus | null;
  createdFrom: Date;
  createdBefore: Date;
  observedAt: Date;
  cursor: AdminAiTurnMetadataCursorPosition | null;
  limit: number;
}>;

const projection = {
  id: aiTurns.id,
  status: aiTurns.status,
  promptKey: aiTurns.promptKey,
  promptVersion: aiTurns.promptVersion,
  failureCode: aiTurns.failureCode,
  leaseExpiresAt: aiTurns.leaseExpiresAt,
  createdAt: aiTurns.createdAt,
  startedAt: aiTurns.startedAt,
  completedAt: aiTurns.completedAt,
};

@Injectable()
export class AdminAiTurnMetadataRepository {
  constructor(private readonly database: DatabaseService) {}

  readTransaction<T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return this.database.database.transaction(work, {
      isolationLevel: 'repeatable read',
      accessMode: 'read write',
    });
  }

  list(
    tx: AppTransaction,
    input: AdminAiTurnMetadataRepositoryQuery,
  ): Promise<StoredAdminAiTurnMetadata[]> {
    const cursorPredicate = input.cursor
      ? or(
          lt(aiTurns.createdAt, input.cursor.createdAt),
          and(eq(aiTurns.createdAt, input.cursor.createdAt), lt(aiTurns.id, input.cursor.id)),
        )
      : undefined;

    return tx
      .select(projection)
      .from(aiTurns)
      .innerJoin(conversations, eq(conversations.id, aiTurns.conversationId))
      .where(
        and(
          isNull(conversations.deletedAt),
          or(eq(conversations.isSaved, true), gt(conversations.expiresAt, input.observedAt)),
          input.status ? eq(aiTurns.status, input.status) : undefined,
          gte(aiTurns.createdAt, input.createdFrom),
          lt(aiTurns.createdAt, input.createdBefore),
          cursorPredicate,
        ),
      )
      .orderBy(desc(aiTurns.createdAt), desc(aiTurns.id))
      .limit(input.limit);
  }

  findVisibleById(
    tx: AppTransaction,
    turnId: string,
    observedAt: Date,
  ): Promise<StoredAdminAiTurnMetadata | undefined> {
    return tx
      .select(projection)
      .from(aiTurns)
      .innerJoin(conversations, eq(conversations.id, aiTurns.conversationId))
      .where(
        and(
          eq(aiTurns.id, turnId),
          isNull(conversations.deletedAt),
          or(eq(conversations.isSaved, true), gt(conversations.expiresAt, observedAt)),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
  }
}
