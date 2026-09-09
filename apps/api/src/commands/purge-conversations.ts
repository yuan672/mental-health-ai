import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { ConversationService } from '../conversations/conversation.service';

const CLEANUP_BATCH_SIZE = 500;

async function run(): Promise<void> {
  const application = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  application.useLogger(application.get(Logger));

  try {
    const conversationService = application.get(ConversationService);
    const cutoff = new Date();
    let deletedCount: number;

    do {
      deletedCount = await conversationService.purgeExpired(cutoff, CLEANUP_BATCH_SIZE);
    } while (deletedCount === CLEANUP_BATCH_SIZE);
  } finally {
    await application.close();
  }
}

void run().catch(() => {
  process.stderr.write(
    JSON.stringify({ level: 'error', event: 'conversation_cleanup_failed' }) + '\n',
  );
  process.exitCode = 1;
});
