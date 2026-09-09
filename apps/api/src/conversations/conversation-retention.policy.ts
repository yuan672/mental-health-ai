import { Injectable } from '@nestjs/common';

export const CONVERSATION_RETENTION_DAYS = 90;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class ConversationRetentionPolicy {
  getExpiresAt(createdAt: Date): Date {
    return new Date(createdAt.getTime() + CONVERSATION_RETENTION_DAYS * MILLISECONDS_PER_DAY);
  }
}
