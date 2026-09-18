import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { AppModule } from './app.module';
import { createCorsOptions } from './common/http/cors-options';
import { env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new AppExceptionFilter());
  app.enableCors(createCorsOptions());
  app.enableShutdownHooks();

  await app.listen(env.APP_PORT, env.APP_HOST);
}

void bootstrap();
