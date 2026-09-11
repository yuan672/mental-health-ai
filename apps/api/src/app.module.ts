import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { ConversationAccessModule } from './conversation-access/conversation-access.module';
import { ConversationModule } from './conversations/conversation.module';
import { DatabaseModule } from './database/database.module';
import { env } from './config/env';
import { HealthModule } from './health/health.module';
import { MessageModule } from './messages/message.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { MoodModule } from './mood/mood.module';
import { ProfileModule } from './profile/profile.module';
import { QuotaModule } from './quota/quota.module';
import { SecurityModule } from './security/security.module';
import { safeOperationalPath } from './common/http/safe-request-path';

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
  'req.url',
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
  'moodScore',
  '*.moodScore',
  'emotion',
  '*.emotion',
  'note',
  '*.note',
  'dailyTrend',
  '*.dailyTrend',
  'prompt',
  '*.prompt',
  'reasoning_content',
  '*.reasoning_content',
  'rawProviderRequest',
  '*.rawProviderRequest',
  'rawProviderResponse',
  '*.rawProviderResponse',
  'query',
  '*.query',
  'normalizedQuery',
  '*.normalizedQuery',
  'knowledgeBody',
  '*.knowledgeBody',
  'knowledgeSnippet',
  '*.knowledgeSnippet',
  'knowledgeReferences',
  '*.knowledgeReferences',
  'citationPayload',
  '*.citationPayload',
  'sourceUrl',
  '*.sourceUrl',
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
        customProps: (request) => ({
          logType: 'application',
          path: safeOperationalPath(request.url),
        }),
      },
    }),
    DatabaseModule,
    SecurityModule,
    HealthModule,
    AuthModule,
    CapabilitiesModule,
    AiModule,
    ConversationAccessModule,
    ConversationModule,
    MessageModule,
    KnowledgeModule,
    MoodModule,
    ProfileModule,
    QuotaModule,
  ],
})
export class AppModule {}
