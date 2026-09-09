import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversations/conversation.module';
import { MessageRepository } from './message.repository';
import { MessageService } from './message.service';

@Module({
  imports: [ConversationModule],
  providers: [MessageRepository, MessageService],
  exports: [MessageService],
})
export class MessageModule {}
