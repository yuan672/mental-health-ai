import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { consentMutationSchema, type ConsentMutationRequest } from './consents.schemas';
import { ConsentsService } from './consents.service';

@Controller('consents')
export class ConsentsController {
  constructor(private readonly consentsService: ConsentsService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  async list(@Req() request: AuthenticatedRequest) {
    const consents = await this.consentsService.list(request.authenticatedSession.userId);
    return { success: true, data: { consents } };
  }

  @Post()
  @HttpCode(200)
  @UseGuards(AuthenticatedSessionGuard, CsrfGuard)
  async mutate(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(consentMutationSchema)) body: ConsentMutationRequest,
  ) {
    const userId = request.authenticatedSession.userId;
    const consent =
      body.action === 'accept'
        ? await this.consentsService.accept(userId, body.consentType, body.consentVersion)
        : await this.consentsService.withdraw(userId, body.consentType, body.consentVersion);

    return { success: true, data: { consent } };
  }
}
