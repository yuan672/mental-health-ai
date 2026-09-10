import type { AuthSession } from '@mental-health/types';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getSession, login as loginRequest, logout as logoutRequest } from '../api/auth';
import { ApiClientError } from '../api/client';
import { subscribeSessionInvalidated } from '../api/session-events';

export type SessionState =
  | Readonly<{ status: 'bootstrapping' }>
  | Readonly<{ status: 'guest' }>
  | Readonly<{ status: 'authenticated'; value: AuthSession }>
  | Readonly<{ status: 'error'; message: string }>;

type SessionContextValue = Readonly<{
  state: SessionState;
  retry: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}>;

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'bootstrapping' });
  const operationRef = useRef(0);
  const bootstrapAbortRef = useRef<AbortController | null>(null);

  const invalidateBootstrap = useCallback(() => {
    ++operationRef.current;
    bootstrapAbortRef.current?.abort();
    bootstrapAbortRef.current = null;
  }, []);

  const bootstrap = useCallback(() => {
    invalidateBootstrap();
    const operation = operationRef.current;
    const controller = new AbortController();
    bootstrapAbortRef.current = controller;
    setState({ status: 'bootstrapping' });
    void getSession(controller.signal)
      .then((response) => {
        if (operation === operationRef.current && !controller.signal.aborted) {
          setState({ status: 'authenticated', value: response.data });
        }
      })
      .catch((error: unknown) => {
        if (operation !== operationRef.current || controller.signal.aborted) return;
        if (error instanceof ApiClientError && error.status === 401) {
          setState({ status: 'guest' });
          return;
        }
        setState({
          status: 'error',
          message: error instanceof ApiClientError ? error.message : '无法确认登录状态，请重试',
        });
      })
      .finally(() => {
        if (bootstrapAbortRef.current === controller) bootstrapAbortRef.current = null;
      });
  }, [invalidateBootstrap]);

  useEffect(() => {
    void Promise.resolve().then(bootstrap);
    const unsubscribe = subscribeSessionInvalidated(() => {
      invalidateBootstrap();
      setState({ status: 'guest' });
    });
    return () => {
      invalidateBootstrap();
      unsubscribe();
    };
  }, [bootstrap, invalidateBootstrap]);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      retry: bootstrap,
      login: async (email, password) => {
        invalidateBootstrap();
        const operation = operationRef.current;
        const response = await loginRequest(email, password);
        if (operation === operationRef.current) {
          setState({ status: 'authenticated', value: response.data });
        }
      },
      logout: async () => {
        invalidateBootstrap();
        const operation = operationRef.current;
        await logoutRequest();
        if (operation === operationRef.current) {
          setState({ status: 'guest' });
        }
      },
    }),
    [bootstrap, invalidateBootstrap, state],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within SessionProvider');
  return context;
}
