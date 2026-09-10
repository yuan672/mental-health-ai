import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type {
  AiStreamEvent,
  IncognitoAiChatRequest,
  IncognitoAiStreamEvent,
  PersistentAiStreamEvent,
} from '@mental-health/types';
import type { Response } from 'express';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { CsrfGuard } from '../auth/csrf.guard';
import { AppError, ERROR_CODES } from '../common/errors';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { AiOrchestrationService } from './ai-orchestration.service';
import { aiChatRequestSchema, type AiChatRequest } from './ai.schemas';

export async function writeSse(
  response: Response,
  event: AiStreamEvent,
  sequence: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('AI stream aborted');
  if (response.destroyed || response.writableEnded) throw new Error('AI stream is not writable');
  const streamId = event.data.mode === 'persistent' ? event.data.turnId : event.data.generationId;
  const frame = `id: ${streamId}:${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  if (response.write(frame)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.removeListener('drain', onDrain);
      response.removeListener('close', onClose);
      response.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void): void => {
      cleanup();
      callback();
    };
    const onDrain = (): void => finish(resolve);
    const onClose = (): void => finish(() => reject(new Error('AI stream closed')));
    const onError = (error: Error): void => finish(() => reject(error));
    const onAbort = (): void =>
      finish(() => reject(signal.reason ?? new Error('AI stream aborted')));
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toAppError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError(ERROR_CODES.INTERNAL_ERROR, 500, '服务器内部错误');
}

function failedEvent(turnId: string, error: unknown): PersistentAiStreamEvent {
  const appError = toAppError(error);
  return {
    type: 'turn.failed',
    data: { mode: 'persistent', turnId, code: appError.code, message: appError.message },
  };
}

function incognitoFailedEvent(generationId: string, error: unknown): IncognitoAiStreamEvent {
  const appError = toAppError(error);
  return {
    type: 'turn.failed',
    data: {
      mode: 'incognito',
      generationId,
      code: appError.code,
      message: appError.message,
    },
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

    if (body.mode === 'incognito') {
      await this.streamIncognito(request, response, body, abortController, onClose);
      return;
    }

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

    if (prepared.execution.signal.aborted || response.destroyed || response.writableEnded) {
      prepared.execution.dispose();
      response.removeListener('close', onClose);
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
      try {
        await writeSse(
          response,
          {
            type: 'turn.started',
            data: {
              mode: 'persistent',
              turnId: prepared.turn.id,
              conversationId: prepared.turn.conversationId,
            },
          },
          ++eventSequence,
          prepared.execution.signal,
        );
        await writeSse(
          response,
          {
            type: 'message.segment',
            data: {
              mode: 'persistent',
              turnId: prepared.turn.id,
              sequence: 1,
              text: prepared.response.content,
            },
          },
          ++eventSequence,
          prepared.execution.signal,
        );
        if (prepared.kind === 'trusted') {
          await writeSse(
            response,
            {
              type: 'turn.completed',
              data: {
                mode: 'persistent',
                turnId: prepared.turn.id,
                assistantMessageId: prepared.turn.assistantMessageId,
                finishReason: 'content_filter',
              },
            },
            eventSequence + 1,
            prepared.execution.signal,
          );
        } else {
          await writeSse(
            response,
            failedEvent(
              prepared.turn.id,
              new AppError(ERROR_CODES.DATABASE_ERROR, 500, '安全响应未能保存'),
            ),
            eventSequence + 1,
            prepared.execution.signal,
          );
        }
      } catch {
        // A disconnected, cancelled, or expired request must not receive late safety events.
      } finally {
        prepared.execution.dispose();
        response.removeListener('close', onClose);
        if (!response.writableEnded && !response.destroyed) response.end();
      }
      return;
    }

    try {
      for await (const event of this.orchestration.streamPreparedTurn(
        prepared,
        abortController.signal,
      )) {
        eventSequence += 1;
        await writeSse(response, event, eventSequence, prepared.execution.signal);
      }
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        eventSequence += 1;
        try {
          await writeSse(
            response,
            failedEvent(prepared.turn.id, error),
            eventSequence,
            prepared.execution.signal,
          );
        } catch {
          // Do not write after cancellation, deadline expiry, or socket closure.
        }
      }
    } finally {
      response.removeListener('close', onClose);
      if (!response.writableEnded && !response.destroyed) {
        response.end();
      }
    }
  }

  private async streamIncognito(
    request: AuthenticatedRequest,
    response: Response,
    body: IncognitoAiChatRequest,
    abortController: AbortController,
    onClose: () => void,
  ): Promise<void> {
    let prepared;
    try {
      prepared = await this.orchestration.prepareIncognitoTurn(
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

    if (prepared.generation.signal.aborted || response.destroyed || response.writableEnded) {
      this.orchestration.releasePreparedIncognitoTurn(prepared);
      response.removeListener('close', onClose);
      return;
    }

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    let eventSequence = 0;
    if (prepared.kind === 'trusted') {
      try {
        await writeSse(
          response,
          {
            type: 'turn.started',
            data: { mode: 'incognito', generationId: prepared.generation.id },
          },
          ++eventSequence,
          prepared.generation.signal,
        );
        await writeSse(
          response,
          {
            type: 'message.segment',
            data: {
              mode: 'incognito',
              generationId: prepared.generation.id,
              sequence: 1,
              text: prepared.response.content,
            },
          },
          ++eventSequence,
          prepared.generation.signal,
        );
        await writeSse(
          response,
          {
            type: 'turn.completed',
            data: {
              mode: 'incognito',
              generationId: prepared.generation.id,
              finishReason: 'content_filter',
            },
          },
          ++eventSequence,
          prepared.generation.signal,
        );
      } catch {
        // Context termination, logout, withdrawal, timeout, or disconnect rejects late events.
      } finally {
        this.orchestration.releasePreparedIncognitoTurn(prepared);
        response.removeListener('close', onClose);
        if (!response.writableEnded && !response.destroyed) response.end();
      }
      return;
    }

    try {
      for await (const event of this.orchestration.streamPreparedIncognitoTurn(
        prepared,
        abortController.signal,
      )) {
        eventSequence += 1;
        await writeSse(response, event, eventSequence, prepared.generation.signal);
      }
    } catch (error) {
      if (!prepared.generation.signal.aborted && !response.destroyed && !response.writableEnded) {
        try {
          await writeSse(
            response,
            incognitoFailedEvent(prepared.generation.id, error),
            ++eventSequence,
            prepared.generation.signal,
          );
        } catch {
          // Do not write after context termination, cancellation, deadline, or socket closure.
        }
      }
    } finally {
      response.removeListener('close', onClose);
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  }
}
