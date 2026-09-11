import type { KnowledgeContentOrigin, KnowledgeReviewStatus } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { env, type AppEnvironment } from '../config/env';

@Injectable()
export class KnowledgeVisibilityPolicy {
  isVisible(
    contentOrigin: KnowledgeContentOrigin,
    reviewStatus: KnowledgeReviewStatus,
    appEnvironment: AppEnvironment['APP_ENV'] = env.APP_ENV,
  ): boolean {
    if (contentOrigin === 'curated') return reviewStatus === 'source_verified';
    return (
      contentOrigin === 'synthetic_fixture' &&
      reviewStatus === 'unverified' &&
      (appEnvironment === 'development' || appEnvironment === 'test')
    );
  }

  permitsSynthetic(appEnvironment: AppEnvironment['APP_ENV'] = env.APP_ENV): boolean {
    return appEnvironment === 'development' || appEnvironment === 'test';
  }
}
