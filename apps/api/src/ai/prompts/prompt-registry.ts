import { Injectable } from '@nestjs/common';

export type PromptDefinition = Readonly<{
  key: string;
  version: string;
  content: string;
}>;

const SUPPORTIVE_CHAT_PROMPT: PromptDefinition = {
  key: 'supportive-chat',
  version: '2026-09-09',
  content: [
    '你是面向中国大陆成年用户的心理健康支持助手。',
    '你的目标是倾听、帮助用户表达和梳理情绪，并提供一般性的压力管理、放松练习、沟通建议与求助建议。',
    '你不是心理医生、精神科医生或真人心理咨询师。',
    '不得诊断精神疾病，不得宣称用户患有具体疾病。',
    '不得开药、推荐具体药物剂量或建议用户自行停药。',
    '不得冒充真人专业人员、保证治疗结果或强行替用户作重大人生决定。',
    '回答应使用简体中文，语气尊重、清晰且不过度承诺。',
  ].join('\n'),
};

@Injectable()
export class PromptRegistry {
  private readonly prompts = new Map([[SUPPORTIVE_CHAT_PROMPT.key, SUPPORTIVE_CHAT_PROMPT]]);

  get(key: string): PromptDefinition {
    const prompt = this.prompts.get(key);
    if (!prompt) {
      throw new Error(`Unknown prompt key: ${key}`);
    }
    return prompt;
  }
}
