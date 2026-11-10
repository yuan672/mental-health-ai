import { z } from 'zod';

export const riskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const harmSubjectSchema = z.enum(['SELF', 'OTHER', 'UNKNOWN']);
export type HarmSubject = z.infer<typeof harmSubjectSchema>;

export const riskCategorySchema = z.enum(['SELF_HARM', 'HARM_TO_OTHERS']);
export type RiskCategory = z.infer<typeof riskCategorySchema>;

export const riskReasonCodeSchema = z.enum([
  'SELF_HARM_IDEATION',
  'HARM_TO_OTHERS_IDEATION',
  'PASSIVE_DEATH_WISH',
  'CURRENT_FIRST_PERSON',
  'HISTORICAL_ONLY',
  'THIRD_PARTY_REPORT',
  'NEGATED_STATEMENT',
  'EXPLICIT_INTENT',
  'PLAN_PRESENT',
  'MEANS_AVAILABLE',
  'IMMEDIATE_TIMEFRAME',
  'ACT_IN_PROGRESS',
  'AMBIGUOUS_SAFETY_SIGNAL',
  'CLASSIFIER_HIGHER_THAN_RULES',
  'RULES_HIGHER_THAN_CLASSIFIER',
  'LOW_CLASSIFIER_CONFIDENCE',
]);
export type RiskReasonCode = z.infer<typeof riskReasonCodeSchema>;

export const inputPolicyFlagSchema = z.enum([
  'DIAGNOSIS_REQUEST',
  'MEDICATION_REQUEST',
  'DOSAGE_REQUEST',
  'STOP_MEDICATION_REQUEST',
  'SAFETY_BYPASS_ATTEMPT',
]);
export type InputPolicyFlag = z.infer<typeof inputPolicyFlagSchema>;

export const outputSafetyReasonCodeSchema = z.enum([
  'DIAGNOSIS_ASSERTION',
  'DISEASE_CONCLUSION',
  'MEDICATION_PRESCRIBING',
  'DOSAGE_INSTRUCTION',
  'STOP_MEDICATION_INSTRUCTION',
  'SELF_HARM_ENCOURAGEMENT',
  'ACTIONABLE_SELF_HARM_GUIDANCE',
  'HARM_TO_OTHERS_ENCOURAGEMENT',
  'DANGEROUS_BEHAVIOR_INSTRUCTION',
  'PROFESSIONAL_IMPERSONATION',
  'TREATMENT_GUARANTEE',
  'UNVERIFIED_CRISIS_RESOURCE',
  'INAPPROPRIATE_HIGH_RISK_RESPONSE',
]);
export type OutputSafetyReasonCode = z.infer<typeof outputSafetyReasonCodeSchema>;

export const safetyRouteSchema = z.enum([
  'ALLOW_NORMAL_GENERATION',
  'ALLOW_WITH_SAFETY_INSTRUCTION',
  'ALLOW_CONTROLLED_FULL_BUFFER',
  'CRISIS_RESPONSE',
  'SAFE_DEGRADED_RESPONSE',
]);
export type SafetyRoute = z.infer<typeof safetyRouteSchema>;

export const detectionSourceSchema = z.enum(['deterministic', 'classifier', 'hybrid']);
export type DetectionSource = z.infer<typeof detectionSourceSchema>;

export type AssessedRiskDecision = Readonly<{
  status: 'assessed';
  level: RiskLevel;
  harmSubject: HarmSubject;
  categories: readonly RiskCategory[];
  reasonCodes: readonly RiskReasonCode[];
  policyFlags: readonly InputPolicyFlag[];
  route: Exclude<SafetyRoute, 'SAFE_DEGRADED_RESPONSE'>;
  bufferingMode: 'semantic' | 'full' | 'none';
  detectionSource: DetectionSource;
  policyVersion: string;
  classifierKey: string | null;
  classifierVersion: string | null;
}>;

export type SafetyAssessmentUnavailable = Readonly<{
  status: 'unavailable';
  route: 'SAFE_DEGRADED_RESPONSE';
  bufferingMode: 'none';
  failureCategory: 'timeout' | 'provider' | 'malformed' | 'unsupported' | 'internal';
  policyVersion: string;
  policyFlags: readonly InputPolicyFlag[];
}>;

export type RiskDecision = AssessedRiskDecision | SafetyAssessmentUnavailable;

export type SafetyTarget =
  | Readonly<{ kind: 'conversation'; conversationId: string }>
  | Readonly<{ kind: 'incognito'; contextId: string; sessionId: string }>;

export type SafetyAssessmentContext = Readonly<{
  messages: readonly Readonly<{ role: 'user' | 'assistant'; content: string }>[];
  estimatedTokens: number;
  characterCount: number;
}>;

export function requiresRiskEvent(
  decision: RiskDecision,
): decision is AssessedRiskDecision & { level: 'MEDIUM' | 'HIGH' | 'CRITICAL' } {
  return decision.status === 'assessed' && decision.level !== 'LOW';
}

export function requiresHumanReview(
  decision: RiskDecision,
): decision is AssessedRiskDecision & { level: 'HIGH' | 'CRITICAL' } {
  return (
    decision.status === 'assessed' && (decision.level === 'HIGH' || decision.level === 'CRITICAL')
  );
}
