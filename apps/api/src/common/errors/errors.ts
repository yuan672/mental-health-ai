import { AppError } from './app-error';
import { ERROR_CODES } from './error-code';

export class ValidationError extends AppError {
  constructor(message = '请求参数无效') {
    super(ERROR_CODES.VALIDATION_ERROR, 400, message);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = '请先登录') {
    super(ERROR_CODES.UNAUTHENTICATED, 401, message);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = '无权执行此操作') {
    super(ERROR_CODES.FORBIDDEN, 403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = '请求的资源不存在') {
    super(ERROR_CODES.NOT_FOUND, 404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = '当前状态存在冲突') {
    super(ERROR_CODES.CONFLICT, 409, message);
  }
}

export class RateLimitError extends AppError {
  constructor(message = '请求过于频繁，请稍后重试') {
    super(ERROR_CODES.RATE_LIMITED, 429, message);
  }
}

export class QuotaExceededError extends AppError {
  constructor(message = '今日 AI 使用额度已用完') {
    super(ERROR_CODES.QUOTA_EXCEEDED, 429, message);
  }
}

export class AIProviderError extends AppError {
  constructor(message = 'AI 服务暂时不可用') {
    super(ERROR_CODES.AI_PROVIDER_UNAVAILABLE, 503, message);
  }
}

export class DatabaseError extends AppError {
  constructor(message = '数据服务暂时不可用') {
    super(ERROR_CODES.DATABASE_ERROR, 500, message);
  }
}

export class InternalServerError extends AppError {
  constructor(message = '服务器内部错误') {
    super(ERROR_CODES.INTERNAL_ERROR, 500, message);
  }
}
