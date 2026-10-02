'use client';

import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { Toast } from 'radix-ui';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ApiError, errorMessage } from '@/lib/api/client';

interface ToastItem {
  id: number;
  tone: 'success' | 'error';
  title: string;
  description?: string;
}

interface ToastApi {
  success(title: string, description?: string): void;
  error(title: string, error?: unknown): void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

/** Toasts announce themselves (Radix: a polite live region; errors stay until dismissed). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const remove = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const value = useMemo<ToastApi>(
    () => ({
      success: (title, description) => setItems((all) => [...all, { id: nextId++, tone: 'success', title, description }]),
      error: (title, error) => {
        const reference = error instanceof ApiError && error.requestId ? ` (reference ${error.requestId})` : '';
        setItems((all) => [...all, { id: nextId++, tone: 'error', title, description: error === undefined ? undefined : `${errorMessage(error)}${reference}` }]);
      },
    }),
    []
  );
  return (
    <ToastContext.Provider value={value}>
      <Toast.Provider swipeDirection="right" duration={5000}>
        {children}
        {items.map((item) => (
          <Toast.Root
            key={item.id}
            type={item.tone === 'error' ? 'foreground' : 'background'}
            duration={item.tone === 'error' ? Number.POSITIVE_INFINITY : 5000}
            onOpenChange={(open) => !open && remove(item.id)}
            className={cn('flex items-start gap-3 rounded-lg border bg-surface p-3 pr-2 shadow-lg', item.tone === 'error' ? 'border-danger/50' : 'border-border')}
          >
            {item.tone === 'error' ? <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" /> : <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />}
            <div className="min-w-0 flex-1">
              <Toast.Title className="text-sm font-semibold text-text">{item.title}</Toast.Title>
              {item.description ? <Toast.Description className="mt-0.5 text-sm break-words text-muted">{item.description}</Toast.Description> : null}
            </div>
            <Toast.Close aria-label="Dismiss" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text">
              <X aria-hidden="true" className="size-4" />
            </Toast.Close>
          </Toast.Root>
        ))}
        <Toast.Viewport className="fixed right-0 bottom-0 z-[60] flex w-full max-w-sm flex-col gap-2 p-4 outline-none" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
