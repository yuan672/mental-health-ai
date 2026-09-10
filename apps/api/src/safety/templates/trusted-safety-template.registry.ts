import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { HarmSubject } from '../safety.types';

export const trustedTemplateKeySchema = z.enum([
  'classifier-unavailable',
  'high-quota-fallback',
  'high-generation-fallback',
  'crisis-self',
  'crisis-third-party',
  'crisis-unknown',
  'output-blocked-replacement',
  'output-classifier-unavailable',
]);
export type TrustedTemplateKey = z.infer<typeof trustedTemplateKeySchema>;

export type TrustedSafetyTemplate = Readonly<{
  key: TrustedTemplateKey;
  version: string;
  content: string;
}>;

const VERSION = '2026-09-10';
const TEMPLATES: Record<TrustedTemplateKey, string> = {
  'classifier-unavailable':
    '抱歉，我现在无法可靠地完成安全评估，因此不会继续生成普通回复。如果你或他人正面临立即危险，请尽快联系身边可信任的人，并寻求当地紧急服务或线下医疗帮助。',
  'high-quota-fallback':
    '我很重视你描述的安全情况。即使普通对话额度已用完，也请优先联系一位现实中可信任的人，并在可能出现危险时尽快寻求当地紧急服务或线下医疗帮助。',
  'high-generation-fallback':
    '我现在无法安全地继续生成个性化回复。请先把现实中的安全放在首位，联系一位可信任的人；如果危险正在接近，请寻求当地紧急服务或线下医疗帮助。',
  'crisis-self':
    '你描述的情况可能涉及眼前的人身安全。请立即远离可能造成伤害的环境或物品，在安全可行时联系一位可信任的人陪伴你，并尽快寻求当地紧急服务或线下医疗帮助。',
  'crisis-third-party':
    '你描述的另一位当事人可能面临紧急危险。在不让自己陷入危险的前提下，请尽快联系现实中能够到场的可信任人员，并寻求当地紧急服务或线下医疗帮助；安全可行时不要让处于危险中的人独自一人。',
  'crisis-unknown':
    '你描述的情况可能涉及紧急人身安全。请优先联系现实中可信任且能够提供帮助的人，并尽快寻求当地紧急服务或线下医疗帮助。',
  'output-blocked-replacement':
    '抱歉，我不能继续刚才那种回答。我可以继续提供不涉及诊断、用药指令或危险操作的一般性支持；如果你或他人正处于危险中，请优先寻求现实世界的紧急帮助。',
  'output-classifier-unavailable':
    '抱歉，我现在无法确认后续内容是否安全，因此已停止生成。如果你或他人正面临危险，请优先联系可信任的人，并寻求当地紧急服务或线下医疗帮助。',
};

@Injectable()
export class TrustedSafetyTemplateRegistry {
  get(key: TrustedTemplateKey): TrustedSafetyTemplate {
    const parsedKey = trustedTemplateKeySchema.parse(key);
    return { key: parsedKey, version: VERSION, content: TEMPLATES[parsedKey] };
  }

  crisisForSubject(subject: HarmSubject): TrustedSafetyTemplate {
    return this.get(
      subject === 'SELF'
        ? 'crisis-self'
        : subject === 'OTHER'
          ? 'crisis-third-party'
          : 'crisis-unknown',
    );
  }
}
