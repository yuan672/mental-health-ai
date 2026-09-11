import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeFixtureService } from './knowledge-fixture.service';
import { KnowledgeMessageReferenceRepository } from './knowledge-message-reference.repository';
import { KnowledgePublicationRepository } from './knowledge-publication.repository';
import { KnowledgePublicationService } from './knowledge-publication.service';
import { KnowledgeRepository } from './knowledge.repository';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeVisibilityPolicy } from './knowledge-visibility.policy';

@Module({
  imports: [AuthModule],
  controllers: [KnowledgeController],
  providers: [
    KnowledgeFixtureService,
    KnowledgeMessageReferenceRepository,
    KnowledgePublicationRepository,
    KnowledgePublicationService,
    KnowledgeRepository,
    KnowledgeService,
    KnowledgeVisibilityPolicy,
  ],
  exports: [
    KnowledgeFixtureService,
    KnowledgeMessageReferenceRepository,
    KnowledgePublicationService,
    KnowledgeService,
  ],
})
export class KnowledgeModule {}
