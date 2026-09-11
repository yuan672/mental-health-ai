import { Body, Controller, Headers, Post, Req, Res, UseGuards } from '@nestjs/common';
import type {
  AiStreamEvent,
  AiStreamEventV2,
  IncognitoAiChatRequest,
  IncognitoAiStreamEvent,
  PersistentAiStreamEvent,
} from '@mental-health/types';
import type { Response } from 'express';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { CsrfGuard } from '../auth/csrf.guard';
import { AppError, ERROR_CODES } from '../common/errors';
import {
  applyKnowledgeReferenceResponseHeaders,
  parseKnowledgeReferenceCapability,
  type KnowledgeReferenceRepresentation,
} from '../common/http/knowledge-reference-capability';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { AiOrchestrationService } from './ai-orchestration.service';
import type { ConsentBoundExecution } from './runtime/active-ai-execution.registry';
import { ConsentExecutionCoordinator } from '../consents/runtime/consent-execution.coordinator';
import { aiChatRequestSchema, type AiChatRequest } from './ai.schemas';
import {
  parseAiStreamEventV2,
  toAiStreamEventV1,
  toImmediateAiStreamEventV2,
} from './ai-public.schemas';

export async function writeSse(
  response: Response,
  event: AiStreamEvent | AiStreamEventV2,
  sequence: number,
  signal: AbortSignal,
  representation: KnowledgeReferenceRepresentation = 'v1',
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('AI stream aborted');
  if (response.destroyed || response.writableEnded) throw new Error('AI stream is not writable');
  const wireEvent =
    representation === 'v2'
      ? 'deliveryMode' in event.data
        ? parseAiStreamEventV2(event)
        : toImmediateAiStreamEventV2(event as AiStreamEvent)
      : toAiStreamEventV1(event);
  const streamId =
    wireEvent.data.mode === 'persistent' ? wireEvent.data.turnId : wireEvent.data.generationId;
  const frame = `id: ${streamId}:${sequence}\nevent: ${wireEvent.type}\ndata: ${JSON.stringify(wireEvent.data)}\n\n`;
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
  constructor(
    private readonly orchestration: AiOrchestrationService,
    private readonly consentExecutions: ConsentExecutionCoordinator,
  ) {}

  @Post('chat/stream')
  @UseGuards(AuthenticatedSessionGuard, CsrfGuard)
  async streamChat(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Headers('x-mh-knowledge-references') knowledgeCapability: string | undefined,
    @Body(new ZodValidationPipe(aiChatRequestSchema)) body: AiChatRequest,
  ): Promise<void> {
    response.vary('X-MH-Knowledge-References');
    const representation = parseKnowledgeReferenceCapability(knowledgeCapability);
    const abortController = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) {
        abortController.abort(new Error('client_disconnect'));
      }
    };
    response.once('close', onClose);

    if (body.mode === 'incognito') {
      await this.streamIncognito(request, response, body, abortController, onClose, representation);
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
        new Date(),
        representation,
      );
    } catch (error) {
      response.removeListener('close', onClose);
      throw error;
    }

    if (prepared.kind === 'existing') {
      response.removeListener('close', onClose);
      if (response.destroyed || response.writableEnded) return;
      applyKnowledgeReferenceResponseHeaders(response, representation);
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

    this.orchestration.enforcePreparedExecutionDeadline(prepared);
    if (prepared.execution.signal.aborted || response.destroyed || response.writableEnded) {
      try {
        await this.orchestration.cancelPreparedPersistentTurnBeforeProvider(prepared);
      } finally {
        response.removeListener('close', onClose);
      }
      if (response.destroyed || response.writableEnded) return;
      if (prepared.execution.signal.aborted) {
        throw this.orchestration.preProviderTerminationError(prepared);
      }
      return;
    }

    response.status(200);
    applyKnowledgeReferenceResponseHeaders(response, representation);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    let eventSequence = 0;
    if (prepared.kind === 'trusted' || prepared.kind === 'unpersisted_trusted') {
      try {
        await this.writeBoundSse(
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
          prepared.execution,
          prepared.execution.signal,
        );
        await this.writeBoundSse(
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
          prepared.execution,
          prepared.execution.signal,
        );
        if (prepared.kind === 'trusted') {
          await this.writeBoundSse(
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
            prepared.execution,
            prepared.execution.signal,
          );
        } else {
          await this.writeBoundSse(
            response,
            failedEvent(
              prepared.turn.id,
              new AppError(ERROR_CODES.DATABASE_ERROR, 500, '安全响应未能保存'),
            ),
            eventSequence + 1,
            prepared.execution,
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
        await this.writeBoundSse(
          response,
          event,
          eventSequence,
          prepared.execution,
          prepared.execution.signal,
        );
      }
    } catch (error) {
      if (
        !prepared.deliveryState.groundedCommitSucceeded &&
        !response.destroyed &&
        !response.writableEnded
      ) {
        eventSequence += 1;
        try {
          await this.writeBoundSse(
            response,
            failedEvent(prepared.turn.id, error),
            eventSequence,
            prepared.execution,
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
    representation: KnowledgeReferenceRepresentation,
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
        new Date(),
        representation,
      );
    } catch (error) {
      response.removeListener('close', onClose);
      throw error;
    }

    this.orchestration.enforcePreparedExecutionDeadline(prepared);
    if (
      prepared.execution.signal.aborted ||
      prepared.generation.signal.aborted ||
      response.destroyed ||
      response.writableEnded
    ) {
      try {
        await this.orchestration.cancelPreparedIncognitoTurnBeforeProvider(prepared);
      } finally {
        response.removeListener('close', onClose);
      }
      if (response.destroyed || response.writableEnded) return;
      if (prepared.execution.signal.aborted || prepared.generation.signal.aborted) {
        throw this.orchestration.preProviderTerminationError(prepared);
      }
      return;
    }

    response.status(200);
    applyKnowledgeReferenceResponseHeaders(response, representation);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    let eventSequence = 0;
    if (prepared.kind === 'trusted') {
      try {
        await this.writeBoundSse(
          response,
          {
            type: 'turn.started',
            data: { mode: 'incognito', generationId: prepared.generation.id },
          },
          ++eventSequence,
          prepared.execution,
          prepared.generation.signal,
        );
        await this.writeBoundSse(
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
          prepared.execution,
          prepared.generation.signal,
        );
        await this.writeBoundSse(
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
          prepared.execution,
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

    let groundedCompletionWritten = false;
    try {
      for await (const event of this.orchestration.streamPreparedIncognitoTurn(
        prepared,
        abortController.signal,
      )) {
        eventSequence += 1;
        await this.writeBoundSse(
          response,
          event,
          eventSequence,
          prepared.execution,
          prepared.generation.signal,
        );
        if (
          event.type === 'turn.completed' &&
          'deliveryMode' in event.data &&
          event.data.deliveryMode === 'commit_with_references'
        ) {
          groundedCompletionWritten = true;
        }
      }
    } catch (error) {
      if (
        !prepared.deliveryState.groundedCommitSucceeded &&
        !prepared.generation.signal.aborted &&
        !response.destroyed &&
        !response.writableEnded
      ) {
        try {
          await this.writeBoundSse(
            response,
            incognitoFailedEvent(prepared.generation.id, error),
            ++eventSequence,
            prepared.execution,
            prepared.generation.signal,
          );
        } catch {
          // Do not write after context termination, cancellation, deadline, or socket closure.
        }
      }
    } finally {
      if (prepared.deliveryState.groundedCommitSucceeded && !groundedCompletionWritten) {
        this.orchestration.retireGroundedIncognitoDelivery(prepared);
      }
      response.removeListener('close', onClose);
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  }

  private async writeBoundSse(
    response: Response,
    event: AiStreamEvent | AiStreamEventV2,
    sequence: number,
    execution: ConsentBoundExecution,
    signal: AbortSignal,
  ): Promise<void> {
    await this.consentExecutions.assertStillUsable(execution);
    const representation = response.getHeader('X-MH-Knowledge-References') === '1' ? 'v2' : 'v1';
    await writeSse(response, event, sequence, signal, representation);
  }
}
