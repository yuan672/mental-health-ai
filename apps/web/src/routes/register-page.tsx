import type { RegistrationRequirementsResponse } from '@mental-health/types';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import brandArt from '../assets/cozy-brand.png';
import { getRegistrationRequirements, register } from '../api/auth';
import { copy } from '../locales';
import { CatArt } from '../shared/cat-art';
import { Icon } from '../shared/icons';
import { registrationPasswordError } from './registration-password';

export function RegisterPage() {
  const navigate = useNavigate();
  const [requirements, setRequirements] = useState<RegistrationRequirementsResponse['data'] | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [evidenceToken, setEvidenceToken] = useState('');
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getRegistrationRequirements(controller.signal)
      .then((response) => setRequirements(response.data))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(error instanceof Error ? error.message : '无法加载注册信息');
      });
    return () => controller.abort();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!requirements?.registrationEnabled) return;
    const validationError = registrationPasswordError(password);
    setPasswordError(validationError);
    setSubmitError(null);
    if (validationError) {
      passwordRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await register({
        email,
        password,
        evidenceToken,
        consents: requirements.requiredConsents.map((consent) => ({
          consentType: consent.type,
          consentVersion: consent.version,
          documentKey: consent.documentKey,
          documentRevision: consent.documentRevision,
          accepted: true,
        })),
      });
      navigate('/login?registered=1', { replace: true });
    } catch {
      setSubmitError('暂时无法完成注册，请核对填写信息或稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  const allAccepted =
    requirements?.requiredConsents.every((consent) =>
      accepted.has(`${consent.type}:${consent.version}`),
    ) ?? false;

  return (
    <main className="register-design-page">
      <aside className="register-public-rail" aria-label="注册辅助导航">
        <Link className="register-brand" to="/">
          <img src={brandArt} alt="" />
          <span>
            <strong>{copy.app.shortName}</strong>
            <small>温柔的倾听与陪伴</small>
          </span>
        </Link>
        <div className="register-rail-copy">
          <CatArt mood="sleepy" alt="一只安静休息的手绘猫咪" />
          <p>慢慢填写就好。</p>
          <small>账号信息只用于提供你选择的服务。</small>
        </div>
        <nav>
          <Link to="/">
            <Icon name="home" /> 返回首页
          </Link>
          <Link to="/login">
            <Icon name="arrow-right" /> 已有账号登录
          </Link>
        </nav>
      </aside>
      <section className="register-workspace" aria-labelledby="register-title">
        <header className="register-mobile-header">
          <Link to="/">
            <Icon name="arrow-left" /> 返回
          </Link>
          <span>{copy.app.shortName}</span>
        </header>
        <div className="register-page-heading">
          <p className="eyebrow">仅面向成年人</p>
          <h1 id="register-title">注册</h1>
          <p>阅读当前说明，并通过已配置的验证流程创建账号。</p>
        </div>
        <section className="register-paper" aria-label="创建账号">
          <div className="register-paper-heading">
            <CatArt mood="shy" alt="一只探出头的手绘猫咪" />
            <div>
              <h2>创建账号</h2>
              <p>完成必要验证后，开始你的安心空间。</p>
            </div>
          </div>
          {!requirements && !loadError ? <p aria-busy="true">正在加载注册信息…</p> : null}
          {loadError ? (
            <p className="inline-error" role="alert">
              {loadError}
            </p>
          ) : null}
          {requirements && !requirements.registrationEnabled ? (
            <div className="unavailable-state" role="status">
              <h2>注册暂不可用</h2>
              <p>当前注册前置条件尚未准备完成。已有账号仍可正常登录。</p>
              <Link className="button" to="/login">
                前往登录
              </Link>
            </div>
          ) : null}
          {requirements?.registrationEnabled ? (
            <form className="register-form" onSubmit={(event) => void submit(event)}>
              <p className="form-help">
                仅支持已完成 {requirements.minimumAge} 岁及以上验证的用户。
              </p>
              <label htmlFor="register-email">邮箱</label>
              <input
                id="register-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <label htmlFor="register-password">密码</label>
              <input
                id="register-password"
                ref={passwordRef}
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (passwordError)
                    setPasswordError(registrationPasswordError(event.target.value));
                }}
                aria-invalid={passwordError ? true : undefined}
                aria-describedby={passwordError ? 'password-help password-error' : 'password-help'}
              />
              <p id="password-help" className="form-help">
                12–128 个字符；小写英文字母、大写英文字母、数字、符号中至少使用三类。
              </p>
              {passwordError ? (
                <p id="password-error" className="inline-error" role="alert">
                  {passwordError}
                </p>
              ) : null}
              <label htmlFor="age-evidence">年龄验证凭证</label>
              <input
                id="age-evidence"
                type="password"
                autoComplete="off"
                required
                value={evidenceToken}
                onChange={(event) => setEvidenceToken(event.target.value)}
                aria-describedby="evidence-help"
              />
              <p id="evidence-help" className="form-help">
                凭证只能来自已配置的验证流程；请勿在此填写身份证号码或其他身份资料。
              </p>
              <fieldset>
                <legend>必要条款</legend>
                {requirements.requiredConsents.map((consent) => {
                  const key = `${consent.type}:${consent.version}`;
                  const label =
                    consent.displayKey === 'consent.termsOfService'
                      ? copy.consent.termsOfService
                      : copy.consent.privacyPolicy;
                  return (
                    <label className="checkbox-label" key={key}>
                      <input
                        type="checkbox"
                        checked={accepted.has(key)}
                        onChange={(event) =>
                          setAccepted((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(key);
                            else next.delete(key);
                            return next;
                          })
                        }
                      />
                      <span>
                        我已阅读并接受
                        <a href={consent.documentUrl} target="_blank" rel="noreferrer">
                          {label}
                        </a>
                        （版本 {consent.version}）
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              {submitError ? (
                <p className="inline-error" role="alert">
                  {submitError}
                </p>
              ) : null}
              <button
                className="button button-block"
                type="submit"
                disabled={submitting || !allAccepted || !evidenceToken}
              >
                {submitting ? '正在注册…' : '注册'}
              </button>
            </form>
          ) : null}
          <p className="auth-switch">
            已有账号？ <Link to="/login">登录</Link>
          </p>
        </section>
      </section>
    </main>
  );
}
