import { SetMetadata } from '@nestjs/common';
import type { HttpRateLimitPolicy } from './http-abuse.types';

export const HTTP_INGRESS_METADATA = Symbol('HTTP_INGRESS_METADATA');
export const HTTP_PRINCIPAL_METADATA = Symbol('HTTP_PRINCIPAL_METADATA');

export type HttpIngressMetadata = Readonly<{
  lane: 'standard' | 'control' | 'mixed';
  additionalPolicies?: readonly HttpRateLimitPolicy[];
  skip?: boolean;
}>;

export type HttpPrincipalMetadata = Readonly<{
  policy: HttpRateLimitPolicy | 'manual';
  identityKind: 'user' | 'staff';
}>;

export const HttpIngress = (
  lane: HttpIngressMetadata['lane'],
  ...additionalPolicies: HttpRateLimitPolicy[]
) => SetMetadata(HTTP_INGRESS_METADATA, { lane, additionalPolicies } satisfies HttpIngressMetadata);

export const SkipHttpRateLimit = () =>
  SetMetadata(HTTP_INGRESS_METADATA, {
    lane: 'standard',
    skip: true,
  } satisfies HttpIngressMetadata);

export const HttpPrincipal = (
  policy: HttpPrincipalMetadata['policy'],
  identityKind: HttpPrincipalMetadata['identityKind'] = 'user',
) => SetMetadata(HTTP_PRINCIPAL_METADATA, { policy, identityKind } satisfies HttpPrincipalMetadata);
