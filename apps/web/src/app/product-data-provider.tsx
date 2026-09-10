import type { CapabilitiesResponse, QuotaResponse } from '@mental-health/types';
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
import { getCapabilities, getQuota } from '../api/product';

type ProductDataContextValue = Readonly<{
  capabilities: CapabilitiesResponse['data'] | null;
  quota: QuotaResponse['data']['quota'] | null;
  loading: boolean;
  error: string | null;
  refreshQuota: () => Promise<void>;
}>;

const ProductDataContext = createContext<ProductDataContextValue | null>(null);

export function ProductDataProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse['data'] | null>(null);
  const [quota, setQuota] = useState<QuotaResponse['data']['quota'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refreshQuota = useCallback(async () => {
    const response = await getQuota();
    if (mountedRef.current) setQuota(response.data.quota);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void Promise.all([getCapabilities(controller.signal), getQuota(controller.signal)])
      .then(([capabilitiesResponse, quotaResponse]) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setCapabilities(capabilitiesResponse.data);
        setQuota(quotaResponse.data.quota);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '无法加载产品状态');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, []);

  const value = useMemo(
    () => ({ capabilities, quota, loading, error, refreshQuota }),
    [capabilities, error, loading, quota, refreshQuota],
  );
  return <ProductDataContext.Provider value={value}>{children}</ProductDataContext.Provider>;
}

export function useProductData(): ProductDataContextValue {
  const context = useContext(ProductDataContext);
  if (!context) throw new Error('useProductData must be used within ProductDataProvider');
  return context;
}
