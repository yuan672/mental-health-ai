import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConversationModule } from '../conversations/conversation.module';
import { MessageModule } from '../messages/message.module';
import { ConversationAccessController } from './conversation-access.controller';
import { ConversationAccessService } from './conversation-access.service';

@Module({
  imports: [AuthModule, ConversationModule, MessageModule],
  controllers: [ConversationAccessController],
  providers: [ConversationAccessService],
})
export class ConversationAccessModule {}
