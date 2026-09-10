import type { ConsentHistoryItem, ConsentHistoryResponse, ConsentType } from '@mental-health/types';
import { useCallback, useEffect, useState } from 'react';
import { getConsentHistory } from '../api/consents';

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

type CurrentConsent = ConsentHistoryResponse['data']['currentRequiredConsents'][number];

export function PrivacyPage() {
  const [current, setCurrent] = useState<CurrentConsent[]>([]);
  const [history, setHistory] = useState<ConsentHistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor: string | null, signal?: AbortSignal) => {
    const response = await getConsentHistory(cursor, signal);
    if (signal?.aborted) return;
    setCurrent(response.data.currentRequiredConsents);
    setHistory((items) =>
      cursor ? [...items, ...response.data.consents] : response.data.consents,
    );
    setNextCursor(response.data.nextCursor);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => load(null, controller.signal))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '无法加载隐私设置');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      await load(nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加载更多同意记录');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <main className="privacy-page" aria-labelledby="privacy-title">
      <header className="privacy-header">
        <p className="eyebrow">隐私与数据</p>
        <h1 id="privacy-title">了解当前的数据边界</h1>
        <p>
          本页展示当前必要同意状态和历史记录。当前版本不提供撤回或重新接受操作，以免在政策语义尚未确认前制造误导。
        </p>
      </header>

      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p aria-busy="true">正在加载…</p> : null}

      {!loading ? (
        <>
          <section className="privacy-card" aria-labelledby="current-consents-title">
            <h2 id="current-consents-title">当前必要同意</h2>
            <ul className="privacy-list">
              {current.map((consent) => (
                <li key={`${consent.consentType}:${consent.consentVersion}`}>
                  <span>{consentNames[consent.consentType]}</span>
                  <span>版本 {consent.consentVersion}</span>
                  <strong>
                    {consent.status === 'accepted'
                      ? '已接受'
                      : consent.status === 'withdrawn'
                        ? '已撤回'
                        : '尚未接受'}
                  </strong>
                </li>
              ))}
            </ul>
          </section>

          <section className="privacy-card" aria-labelledby="consent-history-title">
            <h2 id="consent-history-title">同意记录</h2>
            {history.length === 0 ? <p className="muted">暂无同意记录。</p> : null}
            <ol className="consent-history">
              {history.map((consent, index) => (
                <li
                  key={`${consent.consentType}:${consent.consentVersion}:${consent.acceptedAt}:${index}`}
                >
                  <div>
                    <strong>{consentNames[consent.consentType]}</strong>
                    <span>版本 {consent.consentVersion}</span>
                  </div>
                  <div>
                    <span>接受于 {dateTimeFormatter.format(new Date(consent.acceptedAt))}</span>
                    {consent.withdrawnAt ? (
                      <span>撤回于 {dateTimeFormatter.format(new Date(consent.withdrawnAt))}</span>
                    ) : (
                      <span>状态：已接受</span>
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
                onClick={() => void loadMore()}
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
    </main>
  );
}
