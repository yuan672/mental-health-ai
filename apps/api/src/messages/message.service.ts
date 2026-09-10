import { randomUUID } from 'node:crypto';
import type { MessageRole } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseError, NotFoundError, ValidationError } from '../common/errors';
import { ConversationLoggingService } from '../conversations/conversation-logging.service';
import { MessageRepository, type MessageRecord } from './message.repository';

@Injectable()
export class MessageService {
  constructor(
    private readonly logging: ConversationLoggingService,
    private readonly repository: MessageRepository,
  ) {}

  async appendMessage(
    userId: string,
    conversationId: string,
    role: MessageRole,
    content: string,
    now = new Date(),
  ): Promise<MessageRecord> {
    if (content.length === 0) {
      throw new ValidationError('消息内容不能为空');
    }

    let message: MessageRecord | null;
    try {
      message = await this.repository.append({
        id: randomUUID(),
        userId,
        conversationId,
        role,
        content,
        createdAt: now,
      });
    } catch {
      throw new DatabaseError();
    }

    if (!message) {
      throw new NotFoundError('对话不存在');
    }

    this.logging.messageAppended(userId, conversationId, message.id, message.role);
    return message;
  }

  async readMessages(
    userId: string,
    conversationId: string,
    now = new Date(),
  ): Promise<MessageRecord[]> {
    let records: MessageRecord[] | null;
    try {
      records = await this.repository.readActiveOwned(userId, conversationId, now);
    } catch {
      throw new DatabaseError();
    }

    if (!records) {
      throw new NotFoundError('对话不存在');
    }

    return records;
  }

  async readMessagePage(
    userId: string,
    conversationId: string,
    options: Readonly<{ now: Date; limit: number; beforeSequence: number | null }>,
  ): Promise<MessageRecord[]> {
    let records: MessageRecord[] | null;
    try {
      records = await this.repository.readActiveOwnedPage(
        userId,
        conversationId,
        options.now,
        options.limit,
        options.beforeSequence,
      );
    } catch {
      throw new DatabaseError();
    }

    if (!records) {
      throw new NotFoundError('对话不存在');
    }

    return records;
  }
}
