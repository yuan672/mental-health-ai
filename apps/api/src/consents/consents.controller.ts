import type { ConsentMutationRequest } from '@mental-health/types';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import {
  consentHistoryQuerySchema,
  consentMutationSchema,
  type ConsentHistoryQuery,
} from './consents.schemas';
import { ConsentsService } from './consents.service';
import { HttpAbuseAdmissionService } from '../http-abuse/http-abuse-admission.service';
import { HttpIngress, HttpPrincipal } from '../http-abuse/http-abuse.metadata';

@Controller('consents')
export class ConsentsController {
  constructor(
    private readonly consentsService: ConsentsService,
    private readonly httpAdmission: HttpAbuseAdmissionService,
  ) {}

  @Get()
  @HttpIngress('control')
  @HttpPrincipal('control_recovery')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(AuthenticatedSessionGuard)
  list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(consentHistoryQuerySchema)) query: ConsentHistoryQuery,
  ) {
    return this.consentsService.list(request.authenticatedSession.userId, query);
  }

  @Post()
  @HttpIngress('mixed')
  @HttpPrincipal('manual')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(AuthenticatedSessionGuard, CsrfGuard)
  async mutate(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(consentMutationSchema)) body: ConsentMutationRequest,
  ) {
    const userId = request.authenticatedSession.userId;
    this.httpAdmission.admit('classification_probe', userId, 'user');
    const lane = await this.consentsService.classifyHttpAdmission(userId, body);
    this.httpAdmission.admit(lane, userId, 'user');
    return this.consentsService.mutate(userId, body);
  }
}
