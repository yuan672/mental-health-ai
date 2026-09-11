import { Controller, Get, Header, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import {
  knowledgeArticleListQuerySchema,
  knowledgeArticleParamsSchema,
  type KnowledgeArticleListQuery,
  type KnowledgeArticleParams,
} from './knowledge.schemas';
import { KnowledgeService } from './knowledge.service';

@Controller('knowledge/articles')
@UseGuards(AuthenticatedSessionGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(
    @Req() _request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(knowledgeArticleListQuerySchema)) query: KnowledgeArticleListQuery,
  ) {
    return this.knowledge.list(query);
  }

  @Get(':articleKey')
  @Header('Cache-Control', 'private, no-store')
  get(
    @Req() _request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(knowledgeArticleParamsSchema)) params: KnowledgeArticleParams,
  ) {
    return this.knowledge.get(params.articleKey);
  }
}
