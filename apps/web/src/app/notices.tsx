import { XIcon } from '@primer/octicons-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { type MessageKey, useT } from '../i18n/index.js';
import { errorKey } from '../lib/errors.js';

interface Notice {
  id: number;
  key: MessageKey;
  tone: 'danger' | 'info';
}

interface Notices {
  /** Shows the fixed text for an error (D44). */
  error: (err: unknown) => void;
  info: (key: MessageKey) => void;
}

const Ctx = createContext<Notices | null>(null);
let seq = 0;

/** Page-wide notices: errors are never silent (global rules), always with an action text. */
export function NoticesProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [items, setItems] = useState<Notice[]>([]);
  const push = useCallback((key: MessageKey, tone: Notice['tone']) => {
    const id = ++seq;
    setItems((xs) => [...xs.filter((x) => x.key !== key), { id, key, tone }].slice(-3));
  }, []);
  const value = useMemo<Notices>(
    () => ({ error: (e) => push(errorKey(e), 'danger'), info: (k) => push(k, 'info') }),
    [push],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="notices" aria-live="polite">
        {items.map((n) => (
          <div
            key={n.id}
            className={`alert alert-${n.tone}`}
            role={n.tone === 'danger' ? 'alert' : 'status'}
          >
            <span>{t(n.key)}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label={t('common.dismiss')}
              onClick={() => setItems((xs) => xs.filter((x) => x.id !== n.id))}
            >
              <XIcon size={16} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useNotices(): Notices {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNotices outside NoticesProvider');
  return v;
}
