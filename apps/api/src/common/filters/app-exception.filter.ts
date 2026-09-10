import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, ERROR_CODES, type ErrorCode } from '../errors';
import { safeOperationalPath } from '../http/safe-request-path';

type ErrorResponse = {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
  };
};

function codeForHttpStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ERROR_CODES.VALIDATION_ERROR;
    case HttpStatus.UNAUTHORIZED:
      return ERROR_CODES.UNAUTHENTICATED;
    case HttpStatus.FORBIDDEN:
      return ERROR_CODES.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ERROR_CODES.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ERROR_CODES.CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ERROR_CODES.RATE_LIMITED;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ERROR_CODES.AI_PROVIDER_UNAVAILABLE;
    default:
      return ERROR_CODES.INTERNAL_ERROR;
  }
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const appError =
      exception instanceof AppError
        ? exception
        : exception instanceof HttpException
          ? new AppError(
              codeForHttpStatus(exception.getStatus()),
              exception.getStatus(),
              exception.getStatus() >= 500 ? '服务器内部错误' : exception.message,
            )
          : new AppError(ERROR_CODES.INTERNAL_ERROR, 500, '服务器内部错误');

    const requestId = (request as Request & { id?: string }).id;

    this.logger.error({
      event: 'request_failed',
      requestId,
      method: request.method,
      path: safeOperationalPath(request.path),
      errorCode: appError.code,
      statusCode: appError.statusCode,
      errorName: exception instanceof Error ? exception.name : 'UnknownError',
    });

    const payload: ErrorResponse = {
      success: false,
      error: {
        code: appError.code,
        message: appError.message,
      },
    };

    if (!response.headersSent) {
      response.setHeader('Cache-Control', 'private, no-store');
    }
    response.status(appError.statusCode).json(payload);
  }
}
