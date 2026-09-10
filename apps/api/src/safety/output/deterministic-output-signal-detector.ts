import { Injectable } from '@nestjs/common';
import type { OutputSafetyReasonCode } from '../safety.types';

const RULES: ReadonlyArray<readonly [OutputSafetyReasonCode, RegExp]> = [
  ['DIAGNOSIS_ASSERTION', /(?:你患有|你就是得了|可以确诊|我诊断你)/u],
  ['DISEASE_CONCLUSION', /(?:肯定是|明确是).*(?:抑郁症|焦虑症|双相障碍)/u],
  ['MEDICATION_PRESCRIBING', /(?:我给你开|应该服用|建议你服用).*(?:药|片)/u],
  ['DOSAGE_INSTRUCTION', /(?:每天|每次).*(?:毫克|mg|片)/iu],
  ['STOP_MEDICATION_INSTRUCTION', /(?:立即|直接|自行).*(?:停药|停止服药)/u],
  ['SELF_HARM_ENCOURAGEMENT', /(?:你应该|不如|可以).*(?:自杀|伤害自己)/u],
  ['ACTIONABLE_SELF_HARM_GUIDANCE', /(?:自伤|自杀).*(?:步骤|教程|具体做法)/u],
  ['HARM_TO_OTHERS_ENCOURAGEMENT', /(?:你应该|可以).*(?:伤害他人|杀了他|杀了她)/u],
  ['DANGEROUS_BEHAVIOR_INSTRUCTION', /(?:危险行为).*(?:步骤|教程|具体做法)/u],
  ['PROFESSIONAL_IMPERSONATION', /(?:我是你的心理医生|作为你的精神科医生|我是你的真人咨询师)/u],
  ['TREATMENT_GUARANTEE', /(?:保证|一定).*(?:治好|康复|痊愈)/u],
];

@Injectable()
export class DeterministicOutputSignalDetector {
  detect(candidate: string, highRisk: boolean): OutputSafetyReasonCode[] {
    const codes = RULES.filter(([, pattern]) => pattern.test(candidate)).map(([code]) => code);
    if (highRisk && /(?:先别想这些|换个轻松话题|这没什么大不了|不要小题大做)/u.test(candidate)) {
      codes.push('INAPPROPRIATE_HIGH_RISK_RESPONSE');
    }
    return [...new Set(codes)];
  }
}
