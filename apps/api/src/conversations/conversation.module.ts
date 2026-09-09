import { Module } from '@nestjs/common';
import { ConversationLoggingService } from './conversation-logging.service';
import { ConversationRepository } from './conversation.repository';
import { ConversationRetentionPolicy } from './conversation-retention.policy';
import { ConversationService } from './conversation.service';

@Module({
  providers: [
    ConversationLoggingService,
    ConversationRepository,
    ConversationRetentionPolicy,
    ConversationService,
  ],
  exports: [ConversationLoggingService, ConversationService],
})
export class ConversationModule {}
