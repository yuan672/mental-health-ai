import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { ConversationModule } from './conversations/conversation.module';
import { DatabaseModule } from './database/database.module';
import { env } from './config/env';
import { HealthModule } from './health/health.module';
import { MessageModule } from './messages/message.module';
import { QuotaModule } from './quota/quota.module';
import { SecurityModule } from './security/security.module';

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.proxy-authorization',
  'req.headers.cookie',
  'req.headers.referer',
  'req.headers.x-csrf-token',
  'req.headers["x-csrf-token"]',
  'req.headers.x-api-key',
  'req.headers["x-api-key"]',
  'req.body',
  'res.headers["set-cookie"]',
  'email',
  'password',
  'token',
  'rawToken',
  'csrfToken',
  'evidenceToken',
  'apiKey',
  'api_key',
  '*.email',
  '*.password',
  '*.token',
  '*.rawToken',
  '*.csrfToken',
  '*.evidenceToken',
  '*.apiKey',
  '*.api_key',
  'content',
  'message.content',
  '*.message.content',
  'messageContent',
  '*.messageContent',
  'conversationContent',
  '*.conversationContent',
  'prompt',
  '*.prompt',
] as const;

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        genReqId: (request, response) => {
          const incoming = request.headers['x-request-id'];
          const requestId =
            typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
          response.setHeader('x-request-id', requestId);
          return requestId;
        },
        redact: {
          paths: [...LOG_REDACT_PATHS],
          remove: true,
        },
        customProps: () => ({
          logType: 'application',
        }),
      },
    }),
    DatabaseModule,
    SecurityModule,
    HealthModule,
    AuthModule,
    ConversationModule,
    MessageModule,
    QuotaModule,
  ],
})
export class AppModule {}
