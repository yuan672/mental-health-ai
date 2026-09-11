import { Injectable } from '@nestjs/common';
import { KnowledgePublicationForbiddenError } from '../common/errors';
import { env } from '../config/env';
import { KnowledgePublicationRepository } from './knowledge-publication.repository';
import {
  KnowledgePublicationService,
  type KnowledgePublishResult,
} from './knowledge-publication.service';
import { syntheticKnowledgeManifestSchema } from './knowledge.schemas';

export function assertSyntheticKnowledgeFixtureEnvironment(
  appEnvironment: string | undefined,
  connectionString: string,
): void {
  if (appEnvironment !== 'development' && appEnvironment !== 'test') {
    throw new KnowledgePublicationForbiddenError();
  }
  if (appEnvironment === 'test') {
    const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new KnowledgePublicationForbiddenError('合成知识 fixture 仅允许写入 _test 数据库');
    }
  }
}

@Injectable()
export class KnowledgeFixtureService extends KnowledgePublicationService {
  constructor(repository: KnowledgePublicationRepository) {
    super(repository);
  }

  async publishSynthetic(input: unknown, now = new Date()): Promise<KnowledgePublishResult> {
    assertSyntheticKnowledgeFixtureEnvironment(env.APP_ENV, env.DATABASE_URL);
    return this.publishValidated(syntheticKnowledgeManifestSchema.parse(input), now);
  }
}
