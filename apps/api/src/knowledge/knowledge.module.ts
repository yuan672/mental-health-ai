import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeFixtureService } from './knowledge-fixture.service';
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
    KnowledgePublicationRepository,
    KnowledgePublicationService,
    KnowledgeRepository,
    KnowledgeService,
    KnowledgeVisibilityPolicy,
  ],
  exports: [KnowledgeFixtureService, KnowledgePublicationService, KnowledgeService],
})
export class KnowledgeModule {}
