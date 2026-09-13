import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { CsrfGuard } from '../auth/csrf.guard';
import { clearAuthenticationCookies } from '../common/http/cookies';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { env } from '../config/env';
import { HttpIngress, HttpPrincipal } from '../http-abuse/http-abuse.metadata';
import { createHttpRequestLifecycle } from '../http-abuse/http-request-lifecycle';
import { AccountDeletionService } from './account-deletion.service';
import {
  accountDeletionRequestSchema,
  type AccountDeletionRequest,
} from './account-deletion.schemas';

@Controller('account')
export class AccountDeletionController {
  constructor(private readonly accountDeletion: AccountDeletionService) {}

  @Post('deletion')
  @HttpCode(204)
  @HttpIngress('control')
  @HttpPrincipal('control_recovery')
  @UseGuards(AuthenticatedSessionGuard, CsrfGuard)
  async deleteCurrentAccount(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Body(new ZodValidationPipe(accountDeletionRequestSchema)) body: AccountDeletionRequest,
  ): Promise<void> {
    const lifecycle = createHttpRequestLifecycle(
      request,
      response,
      env.ACCOUNT_DELETION_TIMEOUT_MS,
    );
    const deadlineAt = new Date(Date.now() + env.ACCOUNT_DELETION_TIMEOUT_MS);
    try {
      await this.accountDeletion.deleteCurrentAccount({
        session: request.authenticatedSession,
        request: body,
        signal: lifecycle.signal,
        deadlineAt,
      });
      if (!response.destroyed && !response.writableEnded) {
        clearAuthenticationCookies(response);
      }
    } finally {
      lifecycle.dispose();
    }
  }
}
