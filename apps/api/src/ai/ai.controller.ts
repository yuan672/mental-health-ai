import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { AiStreamEvent } from '@mental-health/types';
import type { Response } from 'express';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { CsrfGuard } from '../auth/csrf.guard';
import { AppError, ERROR_CODES } from '../common/errors';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { AiOrchestrationService } from './ai-orchestration.service';
import { aiChatRequestSchema, type AiChatRequest } from './ai.schemas';

function writeSse(response: Response, event: AiStreamEvent, sequence: number): void {
  response.write(`id: ${event.data.turnId}:${sequence}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

function failedEvent(turnId: string, error: unknown): AiStreamEvent {
  const appError =
    error instanceof AppError
      ? error
      : new AppError(ERROR_CODES.INTERNAL_ERROR, 500, '服务器内部错误');
  return {
    type: 'turn.failed',
    data: { turnId, code: appError.code, message: appError.message },
  };
}

@Controller('ai')
export class AiController {
  constructor(private readonly orchestration: AiOrchestrationService) {}

  @Post('chat/stream')
  @UseGuards(AuthenticatedSessionGuard, CsrfGuard)
  async streamChat(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Body(new ZodValidationPipe(aiChatRequestSchema)) body: AiChatRequest,
  ): Promise<void> {
    const abortController = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) {
        abortController.abort(new Error('client_disconnect'));
      }
    };
    response.once('close', onClose);

    let prepared;
    try {
      prepared = await this.orchestration.preparePersistentTurn(
        {
          userId: request.authenticatedSession.userId,
          sessionId: request.authenticatedSession.id,
        },
        body,
        abortController.signal,
      );
    } catch (error) {
      response.removeListener('close', onClose);
      throw error;
    }

    if (prepared.kind === 'existing') {
      response.removeListener('close', onClose);
      response.status(200).json({
        success: true,
        data: {
          turn: {
            id: prepared.turn.id,
            conversationId: prepared.turn.conversationId,
            status: prepared.turn.status,
            assistantMessageId: prepared.turn.assistantMessageId,
          },
        },
      });
      return;
    }

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    let eventSequence = 0;
    if (prepared.kind === 'trusted' || prepared.kind === 'unpersisted_trusted') {
      writeSse(
        response,
        {
          type: 'turn.started',
          data: { turnId: prepared.turn.id, conversationId: prepared.turn.conversationId },
        },
        ++eventSequence,
      );
      writeSse(
        response,
        {
          type: 'message.segment',
          data: { turnId: prepared.turn.id, sequence: 1, text: prepared.response.content },
        },
        ++eventSequence,
      );
      if (prepared.kind === 'trusted') {
        writeSse(
          response,
          {
            type: 'turn.completed',
            data: {
              turnId: prepared.turn.id,
              assistantMessageId: prepared.turn.assistantMessageId,
              finishReason: 'content_filter',
            },
          },
          eventSequence + 1,
        );
      } else {
        writeSse(
          response,
          failedEvent(
            prepared.turn.id,
            new AppError(ERROR_CODES.DATABASE_ERROR, 500, '安全响应未能保存'),
          ),
          eventSequence + 1,
        );
      }
      response.removeListener('close', onClose);
      if (!response.writableEnded && !response.destroyed) response.end();
      return;
    }

    try {
      for await (const event of this.orchestration.streamPreparedTurn(
        prepared,
        abortController.signal,
      )) {
        eventSequence += 1;
        writeSse(response, event, eventSequence);
      }
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        eventSequence += 1;
        writeSse(response, failedEvent(prepared.turn.id, error), eventSequence);
      }
    } finally {
      response.removeListener('close', onClose);
      if (!response.writableEnded && !response.destroyed) {
        response.end();
      }
    }
  }
}
