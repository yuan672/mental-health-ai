import type { ConsentType } from '@mental-health/types';

export type ConsentPolicyKey = Readonly<{
  consentType: ConsentType;
  consentVersion: string;
}>;

export type ConsentDependency = Readonly<{
  consentId: string;
  acceptanceDecisionId: string;
  stateRevision: number;
  consentType: ConsentType;
  consentVersion: string;
}>;

export type ThirdPartyDispatchKind = 'risk_classification' | 'generation' | 'output_classification';

export function consentPolicyKey(value: ConsentPolicyKey): string {
  return `${value.consentType}:${value.consentVersion}`;
}

export function sameConsentDependencies(
  left: readonly ConsentDependency[],
  right: readonly ConsentDependency[],
): boolean {
  if (left.length !== right.length) return false;
  const normalized = (dependencies: readonly ConsentDependency[]) =>
    dependencies
      .map(
        (dependency) =>
          `${dependency.consentType}:${dependency.consentVersion}:${dependency.consentId}:${dependency.acceptanceDecisionId}:${dependency.stateRevision}`,
      )
      .sort();
  return normalized(left).every((value, index) => value === normalized(right)[index]);
}
