import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { knowledgeArticleKeySchema } from '../knowledge/knowledge.schemas';
import { KnowledgePublicationService } from '../knowledge/knowledge-publication.service';

async function run(): Promise<void> {
  const articleKey = knowledgeArticleKeySchema.parse(process.argv[2]);
  const version = Number(process.argv[3]);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error('A positive version is required');
  }
  const application = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  application.useLogger(application.get(Logger));
  try {
    const result = await application.get(KnowledgePublicationService).withdraw(articleKey, version);
    process.stdout.write(JSON.stringify({ event: 'knowledge_withdrawn', ...result }) + '\n');
  } finally {
    await application.close();
  }
}

void run().catch(() => {
  process.stderr.write(JSON.stringify({ event: 'knowledge_withdrawal_failed' }) + '\n');
  process.exitCode = 1;
});
