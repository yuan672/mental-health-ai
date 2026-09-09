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
    origin: env.WEB_ORIGINS,
    credentials: true,
  });
  app.enableShutdownHooks();

  await app.listen(env.APP_PORT, '0.0.0.0');
}

void bootstrap();
