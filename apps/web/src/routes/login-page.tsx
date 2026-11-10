import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useSession } from '../app/session-provider';
import { safeReturnTo } from '../app/return-to';
import { copy } from '../locales';
import { LoginCatScene } from '../features/login-cat/login-cat-scene';
import { brandCat } from '../shared/cat-art';
import { CozyIcon } from '../shared/cozy-icon';

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.state.status === 'authenticated') {
    return <Navigate replace to={safeReturnTo(searchParams.get('returnTo'))} />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await session.login(email, password);
      navigate(safeReturnTo(searchParams.get('returnTo')), { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page cozy-login">
      <LoginCatScene />
      <header className="login-header">
        <Link className="brand-link" to="/">
          <img className="brand-cat" src={brandCat} alt="" />
          {copy.app.name}
        </Link>
        <Link className="login-home" to="/">
          ← 返回首页
        </Link>
      </header>
      <section className="auth-card" aria-labelledby="login-title">
        <div className="login-welcome">
          <span aria-hidden="true">✦</span>
          <h1 id="login-title">欢迎回来</h1>
          <p>今天的故事，也想听你慢慢说。</p>
        </div>
        {session.state.status === 'guest' && session.state.reason === 'expired' ? (
          <p className="success-note" role="status">
            登录状态已失效，请重新登录。如刚才有正在提交的操作，请登录后核对状态。
          </p>
        ) : session.state.status === 'guest' && session.state.reason === 'signed-out' ? (
          <p className="success-note" role="status">
            你已退出登录。
          </p>
        ) : null}
        {searchParams.get('registered') === '1' ? (
          <p className="success-note" role="status">
            注册成功，请登录。
          </p>
        ) : null}
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="login-email">邮箱</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            required
            placeholder="请输入邮箱"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="login-password">密码</label>
          <div className="login-password-wrap">
            <input
              id="login-password"
              type={visible ? 'text' : 'password'}
              autoComplete="current-password"
              required
              placeholder="请输入密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              className="login-eye"
              aria-label={visible ? '隐藏密码' : '显示密码'}
              aria-pressed={visible}
              onClick={() => setVisible((v) => !v)}
            >
              <CozyIcon name="eye" />
            </button>
          </div>
          {error ? (
            <p id="login-error" className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="button button-block"
            type="submit"
            disabled={submitting}
            aria-describedby={error ? 'login-error' : undefined}
          >
            {submitting ? '正在登录…' : '登录'} {!submitting ? <CozyIcon name="arrow" /> : null}
          </button>
        </form>
        <p className="auth-switch">
          还没有账号？ <Link to="/register">注册一个 →</Link>
        </p>
      </section>
    </main>
  );
}
