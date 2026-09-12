import type {
  DeleteMoodEntryRequest,
  NormalizedCreateMoodEntryRequest,
  NormalizedUpdateMoodEntryRequest,
} from '@mental-health/types';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { HttpIngress, HttpPrincipal } from '../http-abuse/http-abuse.metadata';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import {
  createMoodEntryRequestSchema,
  deleteMoodEntryRequestSchema,
  moodCreationStatusParamsSchema,
  moodEntryIdParamsSchema,
  moodHistoryQuerySchema,
  updateMoodEntryRequestSchema,
  type MoodCreationStatusParams,
  type MoodEntryIdParams,
  type MoodHistoryQuery,
} from './mood.schemas';
import { MoodService } from './mood.service';

@Controller('mood-entries')
@UseGuards(AuthenticatedSessionGuard)
@HttpPrincipal('principal_general')
export class MoodController {
  constructor(private readonly mood: MoodService) {}

  @Post()
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createMoodEntryRequestSchema))
    body: NormalizedCreateMoodEntryRequest,
  ) {
    return this.mood.create(request.authenticatedSession.userId, body);
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(moodHistoryQuerySchema)) query: MoodHistoryQuery,
  ) {
    return this.mood.list(request.authenticatedSession.userId, query);
  }

  @Get('creation-status/:clientRequestId')
  @HttpIngress('control')
  @HttpPrincipal('control_recovery')
  @Header('Cache-Control', 'private, no-store')
  creationStatus(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(moodCreationStatusParamsSchema))
    params: MoodCreationStatusParams,
  ) {
    return this.mood.creationStatus(request.authenticatedSession.userId, params.clientRequestId);
  }

  @Get(':id')
  @HttpIngress('control')
  @HttpPrincipal('control_recovery')
  @Header('Cache-Control', 'private, no-store')
  get(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(moodEntryIdParamsSchema)) params: MoodEntryIdParams,
  ) {
    return this.mood.get(request.authenticatedSession.userId, params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(moodEntryIdParamsSchema)) params: MoodEntryIdParams,
    @Body(new ZodValidationPipe(updateMoodEntryRequestSchema))
    body: NormalizedUpdateMoodEntryRequest,
  ) {
    return this.mood.update(request.authenticatedSession.userId, params.id, body);
  }

  @Delete(':id')
  @HttpIngress('control')
  @HttpPrincipal('control_recovery')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  delete(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(moodEntryIdParamsSchema)) params: MoodEntryIdParams,
    @Body(new ZodValidationPipe(deleteMoodEntryRequestSchema)) body: DeleteMoodEntryRequest,
  ) {
    return this.mood.delete(request.authenticatedSession.userId, params.id, body.expectedRevision);
  }

  @Delete()
  @HttpIngress('control')
  @HttpPrincipal('control_recovery')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  deleteAll(@Req() request: AuthenticatedRequest) {
    return this.mood.deleteAll(request.authenticatedSession.userId);
  }
}
