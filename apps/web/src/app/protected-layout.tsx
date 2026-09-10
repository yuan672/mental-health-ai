import { Navigate, Outlet, useLocation } from 'react-router';
import { useSession } from './session-provider';

export function ProtectedLayout() {
  const { state, retry } = useSession();
  const location = useLocation();

  if (state.status === 'bootstrapping') {
    return (
      <main className="centered-state" aria-busy="true">
        正在确认登录状态…
      </main>
    );
  }
  if (state.status === 'error') {
    return (
      <main className="centered-state" role="alert">
        <p>{state.message}</p>
        <button type="button" className="button" onClick={retry}>
          重试
        </button>
      </main>
    );
  }
  if (state.status === 'guest') {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate replace to={`/login?returnTo=${encodeURIComponent(returnTo)}`} />;
  }
  return <Outlet />;
}
