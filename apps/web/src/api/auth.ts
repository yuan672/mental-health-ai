import type {
  AuthSessionResponse,
  LoginResponse,
  LogoutResponse,
  RegistrationRequirementsResponse,
  RegistrationResponse,
} from '@mental-health/types';
import { apiRequest } from './client';
import {
  logoutResponseSchema,
  registrationRequirementsResponseSchema,
  registrationResponseSchema,
  sessionResponseSchema,
} from './schemas';

export function getSession(signal?: AbortSignal): Promise<AuthSessionResponse> {
  return apiRequest('/auth/session', sessionResponseSchema, {
    ...(signal ? { signal } : {}),
    notifyOnUnauthorized: false,
  });
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return apiRequest('/auth/login', sessionResponseSchema, {
    method: 'POST',
    body: { email, password },
    notifyOnUnauthorized: false,
  });
}

export function logout(): Promise<LogoutResponse> {
  return apiRequest('/auth/logout', logoutResponseSchema, {
    method: 'POST',
    csrf: true,
  });
}

export function getRegistrationRequirements(
  signal?: AbortSignal,
): Promise<RegistrationRequirementsResponse> {
  return apiRequest('/auth/registration-requirements', registrationRequirementsResponseSchema, {
    ...(signal ? { signal } : {}),
    notifyOnUnauthorized: false,
  });
}

export function register(input: {
  email: string;
  password: string;
  evidenceToken: string;
  consents: Array<{
    consentType: string;
    consentVersion: string;
    documentKey: string;
    documentRevision: string;
    accepted: true;
  }>;
}): Promise<RegistrationResponse> {
  return apiRequest('/auth/register', registrationResponseSchema, {
    method: 'POST',
    body: {
      email: input.email,
      password: input.password,
      ageVerification: { evidenceToken: input.evidenceToken },
      consents: input.consents,
    },
    notifyOnUnauthorized: false,
  });
}
