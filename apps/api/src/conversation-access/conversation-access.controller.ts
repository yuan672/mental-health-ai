import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import {
  conversationIdParamsSchema,
  paginationQuerySchema,
  type ConversationIdParams,
  type PaginationQuery,
} from './conversation-access.schemas';
import { ConversationAccessService } from './conversation-access.service';

@Controller('conversations')
@UseGuards(AuthenticatedSessionGuard)
export class ConversationAccessController {
  constructor(private readonly access: ConversationAccessService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.access.list(request.authenticatedSession.userId, query);
  }

  @Get(':id/messages')
  @Header('Cache-Control', 'private, no-store')
  listMessages(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(conversationIdParamsSchema)) params: ConversationIdParams,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.access.listMessages(request.authenticatedSession.userId, params.id, query);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  get(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(conversationIdParamsSchema)) params: ConversationIdParams,
  ) {
    return this.access.get(request.authenticatedSession.userId, params.id);
  }

  @Post(':id/save')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  save(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(conversationIdParamsSchema)) params: ConversationIdParams,
  ) {
    return this.access.save(request.authenticatedSession.userId, params.id);
  }

  @Delete(':id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  delete(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(conversationIdParamsSchema)) params: ConversationIdParams,
  ) {
    return this.access.delete(request.authenticatedSession.userId, params.id);
  }

  @Delete()
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  deleteAll(@Req() request: AuthenticatedRequest) {
    return this.access.deleteAll(request.authenticatedSession.userId);
  }
}
