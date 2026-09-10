import type { PinoLogger } from 'nestjs-pino';
import { ConversationLoggingService } from '../src/conversations/conversation-logging.service';

describe('ConversationLoggingService', () => {
  it('accepts only structured identifiers and role for message events', () => {
    const logger = {
      info: jest.fn(),
      setContext: jest.fn(),
    } as unknown as PinoLogger;
    const logging = new ConversationLoggingService(logger);

    logging.messageAppended('user-id', 'conversation-id', 'message-id', 'user');

    expect(logger.info).toHaveBeenCalledWith({
      event: 'message_appended',
      userId: 'user-id',
      conversationId: 'conversation-id',
      messageId: 'message-id',
      role: 'user',
    });
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('content');
  });

  it('logs aggregate history deletion without accepting conversation content', () => {
    const logger = {
      info: jest.fn(),
      setContext: jest.fn(),
    } as unknown as PinoLogger;
    const logging = new ConversationLoggingService(logger);

    logging.conversationHistoryDeleted('user-id', 3);

    expect(logger.info).toHaveBeenCalledWith({
      event: 'conversation_history_deleted',
      userId: 'user-id',
      conversationCount: 3,
    });
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toMatch(
      /message|content|prompt|preview/iu,
    );
  });
});
