import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { AppModule } from './app.module';
import { env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new AppExceptionFilter());
  app.enableCors({
    origin: [
      ...new Set([...env.WEB_ORIGINS, ...(env.ADMIN_AUTH_ENABLED ? env.ADMIN_WEB_ORIGINS : [])]),
    ],
    credentials: true,
    exposedHeaders: ['X-MH-Knowledge-References'],
  });
  app.enableShutdownHooks();

  await app.listen(env.APP_PORT, '0.0.0.0');
}

void bootstrap();
