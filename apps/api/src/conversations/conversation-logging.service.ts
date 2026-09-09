import type { MessageRole } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class ConversationLoggingService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ConversationLoggingService.name);
  }

  conversationCreated(userId: string, conversationId: string): void {
    this.logger.info({ event: 'conversation_created', userId, conversationId });
  }

  conversationSaved(userId: string, conversationId: string): void {
    this.logger.info({ event: 'conversation_saved', userId, conversationId });
  }

  conversationDeleted(userId: string, conversationId: string): void {
    this.logger.info({ event: 'conversation_deleted', userId, conversationId });
  }

  messageAppended(
    userId: string,
    conversationId: string,
    messageId: string,
    role: MessageRole,
  ): void {
    this.logger.info({ event: 'message_appended', userId, conversationId, messageId, role });
  }

  conversationsPurged(count: number): void {
    this.logger.info({ event: 'conversations_purged', count });
  }
}
