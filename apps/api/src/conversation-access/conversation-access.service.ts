import type {
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationMessagesResponse,
  ConversationMetadata,
  ConversationMessage,
  DeleteConversationHistoryResponse,
  DeleteConversationResponse,
} from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { ConversationService } from '../conversations/conversation.service';
import type { ConversationRecord } from '../conversations/conversation.repository';
import { MessageService } from '../messages/message.service';
import type { MessageRecord } from '../messages/message.repository';
import {
  conversationCursorSchema,
  messageCursorSchema,
  type PaginationQuery,
} from './conversation-access.schemas';

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
    now = new Date(),
  ): Promise<ConversationMessagesResponse> {
    const decoded = decodeOpaqueCursor(query.cursor, messageCursorSchema);
    const records = await this.messages.readMessagePage(userId, conversationId, {
      now,
      limit: query.limit + 1,
      beforeSequence: decoded?.sequence ?? null,
    });
    const hasNextPage = records.length > query.limit;
    const descendingPage = records.slice(0, query.limit);
    const oldest = descendingPage.at(-1);

    return {
      success: true,
      data: {
        messages: descendingPage.reverse().map(toConversationMessage),
        nextCursor:
          hasNextPage && oldest
            ? encodeOpaqueCursor({ kind: 'message', version: 1, sequence: oldest.sequenceNumber })
            : null,
      },
    };
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
