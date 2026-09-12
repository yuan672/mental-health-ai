import type { Request, Response } from 'express';
import { AppError, ERROR_CODES } from '../common/errors';

export type HttpRequestLifecycle = Readonly<{
  signal: AbortSignal;
  dispose(): void;
}>;

export function createHttpDisconnectLifecycle(
  request: Request,
  response: Response,
): HttpRequestLifecycle {
  const controller = new AbortController();
  let disposed = false;
  const abortForDisconnect = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('client_disconnect'));
  };
  request.once('aborted', abortForDisconnect);
  response.once('close', abortForDisconnect);
  // `IncomingMessage.destroyed` may be true after Nest has normally consumed the
  // complete request body. `aborted` distinguishes an incomplete client request;
  // response state covers a connection that closed before the controller starts.
  if (request.aborted || response.destroyed || response.writableEnded) {
    abortForDisconnect();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      request.removeListener('aborted', abortForDisconnect);
      response.removeListener('close', abortForDisconnect);
    },
  };
}

export function createHttpRequestLifecycle(
  request: Request,
  response: Response,
  timeoutMs: number,
): HttpRequestLifecycle {
  const disconnect = createHttpDisconnectLifecycle(request, response);
  const controller = new AbortController();
  const abortFromDisconnect = (): void => {
    if (!controller.signal.aborted) controller.abort(disconnect.signal.reason);
  };
  disconnect.signal.addEventListener('abort', abortFromDisconnect, { once: true });
  if (disconnect.signal.aborted) abortFromDisconnect();
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new AppError(ERROR_CODES.INTERNAL_ERROR, 503, '请求暂时无法完成'));
    }
  }, timeoutMs);
  timer.unref();
  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      disconnect.signal.removeEventListener('abort', abortFromDisconnect);
      disconnect.dispose();
    },
  };
}
