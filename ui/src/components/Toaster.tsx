import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

type Kind = 'info' | 'error';
interface Toast {
  id: number;
  message: string;
  kind: Kind;
}

interface ToastApi {
  notify: (message: string, kind?: Kind) => void;
}

const ToastContext = createContext<ToastApi>({ notify: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, kind: Kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(current => [...current.slice(-3), { id, message, kind }]);
    window.setTimeout(() => {
      setToasts(current => current.filter(toast => toast.id !== id));
    }, 4500);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className="animate-fade-up pointer-events-auto flex max-w-md items-start gap-2 rounded-lg bg-panel px-4 py-3 text-sm text-ink shadow-xl ring-1 ring-line"
          >
            {toast.kind === 'error' ? (
              <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" />
            ) : (
              <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent" />
            )}
            <span className="flex-1 break-words">{toast.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="text-muted transition hover:text-ink"
              onClick={() => setToasts(current => current.filter(item => item.id !== toast.id))}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
