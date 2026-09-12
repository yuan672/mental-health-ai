import type { Request, Response } from 'express';
import { AppError, ERROR_CODES } from '../common/errors';

export type HttpRequestLifecycle = Readonly<{
  signal: AbortSignal;
  dispose(): void;
}>;

export function createHttpRequestLifecycle(
  request: Request,
  response: Response,
  timeoutMs: number,
): HttpRequestLifecycle {
  const controller = new AbortController();
  const abortForDisconnect = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('client_disconnect'));
  };
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new AppError(ERROR_CODES.INTERNAL_ERROR, 503, '请求暂时无法完成'));
    }
  }, timeoutMs);
  timer.unref();
  request.once('aborted', abortForDisconnect);
  response.once('close', abortForDisconnect);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      request.removeListener('aborted', abortForDisconnect);
      response.removeListener('close', abortForDisconnect);
    },
  };
}
