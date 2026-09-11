import type {
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationMessagesResponse,
  ConversationMessagesResponseV2,
  ConversationMetadata,
  ConversationMessage,
  DeleteConversationHistoryResponse,
  DeleteConversationResponse,
} from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { AppError, ClientCapabilityRequiredError, DatabaseError } from '../common/errors';
import type { KnowledgeReferenceRepresentation } from '../common/http/knowledge-reference-capability';
import { ConversationService } from '../conversations/conversation.service';
import type { ConversationRecord } from '../conversations/conversation.repository';
import { MessageService } from '../messages/message.service';
import type { MessageRecord } from '../messages/message.repository';
import { KnowledgeMessageReferenceRepository } from '../knowledge/knowledge-message-reference.repository';
import { KnowledgeVisibilityPolicy } from '../knowledge/knowledge-visibility.policy';
import { DatabaseService } from '../database/database.service';
import { conversationMessagesResponseV2Schema } from '../ai/ai-public.schemas';
import {
  conversationCursorSchema,
  messageCursorSchema,
  type PaginationQuery,
} from './conversation-access.schemas';
import { toPublicKnowledgeReference } from './knowledge-reference.presenter';

function toConversationMetadata(record: ConversationRecord): ConversationMetadata {
  return {
    id: record.id,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString() ?? null,
    isSaved: record.isSaved,
  };
}

function toConversationMessage(record: MessageRecord): ConversationMessage {
  return {
    id: record.id,
    role: record.role,
    content: record.content,
    sequence: record.sequenceNumber,
    createdAt: record.createdAt.toISOString(),
  };
}

@Injectable()
export class ConversationAccessService {
  constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
    private readonly knowledgeReferences: KnowledgeMessageReferenceRepository,
    private readonly knowledgeVisibility: KnowledgeVisibilityPolicy,
    private readonly database: DatabaseService,
  ) {}

  async list(
    userId: string,
    query: PaginationQuery,
    now = new Date(),
  ): Promise<ConversationListResponse> {
    const decoded = decodeOpaqueCursor(query.cursor, conversationCursorSchema);
    const records = await this.conversations.list(userId, {
      now,
      limit: query.limit + 1,
      cursor: decoded ? { createdAt: new Date(decoded.createdAt), id: decoded.id } : null,
    });
    const hasNextPage = records.length > query.limit;
    const page = records.slice(0, query.limit);
    const last = page.at(-1);

    return {
      success: true,
      data: {
        conversations: page.map(toConversationMetadata),
        nextCursor:
          hasNextPage && last
            ? encodeOpaqueCursor({
                kind: 'conversation',
                version: 1,
                createdAt: last.createdAt.toISOString(),
                id: last.id,
              })
            : null,
      },
    };
  }

  async get(
    userId: string,
    conversationId: string,
    now = new Date(),
  ): Promise<ConversationDetailResponse> {
    const conversation = await this.conversations.get(userId, conversationId, now);
    return {
      success: true,
      data: { conversation: toConversationMetadata(conversation) },
    };
  }

  async listMessages(
    userId: string,
    conversationId: string,
    query: PaginationQuery,
    representation: KnowledgeReferenceRepresentation = 'v1',
    now = new Date(),
  ): Promise<ConversationMessagesResponse | ConversationMessagesResponseV2> {
    const decoded = decodeOpaqueCursor(query.cursor, messageCursorSchema);
    let snapshot;
    try {
      snapshot = await this.database.database.transaction(
        async (transaction) => {
          const records = await this.messages.readMessagePageWithinTransaction(
            transaction,
            userId,
            conversationId,
            {
              now,
              limit: query.limit + 1,
              beforeSequence: decoded?.sequence ?? null,
            },
          );
          const assistantMessageIds = records
            .slice(0, query.limit)
            .filter((message) => message.role === 'assistant')
            .map((message) => message.id);
          const references = await this.knowledgeReferences.findOwnedByMessageIdsWithinTransaction(
            transaction,
            userId,
            assistantMessageIds,
          );
          return { records, references };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new DatabaseError();
    }

    const { records, references: storedReferences } = snapshot;
    const hasNextPage = records.length > query.limit;
    const descendingPage = records.slice(0, query.limit);
    const oldest = descendingPage.at(-1);
    const assistantMessageIds = descendingPage
      .filter((message) => message.role === 'assistant')
      .map((message) => message.id);
    if (representation === 'v1' && storedReferences.length > 0) {
      throw new ClientCapabilityRequiredError();
    }
    if (
      representation === 'v2' &&
      storedReferences.some(
        (reference) =>
          !this.knowledgeVisibility.isVisible(reference.contentOrigin, reference.reviewStatus),
      )
    ) {
      throw new DatabaseError('知识引用暂时无法读取');
    }
    const referencesByMessage = new Map<string, ReturnType<typeof toPublicKnowledgeReference>[]>();
    if (representation === 'v2') {
      try {
        const requestedMessageIds = new Set(assistantMessageIds);
        for (const storedReference of [...storedReferences].sort(
          (left, right) => left.ordinal - right.ordinal,
        )) {
          if (!requestedMessageIds.has(storedReference.assistantMessageId)) {
            throw new Error('Knowledge reader returned a reference outside the requested page');
          }
          const current = referencesByMessage.get(storedReference.assistantMessageId) ?? [];
          if (current.length >= 2) {
            throw new Error('Knowledge reader returned too many references for one message');
          }
          current.push(toPublicKnowledgeReference(storedReference));
          referencesByMessage.set(storedReference.assistantMessageId, current);
        }
      } catch {
        throw new DatabaseError('知识引用暂时无法读取');
      }
    }

    const messages = descendingPage.reverse().map(toConversationMessage);

    const response = {
      success: true,
      data: {
        messages:
          representation === 'v2'
            ? messages.map((message) => ({
                ...message,
                knowledgeReferences: referencesByMessage.get(message.id) ?? [],
              }))
            : messages,
        nextCursor:
          hasNextPage && oldest
            ? encodeOpaqueCursor({ kind: 'message', version: 1, sequence: oldest.sequenceNumber })
            : null,
      },
    };
    if (representation === 'v2') {
      try {
        return conversationMessagesResponseV2Schema.parse(response);
      } catch {
        throw new DatabaseError('知识引用暂时无法读取');
      }
    }
    return response as ConversationMessagesResponse;
  }

  async save(
    userId: string,
    conversationId: string,
    now = new Date(),
  ): Promise<ConversationDetailResponse> {
    const conversation = await this.conversations.save(userId, conversationId, now);
    return {
      success: true,
      data: { conversation: toConversationMetadata(conversation) },
    };
  }

  async delete(
    userId: string,
    conversationId: string,
    now = new Date(),
  ): Promise<DeleteConversationResponse> {
    await this.conversations.delete(userId, conversationId, now);
    return { success: true, data: { deleted: true } };
  }

  async deleteAll(userId: string, now = new Date()): Promise<DeleteConversationHistoryResponse> {
    const result = await this.conversations.deleteAll(userId, now);
    return {
      success: true,
      data: { deleted: true, conversationCount: result.conversationCount },
    };
  }
}
