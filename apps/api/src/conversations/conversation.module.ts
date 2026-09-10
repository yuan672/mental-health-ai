import { Module } from '@nestjs/common';
import { AuditModule } from '../safety/audit/audit.module';
import { ConversationLoggingService } from './conversation-logging.service';
import { ConversationRepository } from './conversation.repository';
import { ConversationRetentionPolicy } from './conversation-retention.policy';
import { ConversationService } from './conversation.service';

@Module({
  imports: [AuditModule],
  providers: [
    ConversationLoggingService,
    ConversationRepository,
    ConversationRetentionPolicy,
    ConversationService,
  ],
  exports: [ConversationLoggingService, ConversationService],
})
export class ConversationModule {}
