import type {
  ConsentCurrentItem,
  ConsentHistoryItem,
  ConsentMutationAction,
  ConsentMutationRequest,
  ConsentType,
} from '@mental-health/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../api/client';
import { getConsentHistory, mutateConsent } from '../api/consents';
import { useChatWorkspace } from '../features/chat/chat-workspace';
import { ConfirmDialog } from '../shared/confirm-dialog';

const consentNames: Record<ConsentType, string> = {
  terms_of_service: '服务条款',
  privacy_policy: '隐私政策',
};

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

type ConsentActionDialog = Readonly<{
  action: ConsentMutationAction;
  consent: ConsentCurrentItem;
}>;

type PendingUnknownMutation = Readonly<{
  request: ConsentMutationRequest;
  label: string;
}>;

function consentKey(consent: Pick<ConsentCurrentItem, 'consentType' | 'consentVersion'>) {
  return `${consent.consentType}:${consent.consentVersion}`;
}

function statusLabel(consent: ConsentCurrentItem) {
  if (consent.authorizationStatus === 'confirmation_required') return '需要重新确认当前文档';
  if (consent.status === 'accepted') return '已接受';
  if (consent.status === 'withdrawn') return '已撤回';
  return '尚未接受';
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function replaceConsent(
  consents: ConsentCurrentItem[],
  replacement: ConsentCurrentItem,
): ConsentCurrentItem[] {
  const key = consentKey(replacement);
  return consents.some((consent) => consentKey(consent) === key)
    ? consents.map((consent) => (consentKey(consent) === key ? replacement : consent))
    : [...consents, replacement];
}

function documentEvidenceText(consent: ConsentCurrentItem) {
  if (consent.documentEvidenceStatus === 'unmapped_legacy') {
    return '这是迁移的历史接受记录，无法映射到可核验的具体文档。';
  }
  if (consent.documentEvidenceStatus === 'unavailable') {
    return '这条状态没有可展示的历史文档证据。';
  }
  return consent.documentRevision
    ? `已接受文档修订 ${consent.documentRevision}`
    : '已记录可核验的文档证据。';
}

export function PrivacyPage() {
  const workspace = useChatWorkspace();
  const [current, setCurrent] = useState<ConsentCurrentItem[]>([]);
  const [consentStates, setConsentStates] = useState<ConsentCurrentItem[]>([]);
  const [history, setHistory] = useState<ConsentHistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ConsentActionDialog | null>(null);
  const [documentAcknowledged, setDocumentAcknowledged] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [unknownMutation, setUnknownMutation] = useState<PendingUnknownMutation | null>(null);
  const mountedRef = useRef(false);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const mutationGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);

  const loadPage = useCallback(
    async (cursor: string | null, mode: 'initial' | 'refresh' | 'more') => {
      const controller = new AbortController();
      const generation = ++loadGenerationRef.current;
      loadControllerRef.current?.abort();
      loadControllerRef.current = controller;
      if (mode === 'more') setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const response = await getConsentHistory(cursor, controller.signal);
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          generation !== loadGenerationRef.current
        )
          return;
        setCurrent(response.data.currentRequiredConsents);
        setConsentStates(response.data.consentStates);
        setHistory((items) =>
          mode === 'more' ? [...items, ...response.data.consents] : response.data.consents,
        );
        setNextCursor(response.data.nextCursor);
      } catch (reason) {
        if (
          !isAbortError(reason) &&
          mountedRef.current &&
          generation === loadGenerationRef.current
        ) {
          setError(reason instanceof Error ? reason.message : '无法加载隐私设置');
        }
      } finally {
        if (mountedRef.current && generation === loadGenerationRef.current) {
          if (mode === 'more') setLoadingMore(false);
          else setLoading(false);
        }
        if (loadControllerRef.current === controller) loadControllerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void Promise.resolve().then(() => loadPage(null, 'initial'));
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      loadControllerRef.current?.abort();
      mutationControllerRef.current?.abort();
      mutationInFlightRef.current = false;
    };
  }, [loadPage]);

  const openDialog = (action: ConsentMutationAction, consent: ConsentCurrentItem) => {
    if (mutationInFlightRef.current) return;
    setDialog({ action, consent });
    setDocumentAcknowledged(false);
    setMutationError(null);
    setNotice(null);
    setUnknownMutation(null);
  };

  const performMutation = useCallback(
    async (request: ConsentMutationRequest, label: string) => {
      if (mutationInFlightRef.current) return;
      mutationInFlightRef.current = true;
      const controller = new AbortController();
      const generation = ++mutationGenerationRef.current;
      mutationControllerRef.current?.abort();
      mutationControllerRef.current = controller;
      setMutationBusy(true);
      setMutationError(null);
      setNotice(null);
      try {
        const response = await mutateConsent(request, controller.signal);
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          generation !== mutationGenerationRef.current
        )
          return;
        if (request.action === 'withdraw' && workspace.active) await workspace.cancel();
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          generation !== mutationGenerationRef.current
        )
          return;
        setConsentStates((items) => replaceConsent(items, response.data.current));
        if (response.data.current.isCurrentRequired) {
          setCurrent((items) => replaceConsent(items, response.data.current));
        }
        setDialog(null);
        setDocumentAcknowledged(false);
        setUnknownMutation(null);
        setNotice(
          response.data.receipt.outcome === 'applied'
            ? `${label}已记录。`
            : `${label}已核对，当前状态无需改变。`,
        );
        await loadPage(null, 'refresh');
      } catch (reason) {
        if (
          isAbortError(reason) ||
          !mountedRef.current ||
          generation !== mutationGenerationRef.current
        )
          return;
        if (
          reason instanceof ApiClientError &&
          (reason.code === 'CONSENT_STATE_CHANGED' ||
            reason.code === 'CONSENT_POLICY_CHANGED' ||
            reason.code === 'CONSENT_OPERATION_CONFLICT')
        ) {
          setDialog(null);
          setDocumentAcknowledged(false);
          setUnknownMutation(null);
          setNotice('同意状态或政策文档已变化。已刷新最新状态，请重新作出明确选择。');
          await loadPage(null, 'refresh');
          return;
        }
        const resultUnknown =
          !(reason instanceof ApiClientError) ||
          reason.code === 'CONSENT_RESULT_UNKNOWN' ||
          reason.code === 'INVALID_API_RESPONSE' ||
          reason.status >= 500;
        if (resultUnknown) {
          if (request.action === 'withdraw' && workspace.active) await workspace.cancel();
          if (!mountedRef.current || generation !== mutationGenerationRef.current) return;
          setDialog(null);
          setDocumentAcknowledged(false);
          setUnknownMutation({ request, label });
          setMutationError(
            '服务器是否已记录本次操作暂时无法确认。你可以使用同一操作重新核对，或放弃重试并刷新当前状态。',
          );
          return;
        }
        setDialog(null);
        setDocumentAcknowledged(false);
        setUnknownMutation(null);
        setMutationError(reason instanceof Error ? reason.message : '无法更新同意状态');
      } finally {
        if (generation === mutationGenerationRef.current) {
          mutationInFlightRef.current = false;
          if (mountedRef.current) setMutationBusy(false);
        }
        if (mutationControllerRef.current === controller) mutationControllerRef.current = null;
      }
    },
    [loadPage, workspace],
  );

  const confirmAction = () => {
    if (!dialog || mutationInFlightRef.current) return;
    const { action, consent } = dialog;
    const label = `${action === 'accept' ? '接受' : '撤回'}${consentNames[consent.consentType]}版本 ${consent.consentVersion}`;
    if (action === 'accept') {
      const document = consent.acceptableDocument;
      if (!document || !consent.acceptanceEnabled || !documentAcknowledged) {
        setMutationError('当前没有可核验的文档，无法接受。');
        return;
      }
      void performMutation(
        {
          operationId: globalThis.crypto.randomUUID(),
          action: 'accept',
          consentType: consent.consentType,
          consentVersion: consent.consentVersion,
          documentKey: document.documentKey,
          documentRevision: document.documentRevision,
          expectedRevision: consent.stateRevision,
        },
        label,
      );
      return;
    }
    if (!consent.withdrawalEnabled) {
      setMutationError('该同意状态当前不可撤回，请刷新后重试。');
      return;
    }
    void performMutation(
      {
        operationId: globalThis.crypto.randomUUID(),
        action: 'withdraw',
        consentType: consent.consentType,
        consentVersion: consent.consentVersion,
        expectedRevision: consent.stateRevision,
      },
      label,
    );
  };

  const abandonUnknownAndRefresh = () => {
    if (mutationInFlightRef.current) return;
    setUnknownMutation(null);
    setMutationError(null);
    setNotice('已放弃核对原操作。正在读取服务器当前状态。');
    void loadPage(null, 'refresh');
  };

  return (
    <main className="privacy-page" aria-labelledby="privacy-title">
      <header className="privacy-header">
        <p className="eyebrow">隐私与数据</p>
        <h1 id="privacy-title">管理同意与了解数据边界</h1>
        <p>你可以查看当前必要文档和历史决定，并对服务器明确允许的版本作出接受或撤回选择。</p>
      </header>

      {error ? (
        <div className="privacy-feedback" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void loadPage(null, 'refresh')}
          >
            重新加载
          </button>
        </div>
      ) : null}
      {notice ? (
        <p className="inline-success" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
      {mutationError ? (
        <div className="privacy-feedback" role="alert">
          <p>{mutationError}</p>
          {unknownMutation ? (
            <div className="privacy-actions">
              <button
                type="button"
                className="button"
                disabled={mutationBusy}
                onClick={() => void performMutation(unknownMutation.request, unknownMutation.label)}
              >
                核对同一操作结果
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={mutationBusy}
                onClick={abandonUnknownAndRefresh}
              >
                放弃重试并刷新状态
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {loading ? <p aria-busy="true">正在加载同意状态…</p> : null}

      {!loading ? (
        <>
          <section className="privacy-card" aria-labelledby="current-consents-title">
            <h2 id="current-consents-title">当前必要同意</h2>
            <ul className="privacy-list privacy-current-list">
              {current.map((consent) => (
                <li key={consentKey(consent)}>
                  <div>
                    <strong>{consentNames[consent.consentType]}</strong>
                    <span>版本 {consent.consentVersion}</span>
                  </div>
                  <strong>{statusLabel(consent)}</strong>
                </li>
              ))}
            </ul>
          </section>

          <section className="privacy-card" aria-labelledby="consent-management-title">
            <h2 id="consent-management-title">管理同意</h2>
            <p className="muted">
              操作以服务器返回的文档身份和状态修订为准。页面不会替你自动接受新版本。
            </p>
            {consentStates.length === 0 ? <p className="muted">暂无可管理的同意状态。</p> : null}
            <ul className="consent-state-list">
              {consentStates.map((consent) => {
                const canAccept =
                  consent.isCurrentRequired &&
                  consent.acceptanceEnabled &&
                  consent.acceptableDocument !== null &&
                  consent.authorizationStatus !== 'active';
                return (
                  <li key={consentKey(consent)} className="consent-state-card">
                    <div className="consent-state-heading">
                      <div>
                        <strong>{consentNames[consent.consentType]}</strong>
                        <span>版本 {consent.consentVersion}</span>
                      </div>
                      <span className="consent-state-badge">
                        {consent.isCurrentRequired ? '当前必要版本' : '历史版本'}
                      </span>
                    </div>
                    <dl className="consent-state-details">
                      <div>
                        <dt>当前状态</dt>
                        <dd>{statusLabel(consent)}</dd>
                      </div>
                      <div>
                        <dt>状态修订</dt>
                        <dd>{consent.stateRevision}</dd>
                      </div>
                    </dl>
                    <p className="muted">{documentEvidenceText(consent)}</p>
                    {consent.documentEvidenceStatus === 'verified' && consent.documentUrl ? (
                      <a href={consent.documentUrl} target="_blank" rel="noreferrer">
                        查看当时接受的文档
                      </a>
                    ) : null}
                    {consent.acceptableDocument ? (
                      <p className="consent-document-link">
                        <a
                          href={consent.acceptableDocument.documentUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看当前可接受文档（修订 {consent.acceptableDocument.documentRevision}）
                        </a>
                      </p>
                    ) : consent.isCurrentRequired && consent.authorizationStatus !== 'active' ? (
                      <p className="inline-warning">当前没有可核验文档，因此不能接受此版本。</p>
                    ) : null}
                    <div className="privacy-actions">
                      {canAccept ? (
                        <button
                          type="button"
                          className="button"
                          aria-label={`${consent.status === 'withdrawn' || consent.authorizationStatus === 'confirmation_required' ? '重新接受' : '接受'}${consentNames[consent.consentType]}版本 ${consent.consentVersion}`}
                          disabled={mutationBusy}
                          onClick={() => openDialog('accept', consent)}
                        >
                          {consent.status === 'withdrawn' ||
                          consent.authorizationStatus === 'confirmation_required'
                            ? '重新接受'
                            : '接受'}
                        </button>
                      ) : null}
                      {consent.withdrawalEnabled ? (
                        <button
                          type="button"
                          className="button button-danger"
                          aria-label={`撤回${consentNames[consent.consentType]}版本 ${consent.consentVersion}`}
                          disabled={mutationBusy}
                          onClick={() => openDialog('withdraw', consent)}
                        >
                          撤回
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="privacy-card" aria-labelledby="consent-history-title">
            <h2 id="consent-history-title">同意决定记录</h2>
            {history.length === 0 ? <p className="muted">暂无同意记录。</p> : null}
            <ol className="consent-history">
              {history.map((consent) => (
                <li key={consent.operationId}>
                  <div>
                    <strong>{consentNames[consent.consentType]}</strong>
                    <span>版本 {consent.consentVersion}</span>
                  </div>
                  <div>
                    <span>
                      {consent.action === 'accept' ? '接受' : '撤回'}于{' '}
                      {dateTimeFormatter.format(new Date(consent.occurredAt))}
                    </span>
                    <span>{consent.outcome === 'applied' ? '状态已更新' : '状态未改变'}</span>
                    {consent.action === 'accept' ? (
                      <span>
                        {consent.documentEvidenceStatus === 'verified'
                          ? `文档修订 ${consent.documentRevision ?? '未知'}`
                          : consent.documentEvidenceStatus === 'unmapped_legacy'
                            ? '历史记录未映射到可核验的文档身份'
                            : '文档证据当前不可用'}
                      </span>
                    ) : (
                      <span>
                        {consent.targetDocumentEvidenceStatus === 'verified'
                          ? `撤回对应文档修订 ${consent.targetDocumentRevision ?? '未知'}`
                          : consent.targetDocumentEvidenceStatus === 'unmapped_legacy'
                            ? '撤回了未映射文档身份的历史接受记录'
                            : '撤回目标的文档证据不可用'}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {nextCursor ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={loadingMore}
                onClick={() => void loadPage(nextCursor, 'more')}
              >
                {loadingMore ? '正在加载…' : '加载更多'}
              </button>
            ) : null}
          </section>

          <section
            className="privacy-card privacy-disclosure"
            aria-labelledby="data-boundary-title"
          >
            <h2 id="data-boundary-title">聊天与保留说明</h2>
            <p>
              普通聊天进入你的聊天历史，默认按当前 90 天策略处理；主动保留的聊天没有该默认到期时间。
            </p>
            <p>
              删除普通聊天会立即移除普通消息正文，但必要的 Risk
              Event、审计记录和备份遵循各自政策，不会因该操作自动同时删除。
            </p>
            <p>
              无痕普通聊天正文在本应用内不写入浏览器持久存储或普通聊天库，只保留于浏览器页面与 API
              进程的临时内存。启用 AI
              时，正文仍会发送至配置的第三方模型服务用于生成与安全分类；刷新、超时或服务重启后不承诺恢复。
            </p>
            <p>
              撤回会阻止依赖该授权的后续 AI 请求，并取消本 API
              进程中依赖它的活动工作和无痕上下文；已经发送给第三方的数据不会因此被召回。普通登录、隐私页和聊天历史管理仍可使用。
            </p>
            <p>
              为提供 AI
              与安全分类，输入可能被发送到配置的第三方模型服务。上线前仍需完成供应商隐私、留存、安全与适用合规审核。
            </p>
            <p>
              无痕模式仍可能为必要安全目的保留最小 Risk Event
              和审计元数据。当前尚未承诺账号删除、备份删除或安全记录的法律期限。
            </p>
          </section>
        </>
      ) : null}

      <ConfirmDialog
        open={dialog !== null}
        title={
          dialog
            ? `${dialog.action === 'accept' ? '接受' : '撤回'}${consentNames[dialog.consent.consentType]}？`
            : '确认同意操作'
        }
        confirmLabel={dialog?.action === 'accept' ? '确认接受' : '确认撤回'}
        busy={mutationBusy}
        confirmDisabled={dialog?.action === 'accept' ? !documentAcknowledged : false}
        destructive={dialog?.action === 'withdraw'}
        onConfirm={confirmAction}
        onClose={() => {
          if (!mutationBusy) {
            setDialog(null);
            setDocumentAcknowledged(false);
          }
        }}
      >
        {dialog?.action === 'accept' ? (
          <>
            <p>
              你将接受{consentNames[dialog.consent.consentType]}版本 {dialog.consent.consentVersion}
              。每次明确接受都会留下独立决定记录。
            </p>
            {dialog.consent.acceptableDocument ? (
              <p>
                <a
                  href={dialog.consent.acceptableDocument.documentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看文档修订 {dialog.consent.acceptableDocument.documentRevision}
                </a>
              </p>
            ) : null}
            <label className="consent-document-acknowledgement">
              <input
                type="checkbox"
                checked={documentAcknowledged}
                onChange={(event) => setDocumentAcknowledged(event.target.checked)}
              />
              <span>我已查看以上文档，并明确同意此版本。</span>
            </label>
          </>
        ) : dialog?.action === 'withdraw' ? (
          <>
            <p>
              后续依赖此授权的 AI 请求会被阻止；本 API
              进程中依赖它的活动工作会被取消，相关无痕上下文会被清除且无法恢复。
            </p>
            <p>
              已经发送给第三方的数据不会因此被召回。普通登录、隐私页和聊天历史管理仍可使用；本操作也不代表
              Risk Event、审计或备份被删除。
            </p>
          </>
        ) : null}
      </ConfirmDialog>
    </main>
  );
}
