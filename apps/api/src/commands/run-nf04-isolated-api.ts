import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

export function assertNf04IsolatedApiEnvironment(environment: NodeJS.ProcessEnv): void {
  if (
    environment.APP_ENV !== 'test' ||
    environment.NF04_ISOLATED_API !== 'true' ||
    environment.ACCOUNT_DELETION_ENABLED !== 'true' ||
    environment.ADMIN_AUTH_ENABLED !== 'false' ||
    environment.AI_CHAT_ENABLED !== 'false' ||
    environment.AI_KNOWLEDGE_ENABLED !== 'false' ||
    environment.LLM_PROVIDER !== 'none' ||
    !/^http:\/\/127\.0\.0\.1:\d+$/u.test(environment.WEB_ORIGINS ?? '')
  ) {
    throw new Error('NF-04 isolated API environment is not authorized');
  }
}

async function bootstrap(): Promise<void> {
  assertNf04IsolatedApiEnvironment(process.env);
  const [{ AppModule }, { AppExceptionFilter }, { createCorsOptions }, { env }, { Logger }] =
    await Promise.all([
      import('../app.module.js'),
      import('../common/filters/app-exception.filter.js'),
      import('../common/http/cors-options.js'),
      import('../config/env.js'),
      import('nestjs-pino'),
    ]);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new AppExceptionFilter());
  app.enableCors(createCorsOptions());
  app.enableShutdownHooks();
  await app.listen(env.APP_PORT, '127.0.0.1');
}

if (require.main === module) {
  void bootstrap();
}
