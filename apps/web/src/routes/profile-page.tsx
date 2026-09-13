import type { ProfileResponse } from '@mental-health/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getProfile } from '../api/mood';
import { CatArt } from '../shared/cat-art';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function ProfilePage() {
  const [profile, setProfile] = useState<ProfileResponse['data'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    const controller = new AbortController();
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await getProfile(controller.signal);
      if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current)
        return;
      setProfile(response.data);
    } catch (reason) {
      if (!isAbortError(reason) && mountedRef.current && generation === generationRef.current) {
        setError('暂时无法读取账号资料，请稍后重试。');
      }
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void Promise.resolve().then(load);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  return (
    <main className="profile-page" aria-labelledby="profile-title">
      <header className="profile-header">
        <div>
          <p className="eyebrow">账号</p>
          <h1 id="profile-title">关于你</h1>
          <p>这里只展示已有账号事实，不收集额外个人资料。</p>
        </div>
        <CatArt mood="hopeful" />
      </header>
      {loading ? <p aria-busy="true">正在加载账号资料…</p> : null}
      {error ? (
        <div className="profile-feedback" role="alert">
          <p>{error}</p>
          <button type="button" className="button button-secondary" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}
      {profile ? (
        <section className="profile-card" aria-label="账号资料">
          <dl>
            <div>
              <dt>邮箱</dt>
              <dd>{profile.email}</dd>
            </div>
            <div>
              <dt>账号创建时间</dt>
              <dd>{dateFormatter.format(new Date(profile.accountCreatedAt))}</dd>
            </div>
            <div>
              <dt>成年资格验证时间</dt>
              <dd>{dateFormatter.format(new Date(profile.adultEligibility.verifiedAt))}</dd>
            </div>
          </dl>
          <p className="muted">成年资格已验证。此页面不展示验证方式或内部证据。</p>
          <div className="profile-actions">
            <Link className="button button-secondary" to="/app/privacy">
              隐私与数据
            </Link>
          </div>
        </section>
      ) : null}
    </main>
  );
}
