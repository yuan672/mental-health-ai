import type { PersonalSettings } from '@mental-health/types';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { diaryApi } from '../api/diary';
import { ApiClientError } from '../api/client';

type SettingsContext = {
  data: PersonalSettings | null;
  error: string | null;
  busy: boolean;
  reload: () => Promise<void>;
  update: (patch: Partial<Omit<PersonalSettings, 'revision'>>, file?: File) => Promise<void>;
};
const Context = createContext<SettingsContext | null>(null);
export function PersonalSettingsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<PersonalSettings | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const mounted = useRef(false),
    current = useRef<PersonalSettings | null>(null),
    writing = useRef(false),
    uncertain = useRef(false),
    readGeneration = useRef(0),
    readController = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    if (writing.current) return;
    const generation = ++readGeneration.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    try {
      const r = await diaryApi.settings(controller.signal);
      if (mounted.current && generation === readGeneration.current && !controller.signal.aborted) {
        current.current = r.data.settings;
        uncertain.current = false;
        setData(r.data.settings);
        setError(null);
      }
    } catch (e) {
      if (mounted.current && !controller.signal.aborted && generation === readGeneration.current)
        setError(e instanceof Error ? e.message : '设置暂时无法读取');
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(reload);
    return () => {
      mounted.current = false;
      current.current = null;
      readController.current?.abort();
      readGeneration.current += 1;
    };
  }, [reload]);
  const update = useCallback(
    async (patch: Partial<Omit<PersonalSettings, 'revision'>>, file?: File) => {
      if (!current.current || writing.current) throw new Error('请等待设置读取完成');
      if (uncertain.current) throw new Error('上次保存还未确认，请先重新读取设置');
      readController.current?.abort();
      readGeneration.current += 1;
      const { revision, ...fields } = current.current;
      writing.current = true;
      setBusy(true);
      setError(null);
      try {
        const r = await diaryApi.updateSettings(
          { ...fields, ...patch, expectedRevision: revision },
          file,
        );
        if (mounted.current) {
          current.current = r.data.settings;
          setData(r.data.settings);
        }
      } catch (e) {
        // Rejected validation/upload bodies never reach the settings transaction.
        const rejectedInput = e instanceof ApiClientError && (e.status === 400 || e.status === 413);
        uncertain.current = !rejectedInput;
        if (mounted.current)
          setError(rejectedInput ? e.message : '保存未确认，请重新读取设置核对后再操作。');
        throw e;
      } finally {
        writing.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );
  return (
    <Context.Provider value={{ data, error, busy, reload, update }}>{children}</Context.Provider>
  );
}
export function usePersonalSettings() {
  return useContext(Context);
}
