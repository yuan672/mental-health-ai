import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import loginArt from '../assets/login-sleep.png';
import loginRoom from '../assets/login-room.png';
import { useSession } from '../app/session-provider';
import { safeReturnTo } from '../app/return-to';
import { copy } from '../locales';
import { Icon } from '../shared/icons';
import brandArt from '../assets/cozy-brand.png';

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catState, setCatState] = useState<'rest' | 'peek' | 'caught' | 'sleep'>('rest');
  const catTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (catTimerRef.current !== null) globalThis.clearTimeout(catTimerRef.current);
    },
    [],
  );

  const wakeCat = () => {
    if (catTimerRef.current !== null) globalThis.clearTimeout(catTimerRef.current);
    setCatState('peek');
    catTimerRef.current = globalThis.setTimeout(() => setCatState('rest'), 14_900);
  };

  const catchCat = () => {
    if (catTimerRef.current !== null) globalThis.clearTimeout(catTimerRef.current);
    setCatState('caught');
    catTimerRef.current = globalThis.setTimeout(() => setCatState('sleep'), 1_100);
  };

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
    <main className="auth-page design-auth-page login-auth-page" data-cat-state={catState}>
      <div className="login-cat-scene" aria-hidden="true">
        <img className="login-room-art" src={loginRoom} alt="" />
        <img className="login-cat-layer" src={loginArt} alt="" />
        <span className="login-cat-zzz">
          <i>z</i>
          <i>z</i>
          <i>z</i>
        </span>
      </div>
      <header className="login-auth-header">
        <Link className="login-auth-brand" to="/" aria-label="安心支持，返回首页">
          <img src={brandArt} alt="" />
          <span>{copy.app.shortName}</span>
        </Link>
        <Link className="login-auth-home" to="/">
          <Icon name="arrow-left" /> 返回首页
        </Link>
      </header>
      <section className="login-auth-center" aria-labelledby="login-title">
        <div className="login-auth-welcome">
          <img src={brandArt} alt="" aria-hidden="true" />
          <h1 id="login-title" aria-label="登录">
            欢迎回来
          </h1>
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
        <form className="login-auth-form" onSubmit={(event) => void submit(event)}>
          <div className="login-auth-field">
            <label htmlFor="login-email">邮箱</label>
            <div className="login-auth-input">
              <Icon name="mail" />
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                placeholder="请输入邮箱"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  wakeCat();
                }}
              />
            </div>
          </div>
          <div className="login-auth-field">
            <label htmlFor="login-password">密码</label>
            <div className="login-auth-input">
              <Icon name="lock" />
              <input
                id="login-password"
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="current-password"
                required
                placeholder="请输入密码"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  wakeCat();
                }}
              />
              <button
                type="button"
                className="login-password-toggle"
                aria-label={passwordVisible ? '隐藏输入内容' : '显示输入内容'}
                aria-pressed={passwordVisible}
                onClick={() => setPasswordVisible((current) => !current)}
              >
                <Icon name={passwordVisible ? 'eye-off' : 'eye'} />
              </button>
            </div>
          </div>
          <div className="login-auth-options">
            <span>不在浏览器保存邮箱或密码</span>
            <button type="button" onClick={() => setError('密码找回暂未开放，请联系账号管理员。')}>
              忘记密码？
            </button>
          </div>
          {error ? (
            <p id="login-error" className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="login-auth-submit"
            type="submit"
            disabled={submitting}
            aria-label="登录"
            aria-describedby={error ? 'login-error' : undefined}
          >
            <span>{submitting ? '正在登录…' : '安心进入'}</span>
            <Icon name="arrow-right" />
          </button>
        </form>
        <p className="login-auth-register">
          还没有账号？{' '}
          <Link to="/register">
            注册一个 <Icon name="arrow-right" />
          </Link>
        </p>
      </section>
      <p className="login-cat-caption" aria-hidden="true">
        {catState === 'peek'
          ? '让我悄悄看一眼……'
          : catState === 'rest'
            ? '慢慢来，小猫在。'
            : '呼……我已经睡着啦。'}
      </p>
      <button
        type="button"
        className="login-cat-hotspot"
        aria-label={
          catState === 'peek' ? '发现一只偷看的小猫，点一下让它装睡' : '小猫正在睡觉，轻轻看看它'
        }
        onPointerEnter={catchCat}
        onFocus={catchCat}
        onClick={catchCat}
      />
      <footer className="login-auth-footer">
        <span>登录后可查看服务条款与隐私说明</span>
      </footer>
    </main>
  );
}
