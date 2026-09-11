import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { loadKnowledgeManifest } from '../knowledge/knowledge-manifest.loader';
import { KnowledgePublicationService } from '../knowledge/knowledge-publication.service';

async function run(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('A curated manifest path is required');
  const manifest = await loadKnowledgeManifest(path);
  const application = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  application.useLogger(application.get(Logger));
  try {
    const result = await application.get(KnowledgePublicationService).publishCurated(manifest);
    process.stdout.write(JSON.stringify({ event: 'knowledge_published', ...result }) + '\n');
  } finally {
    await application.close();
  }
}

void run().catch(() => {
  process.stderr.write(JSON.stringify({ event: 'knowledge_publication_failed' }) + '\n');
  process.exitCode = 1;
});
