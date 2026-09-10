import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '../../common/errors';
import { env } from '../../config/env';
import { ConversationService } from '../../conversations/conversation.service';
import { MessageService } from '../../messages/message.service';
import {
  INCOGNITO_CONTEXT_STORE,
  type IncognitoContextStore,
} from '../../ai/incognito/incognito-context.store';
import { ConservativeTokenEstimator } from '../../ai/context/token-estimator';
import type { SafetyAssessmentContext, SafetyTarget } from '../safety.types';

@Injectable()
export class SafetyContextBuilder {
  constructor(
    private readonly conversations: ConversationService,
    @Inject(INCOGNITO_CONTEXT_STORE)
    private readonly incognitoContexts: IncognitoContextStore,
    private readonly messages: MessageService,
    private readonly tokenEstimator: ConservativeTokenEstimator,
  ) {}

  async build(
    userId: string,
    target: SafetyTarget,
    currentMessage: string,
    now = new Date(),
  ): Promise<SafetyAssessmentContext> {
    const history =
      target.kind === 'conversation'
        ? await this.persistentHistory(userId, target.conversationId, now)
        : this.incognitoHistory(userId, target.sessionId, target.contextId, now);
    const current = { role: 'user' as const, content: currentMessage };
    const currentCharacters = Array.from(currentMessage).length;
    const currentTokens = this.tokenEstimator.estimate(currentMessage);

    if (
      currentCharacters > env.SAFETY_CONTEXT_MAX_CHARACTERS ||
      currentTokens > env.SAFETY_CONTEXT_TOKEN_BUDGET
    ) {
      throw new ValidationError('消息超出当前安全评估上下文限制');
    }

    const selected: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let characterCount = currentCharacters;
    let estimatedTokens = currentTokens;
    for (const message of history.slice().reverse()) {
      if (selected.length >= env.SAFETY_CONTEXT_MAX_MESSAGES) {
        break;
      }
      const characters = Array.from(message.content).length;
      const tokens = this.tokenEstimator.estimate(message.content);
      if (
        characterCount + characters > env.SAFETY_CONTEXT_MAX_CHARACTERS ||
        estimatedTokens + tokens > env.SAFETY_CONTEXT_TOKEN_BUDGET
      ) {
        break;
      }
      selected.push({ role: message.role, content: message.content });
      characterCount += characters;
      estimatedTokens += tokens;
    }

    selected.reverse();
    return { messages: [...selected, current], estimatedTokens, characterCount };
  }

  private async persistentHistory(userId: string, conversationId: string, now: Date) {
    await this.conversations.get(userId, conversationId, now);
    return this.messages.readMessages(userId, conversationId, now);
  }

  private incognitoHistory(userId: string, sessionId: string, contextId: string, now: Date) {
    const context = this.incognitoContexts.get(userId, sessionId, contextId, now);
    if (!context) {
      throw new ValidationError('无痕对话上下文已失效');
    }
    return context.messages.filter(
      (message): message is { role: 'user' | 'assistant'; content: string } =>
        message.role === 'user' || message.role === 'assistant',
    );
  }
}
