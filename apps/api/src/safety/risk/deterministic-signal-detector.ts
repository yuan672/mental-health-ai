import { Injectable } from '@nestjs/common';
import type {
  HarmSubject,
  InputPolicyFlag,
  RiskCategory,
  RiskReasonCode,
  SafetyAssessmentContext,
} from '../safety.types';

export type DeterministicRiskSignals = Readonly<{
  subject: HarmSubject;
  categories: readonly RiskCategory[];
  reasonCodes: readonly RiskReasonCode[];
  policyFlags: readonly InputPolicyFlag[];
  explicitIntent: boolean;
  planPresent: boolean;
  meansAvailable: boolean;
  immediate: boolean;
  actInProgress: boolean;
  passiveWish: boolean;
  historicalOnly: boolean;
  negated: boolean;
  ambiguous: boolean;
}>;

const SELF_REFERENCE = /(?:我|自己|本人)/u;
const THIRD_PARTY_REFERENCE = /(?:朋友|同事|同学|家人|亲人|伴侣|他|她|他们|她们)/u;
const REPORTING_VERB = /(?:说|告诉|提到|表示|听说)/u;
const SELF_HARM_THEME = /(?:轻生|自杀|伤害自己|结束生命|不想活|想死|消失就好)/u;
const OTHER_HARM_THEME = /(?:伤害别人|伤害他人|杀了他|杀了她|杀人|报复并伤害)/u;
const NEGATED_RISK =
  /(?:不想死|不想自杀|不会自杀|没有轻生|(?:现在)?已经没有(?:了|.*(?:念头|想法))|不会伤害自己|不会伤害别人)/u;
const HISTORICAL = /(?:去年|以前|曾经|过去|那时候|之前有过)/u;
const CURRENT_MARKER = /(?:现在|此刻|目前|刚才|今天|今晚|马上|立刻|正在)/u;
const EXPLICIT_INTENT = /(?:真的不想活|想要自杀|要自杀|决定自杀|想伤害自己|想伤害别人|要伤害他人)/u;
const PLAN_MARKER = /(?:有.*计划|已经计划|准备这样做|打算这样做|想好了怎么做)/u;
const MEANS_MARKER = /(?:手边就有|已经拿到|工具就在旁边|已经准备好相关物品)/u;
const IN_PROGRESS = /(?:正在实施|已经开始实施|危险正在发生|已经做出伤害行为)/u;
const PASSIVE_WISH = /(?:消失就好了|消失就好|活着没意思|不如不存在)/u;
const AMBIGUOUS = /(?:撑不下去|受不了了|一切结束就好|不想面对明天)/u;

const DIAGNOSIS_REQUEST = /(?:诊断|是不是.*(?:抑郁症|焦虑症|双相)|我得了什么病)/u;
const MEDICATION_REQUEST = /(?:开什么药|吃什么药|推荐.*药|用什么药)/u;
const DOSAGE_REQUEST = /(?:剂量|吃多少|几片|多少毫克)/u;
const STOP_MEDICATION_REQUEST = /(?:停药|不吃药|停止服药|自行减药)/u;
const BYPASS_ATTEMPT = /(?:忽略.*安全|绕过.*限制|不要遵守.*规则|假装没有安全规则)/u;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

@Injectable()
export class DeterministicSignalDetector {
  detect(context: SafetyAssessmentContext): DeterministicRiskSignals {
    const current = context.messages.at(-1)?.content ?? '';
    const recent = context.messages.map((message) => message.content).join('\n');
    const selfHarm = SELF_HARM_THEME.test(recent);
    const harmToOthers = OTHER_HARM_THEME.test(recent);
    const thirdParty =
      (selfHarm || harmToOthers) &&
      THIRD_PARTY_REFERENCE.test(current) &&
      REPORTING_VERB.test(current);
    const selfReference = (selfHarm || harmToOthers) && SELF_REFERENCE.test(current);
    const negated = NEGATED_RISK.test(current);
    const historicalOnly = HISTORICAL.test(current) && (negated || !CURRENT_MARKER.test(current));
    const explicitIntent = EXPLICIT_INTENT.test(current) && !negated;
    const planPresent = PLAN_MARKER.test(current) && (selfHarm || harmToOthers);
    const meansAvailable = MEANS_MARKER.test(current) && (selfHarm || harmToOthers);
    const immediate =
      CURRENT_MARKER.test(current) && (explicitIntent || planPresent || meansAvailable);
    const actInProgress = IN_PROGRESS.test(current) && (selfHarm || harmToOthers);
    const passiveWish = PASSIVE_WISH.test(current) && !negated;
    const ambiguous = AMBIGUOUS.test(current) && !negated;

    const subject: HarmSubject = thirdParty ? 'OTHER' : selfReference ? 'SELF' : 'UNKNOWN';
    const categories: RiskCategory[] = [];
    if (selfHarm) categories.push('SELF_HARM');
    if (harmToOthers) categories.push('HARM_TO_OTHERS');

    const reasonCodes: RiskReasonCode[] = [];
    if (selfHarm) reasonCodes.push('SELF_HARM_IDEATION');
    if (harmToOthers) reasonCodes.push('HARM_TO_OTHERS_IDEATION');
    if (passiveWish) reasonCodes.push('PASSIVE_DEATH_WISH');
    if (subject === 'SELF') reasonCodes.push('CURRENT_FIRST_PERSON');
    if (historicalOnly) reasonCodes.push('HISTORICAL_ONLY');
    if (thirdParty) reasonCodes.push('THIRD_PARTY_REPORT');
    if (negated) reasonCodes.push('NEGATED_STATEMENT');
    if (explicitIntent) reasonCodes.push('EXPLICIT_INTENT');
    if (planPresent) reasonCodes.push('PLAN_PRESENT');
    if (meansAvailable) reasonCodes.push('MEANS_AVAILABLE');
    if (immediate) reasonCodes.push('IMMEDIATE_TIMEFRAME');
    if (actInProgress) reasonCodes.push('ACT_IN_PROGRESS');
    if (ambiguous) reasonCodes.push('AMBIGUOUS_SAFETY_SIGNAL');

    const policyFlags: InputPolicyFlag[] = [];
    if (DIAGNOSIS_REQUEST.test(current)) policyFlags.push('DIAGNOSIS_REQUEST');
    if (MEDICATION_REQUEST.test(current)) policyFlags.push('MEDICATION_REQUEST');
    if (DOSAGE_REQUEST.test(current)) policyFlags.push('DOSAGE_REQUEST');
    if (STOP_MEDICATION_REQUEST.test(current)) policyFlags.push('STOP_MEDICATION_REQUEST');
    if (BYPASS_ATTEMPT.test(current)) policyFlags.push('SAFETY_BYPASS_ATTEMPT');

    return {
      subject,
      categories: unique(categories),
      reasonCodes: unique(reasonCodes),
      policyFlags: unique(policyFlags),
      explicitIntent,
      planPresent,
      meansAvailable,
      immediate,
      actInProgress,
      passiveWish,
      historicalOnly,
      negated,
      ambiguous,
    };
  }
}
