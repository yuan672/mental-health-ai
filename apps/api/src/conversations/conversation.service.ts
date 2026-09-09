import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DatabaseError, NotFoundError, ValidationError } from '../common/errors';
import { ConversationLoggingService } from './conversation-logging.service';
import { ConversationRepository, type ConversationRecord } from './conversation.repository';
import { ConversationRetentionPolicy } from './conversation-retention.policy';

@Injectable()
export class ConversationService {
  constructor(
    private readonly logging: ConversationLoggingService,
    private readonly repository: ConversationRepository,
    private readonly retentionPolicy: ConversationRetentionPolicy,
  ) {}

  async create(userId: string, now = new Date()): Promise<ConversationRecord> {
    const conversation: ConversationRecord = {
      id: randomUUID(),
      userId,
      createdAt: now,
      expiresAt: this.retentionPolicy.getExpiresAt(now),
      isSaved: false,
      deletedAt: null,
    };

    let created: ConversationRecord;
    try {
      created = await this.repository.create(conversation);
    } catch {
      throw new DatabaseError();
    }

    this.logging.conversationCreated(userId, created.id);
    return created;
  }

  async get(userId: string, conversationId: string, now = new Date()): Promise<ConversationRecord> {
    let conversation: ConversationRecord | null;
    try {
      conversation = await this.repository.findActiveOwnedById(userId, conversationId, now);
    } catch {
      throw new DatabaseError();
    }

    if (!conversation) {
      throw new NotFoundError('对话不存在');
    }
    return conversation;
  }

  async save(
    userId: string,
    conversationId: string,
    now = new Date(),
  ): Promise<ConversationRecord> {
    let conversation: ConversationRecord | null;
    try {
      conversation = await this.repository.save(userId, conversationId, now);
    } catch {
      throw new DatabaseError();
    }

    if (!conversation) {
      throw new NotFoundError('对话不存在');
    }
    this.logging.conversationSaved(userId, conversationId);
    return conversation;
  }

  async delete(userId: string, conversationId: string, now = new Date()): Promise<void> {
    let deleted: boolean;
    try {
      deleted = await this.repository.delete(userId, conversationId, now);
    } catch {
      throw new DatabaseError();
    }

    if (!deleted) {
      throw new NotFoundError('对话不存在');
    }
    this.logging.conversationDeleted(userId, conversationId);
  }

  async purgeExpired(now: Date, batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new ValidationError('清理批次大小无效');
    }

    let count: number;
    try {
      count = await this.repository.purgeExpired(now, batchSize);
    } catch {
      throw new DatabaseError();
    }
    this.logging.conversationsPurged(count);
    return count;
  }
}
