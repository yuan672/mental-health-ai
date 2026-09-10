import {
  Controller,
  Delete,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedSessionGuard } from '../../auth/authenticated-session.guard';
import type { AuthenticatedRequest } from '../../auth/authenticated-request';
import { CsrfGuard } from '../../auth/csrf.guard';
import { IncognitoContextsService } from './incognito-contexts.service';

@Controller('incognito-contexts')
export class IncognitoContextsController {
  constructor(private readonly contexts: IncognitoContextsService) {}

  @Post()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(AuthenticatedSessionGuard, CsrfGuard)
  async create(@Req() request: AuthenticatedRequest) {
    const context = await this.contexts.create(request.authenticatedSession);
    return {
      success: true,
      data: { context: { id: context.id, expiresAt: context.expiresAt } },
    };
  }

  @Delete(':contextId')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(AuthenticatedSessionGuard, CsrfGuard)
  end(
    @Req() request: AuthenticatedRequest,
    @Param('contextId', new ParseUUIDPipe()) contextId: string,
  ) {
    this.contexts.end(request.authenticatedSession, contextId);
    return { success: true, data: { ended: true } };
  }
}
