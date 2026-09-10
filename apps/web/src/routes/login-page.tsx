import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useSession } from '../app/session-provider';
import { safeReturnTo } from '../app/return-to';
import { copy } from '../locales';

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    <main className="auth-page">
      <Link className="brand-link" to="/">
        {copy.app.name}
      </Link>
      <section className="auth-card" aria-labelledby="login-title">
        <p className="eyebrow">欢迎回来</p>
        <h1 id="login-title">登录</h1>
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
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="login-password">密码</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
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
            {submitting ? '正在登录…' : '登录'}
          </button>
        </form>
        <p className="auth-switch">
          还没有账号？ <Link to="/register">查看注册</Link>
        </p>
      </section>
    </main>
  );
}
