import type {
  ConsentCurrentItem,
  ConsentHistoryResponse,
  ConsentMutationRequest,
  ConsentMutationResponse,
} from '@mental-health/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { PrivacyPage } from './privacy-page';

const mocks = vi.hoisted(() => ({
  getConsentHistory: vi.fn(),
  mutateConsent: vi.fn(),
  cancel: vi.fn(),
  active: false as boolean,
}));

vi.mock('../api/consents', () => ({
  getConsentHistory: mocks.getConsentHistory,
  mutateConsent: mocks.mutateConsent,
}));

vi.mock('../features/chat/chat-workspace', () => ({
  useChatWorkspace: () => ({ active: mocks.active, cancel: mocks.cancel }),
}));

const OCCURRED_AT = '2026-09-10T08:00:00.000Z';

function currentConsent(overrides: Partial<ConsentCurrentItem> = {}): ConsentCurrentItem {
  return {
    consentType: 'terms_of_service',
    consentVersion: 'terms-v1',
    isCurrentRequired: true,
    status: 'withdrawn',
    stateRevision: 2,
    effectiveAt: OCCURRED_AT,
    acceptedAt: OCCURRED_AT,
    withdrawnAt: OCCURRED_AT,
    documentKey: 'synthetic.terms-v1',
    documentRevision: 'test-revision-1',
    documentUrl: 'https://example.invalid/synthetic/terms/v1',
    displayKey: 'consent.termsOfService',
    documentEvidenceStatus: 'verified',
    acceptableDocument: {
      documentKey: 'synthetic.terms-v1',
      documentRevision: 'test-revision-1',
      documentUrl: 'https://example.invalid/synthetic/terms/v1',
      displayKey: 'consent.termsOfService',
    },
    authorizationStatus: 'inactive',
    acceptanceEnabled: true,
    withdrawalEnabled: false,
    ...overrides,
  };
}

function response(
  consentStates: ConsentCurrentItem[],
  options: { nextCursor?: string | null; current?: ConsentCurrentItem[] } = {},
): ConsentHistoryResponse {
  return {
    success: true,
    data: {
      currentRequiredConsents:
        options.current ?? consentStates.filter((consent) => consent.isCurrentRequired),
      consentStates,
      consents: [],
      nextCursor: options.nextCursor ?? null,
    },
  };
}

function mutationResponse(
  request: ConsentMutationRequest,
  current: ConsentCurrentItem,
): ConsentMutationResponse {
  const base = {
    operationId: request.operationId,
    outcome: 'applied' as const,
    consentType: request.consentType,
    consentVersion: request.consentVersion,
    priorRevision: request.expectedRevision,
    resultingRevision: current.stateRevision,
    occurredAt: OCCURRED_AT,
    decisionSource: 'privacy_ui' as const,
  };
  return {
    success: true,
    data: {
      current,
      receipt:
        request.action === 'accept'
          ? {
              ...base,
              action: 'accept',
              documentKey: request.documentKey,
              documentRevision: request.documentRevision,
              documentEvidenceStatus: 'verified',
            }
          : {
              ...base,
              action: 'withdraw',
              targetDocumentKey: current.documentKey,
              targetDocumentRevision: current.documentRevision,
              targetDocumentEvidenceStatus: current.documentEvidenceStatus,
            },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('Privacy Consent lifecycle UI', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.active = false;
    vi.restoreAllMocks();
  });

  it('re-accepts the same current version with server document identity and blocks double submit', async () => {
    const localStorageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const withdrawn = currentConsent();
    const accepted = currentConsent({
      status: 'accepted',
      stateRevision: 3,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    const pending = deferred<ConsentMutationResponse>();
    mocks.getConsentHistory
      .mockResolvedValueOnce(response([withdrawn]))
      .mockResolvedValue(response([accepted]));
    mocks.mutateConsent.mockReturnValue(pending.promise);

    render(<PrivacyPage />);
    await userEvent.click(
      await screen.findByRole('button', { name: '重新接受服务条款版本 terms-v1' }),
    );
    const confirm = screen.getByRole('button', { name: '确认接受' });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /我已查看以上文档/u }));
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(mocks.mutateConsent).toHaveBeenCalledTimes(1);
    const request = mocks.mutateConsent.mock.calls[0]?.[0] as ConsentMutationRequest;
    expect(request).toEqual({
      operationId: expect.any(String),
      action: 'accept',
      consentType: 'terms_of_service',
      consentVersion: 'terms-v1',
      documentKey: 'synthetic.terms-v1',
      documentRevision: 'test-revision-1',
      expectedRevision: 2,
    });
    pending.resolve(mutationResponse(request, accepted));
    expect(await screen.findByText(/接受服务条款版本 terms-v1已记录/u)).toBeInTheDocument();
    await waitFor(() => expect(mocks.getConsentHistory).toHaveBeenCalledTimes(2));
    expect(localStorageWrite).not.toHaveBeenCalled();
  });

  it('does not issue an unscoped client cancellation after a current withdrawal', async () => {
    const active = currentConsent({
      status: 'accepted',
      stateRevision: 1,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    const withdrawn = currentConsent({ stateRevision: 2 });
    mocks.active = true;
    mocks.getConsentHistory
      .mockResolvedValueOnce(response([active]))
      .mockResolvedValue(response([withdrawn]));
    mocks.mutateConsent.mockImplementation(async (request: ConsentMutationRequest) =>
      mutationResponse(request, withdrawn),
    );

    render(<PrivacyPage />);
    await userEvent.click(await screen.findByRole('button', { name: '撤回服务条款版本 terms-v1' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));

    expect(await screen.findByText(/撤回服务条款版本 terms-v1已记录/u)).toBeInTheDocument();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('withdraws an owned legacy historical state without requiring document evidence and paginates history', async () => {
    const active = currentConsent({
      status: 'accepted',
      stateRevision: 1,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    const legacy = currentConsent({
      consentType: 'privacy_policy',
      consentVersion: 'privacy-legacy',
      isCurrentRequired: false,
      status: 'accepted',
      stateRevision: 7,
      documentKey: null,
      documentRevision: null,
      documentUrl: null,
      displayKey: 'consent.privacyPolicy',
      documentEvidenceStatus: 'unmapped_legacy',
      acceptableDocument: null,
      authorizationStatus: 'inactive',
      acceptanceEnabled: false,
      withdrawalEnabled: true,
    });
    const firstPage = response([active, legacy], { nextCursor: 'cursor-2' });
    firstPage.data.consents.push({
      operationId: '51000000-0000-4000-8000-000000000041',
      action: 'accept',
      outcome: 'applied',
      consentType: 'privacy_policy',
      consentVersion: 'privacy-legacy',
      priorRevision: 0,
      resultingRevision: 1,
      occurredAt: OCCURRED_AT,
      decisionSource: 'legacy_backfill',
      documentKey: null,
      documentRevision: null,
      documentEvidenceStatus: 'unmapped_legacy',
    });
    const secondPage = response([active, legacy]);
    secondPage.data.consents.push({
      operationId: '51000000-0000-4000-8000-000000000042',
      action: 'withdraw',
      outcome: 'applied',
      consentType: 'privacy_policy',
      consentVersion: 'privacy-legacy',
      priorRevision: 1,
      resultingRevision: 2,
      occurredAt: '2026-09-10T09:00:00.000Z',
      decisionSource: 'privacy_ui',
      targetDocumentKey: null,
      targetDocumentRevision: null,
      targetDocumentEvidenceStatus: 'unmapped_legacy',
    });
    mocks.getConsentHistory
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValue(response([active, { ...legacy, status: 'withdrawn', stateRevision: 8 }]));
    mocks.mutateConsent.mockImplementation(async (request: ConsentMutationRequest) =>
      mutationResponse(request, { ...legacy, status: 'withdrawn', stateRevision: 8 }),
    );

    render(<PrivacyPage />);
    await userEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(mocks.getConsentHistory).toHaveBeenNthCalledWith(2, 'cursor-2', expect.any(AbortSignal));
    expect(await screen.findByText('撤回了未映射文档身份的历史接受记录')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '撤回隐私政策版本 privacy-legacy' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));
    await waitFor(() => expect(mocks.mutateConsent).toHaveBeenCalledTimes(1));
    const request = mocks.mutateConsent.mock.calls[0]?.[0] as ConsentMutationRequest;
    expect(request).toEqual({
      operationId: expect.any(String),
      action: 'withdraw',
      consentType: 'privacy_policy',
      consentVersion: 'privacy-legacy',
      expectedRevision: 7,
    });
    expect(request).not.toHaveProperty('documentKey');
    expect(request).not.toHaveProperty('documentRevision');
  });

  it('does not cancel current work for a historical withdrawal or a late withdrawal response', async () => {
    const currentRequired = currentConsent({
      status: 'accepted',
      stateRevision: 4,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    const historical = currentConsent({
      consentVersion: 'terms-v0',
      isCurrentRequired: false,
      status: 'accepted',
      stateRevision: 2,
      authorizationStatus: 'inactive',
      acceptableDocument: null,
      acceptanceEnabled: false,
      withdrawalEnabled: true,
    });
    const pending = deferred<ConsentMutationResponse>();
    mocks.getConsentHistory
      .mockResolvedValueOnce(response([currentRequired, historical]))
      .mockResolvedValue(
        response([currentRequired, { ...historical, status: 'withdrawn', stateRevision: 3 }]),
      );
    mocks.mutateConsent.mockReturnValue(pending.promise);

    render(<PrivacyPage />);
    await userEvent.click(await screen.findByRole('button', { name: '撤回服务条款版本 terms-v0' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));
    mocks.active = true;
    pending.resolve(
      mutationResponse(mocks.mutateConsent.mock.calls[0]?.[0] as ConsentMutationRequest, {
        ...historical,
        status: 'withdrawn',
        stateRevision: 3,
      }),
    );

    expect(await screen.findByText(/撤回服务条款版本 terms-v0已记录/u)).toBeInTheDocument();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('does not let an old withdrawal replay cancel work authorized by a later acceptance', async () => {
    const previouslyAccepted = currentConsent({
      status: 'accepted',
      stateRevision: 1,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    const laterAcceptance = currentConsent({
      status: 'accepted',
      stateRevision: 3,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    mocks.getConsentHistory
      .mockResolvedValueOnce(response([previouslyAccepted]))
      .mockResolvedValue(response([laterAcceptance]));
    mocks.mutateConsent
      .mockRejectedValueOnce(new TypeError('synthetic acknowledgement loss'))
      .mockImplementationOnce(async (request: ConsentMutationRequest) => ({
        success: true,
        data: {
          receipt: {
            ...mutationResponse(request, { ...previouslyAccepted, status: 'withdrawn' }).data
              .receipt,
            resultingRevision: 2,
          },
          current: laterAcceptance,
        },
      }));
    mocks.active = true;

    render(<PrivacyPage />);
    await userEvent.click(await screen.findByRole('button', { name: '撤回服务条款版本 terms-v1' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));
    await userEvent.click(await screen.findByRole('button', { name: '核对同一操作结果' }));

    expect(await screen.findByText(/撤回服务条款版本 terms-v1已记录/u)).toBeInTheDocument();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(await screen.findByText('状态修订')).toBeInTheDocument();
  });

  it('keeps an unknown request and blocks replacement operations until explicit abandon refreshes', async () => {
    const active = currentConsent({
      status: 'accepted',
      stateRevision: 1,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    mocks.getConsentHistory
      .mockResolvedValueOnce(response([active]))
      .mockRejectedValueOnce(new TypeError('synthetic refresh failure'));
    mocks.mutateConsent.mockRejectedValueOnce(new TypeError('synthetic acknowledgement loss'));

    render(<PrivacyPage />);
    await userEvent.click(await screen.findByRole('button', { name: '撤回服务条款版本 terms-v1' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));
    const ordinaryAction = await screen.findByRole('button', {
      name: '撤回服务条款版本 terms-v1',
    });
    expect(ordinaryAction).toBeDisabled();
    fireEvent.click(ordinaryAction);
    expect(mocks.mutateConsent).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: '放弃重试并刷新状态' }));
    expect(await screen.findByText(/已放弃核对原操作，但最新状态加载失败/u)).toBeInTheDocument();
    expect(screen.getByText(/当前显示的是上次已知状态/u)).toBeInTheDocument();
    expect(ordinaryAction).toBeDisabled();
    expect(screen.queryByRole('button', { name: '核对同一操作结果' })).not.toBeInTheDocument();
  });

  it('drops the in-memory unknown snapshot on page exit and reloads authoritative state on re-entry', async () => {
    const active = currentConsent({
      status: 'accepted',
      stateRevision: 1,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    const withdrawn = currentConsent({ stateRevision: 2 });
    mocks.getConsentHistory
      .mockResolvedValueOnce(response([active]))
      .mockResolvedValueOnce(response([withdrawn]));
    mocks.mutateConsent.mockRejectedValueOnce(new TypeError('synthetic acknowledgement loss'));

    const first = render(<PrivacyPage />);
    await userEvent.click(await screen.findByRole('button', { name: '撤回服务条款版本 terms-v1' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));
    expect(await screen.findByRole('button', { name: '核对同一操作结果' })).toBeInTheDocument();
    first.unmount();

    render(<PrivacyPage />);
    expect(
      await screen.findByRole('button', { name: '重新接受服务条款版本 terms-v1' }),
    ).toBeEnabled();
    expect(screen.queryByRole('button', { name: '核对同一操作结果' })).not.toBeInTheDocument();
    expect(mocks.mutateConsent).toHaveBeenCalledTimes(1);
  });

  it('does not claim a 409 refresh succeeded when authoritative reload fails', async () => {
    const active = currentConsent({
      status: 'accepted',
      stateRevision: 1,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    mocks.getConsentHistory
      .mockResolvedValueOnce(response([active]))
      .mockRejectedValueOnce(new TypeError('synthetic refresh failure'));
    mocks.mutateConsent.mockRejectedValueOnce(
      new ApiClientError('CONSENT_STATE_CHANGED', '同意状态已经变化', 409),
    );

    render(<PrivacyPage />);
    await userEvent.click(await screen.findByRole('button', { name: '撤回服务条款版本 terms-v1' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));

    expect(
      await screen.findByText(/同意状态或政策文档已变化，但最新状态加载失败/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/已刷新最新状态/u)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤回服务条款版本 terms-v1' })).toBeDisabled();
  });

  it('treats CONSENT_UNAVAILABLE as a definite pre-coordination failure', async () => {
    const active = currentConsent({
      status: 'accepted',
      stateRevision: 1,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    mocks.getConsentHistory.mockResolvedValue(response([active]));
    mocks.mutateConsent.mockRejectedValueOnce(
      new ApiClientError('CONSENT_UNAVAILABLE', '同意服务暂时不可用', 503),
    );

    render(<PrivacyPage />);
    await userEvent.click(await screen.findByRole('button', { name: '撤回服务条款版本 terms-v1' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));

    expect(await screen.findByText('同意服务暂时不可用')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '核对同一操作结果' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤回服务条款版本 terms-v1' })).toBeEnabled();
  });

  it('ignores an old load after leaving and restores authoritative state on re-entry', async () => {
    const oldLoad = deferred<ConsentHistoryResponse>();
    const oldState = currentConsent({ consentVersion: 'old-version' });
    const currentState = currentConsent({ consentVersion: 'current-version' });
    mocks.getConsentHistory
      .mockReturnValueOnce(oldLoad.promise)
      .mockResolvedValueOnce(response([currentState]));

    const first = render(<PrivacyPage />);
    first.unmount();
    render(<PrivacyPage />);
    expect(
      await screen.findByRole('button', { name: '重新接受服务条款版本 current-version' }),
    ).toBeEnabled();
    oldLoad.resolve(response([oldState]));

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: '重新接受服务条款版本 old-version' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('retries an unknown result with the exact request and reloads a 409 before requiring a new action', async () => {
    const active = currentConsent({
      status: 'accepted',
      stateRevision: 1,
      withdrawnAt: null,
      authorizationStatus: 'active',
      withdrawalEnabled: true,
    });
    const refreshed = { ...active, stateRevision: 2 };
    mocks.getConsentHistory
      .mockResolvedValueOnce(response([active]))
      .mockResolvedValue(response([refreshed]));
    mocks.mutateConsent
      .mockRejectedValueOnce(new TypeError('synthetic network loss'))
      .mockRejectedValueOnce(new ApiClientError('CONSENT_STATE_CHANGED', '同意状态已经变化', 409))
      .mockImplementationOnce(async (request: ConsentMutationRequest) =>
        mutationResponse(request, {
          ...refreshed,
          status: 'withdrawn',
          stateRevision: 3,
          authorizationStatus: 'inactive',
          withdrawalEnabled: false,
        }),
      );

    render(<PrivacyPage />);
    await userEvent.click(await screen.findByRole('button', { name: '撤回服务条款版本 terms-v1' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));
    expect(await screen.findByRole('button', { name: '核对同一操作结果' })).toBeInTheDocument();
    const originalRequest = mocks.mutateConsent.mock.calls[0]?.[0];

    await userEvent.click(screen.getByRole('button', { name: '核对同一操作结果' }));
    await waitFor(() => expect(mocks.mutateConsent).toHaveBeenCalledTimes(2));
    expect(mocks.mutateConsent.mock.calls[1]?.[0]).toEqual(originalRequest);
    expect(await screen.findByText(/已刷新最新状态，请重新作出明确选择/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '核对同一操作结果' })).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.getConsentHistory).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('button', { name: '撤回服务条款版本 terms-v1' }));
    expect(screen.getByRole('dialog', { name: '撤回服务条款？' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '确认撤回' }));
    await waitFor(() => expect(mocks.mutateConsent).toHaveBeenCalledTimes(3));
    const freshRequest = mocks.mutateConsent.mock.calls[2]?.[0] as ConsentMutationRequest;
    expect(freshRequest.operationId).not.toBe(
      (originalRequest as ConsentMutationRequest).operationId,
    );
    expect(freshRequest.expectedRevision).toBe(2);
  });
});
