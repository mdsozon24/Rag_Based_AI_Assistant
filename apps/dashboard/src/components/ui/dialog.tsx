'use client';

import { X } from 'lucide-react';
import { AlertDialog, Dialog as RadixDialog } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button';

/**
 * Modal dialog (Radix: focus trapped and returned, Escape closes, title and description announced).
 * Controlled with open/onOpenChange, or uncontrolled with a trigger.
 */
export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <RadixDialog.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-xl border border-border bg-surface shadow-xl sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
            widths[size]
          )}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <RadixDialog.Title className="text-lg font-semibold text-text">{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className="mt-1 text-sm text-muted">{description}</RadixDialog.Description> : null}
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="sm" className="w-9 px-0" aria-label="Close">
                <X aria-hidden="true" />
              </Button>
            </RadixDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;

/**
 * Confirmation for destructive or irreversible actions. The cancel button gets focus first, so
 * Enter never confirms by accident. `onConfirm` may be async; the dialog stays open until it settles.
 */
export function ConfirmDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = 'danger',
  onConfirm,
  children,
}: {
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => unknown | Promise<unknown>;
  children?: ReactNode;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = (next: boolean) => {
    if (busy) return;
    onOpenChange?.(next);
    if (controlledOpen === undefined) setInnerOpen(next);
  };
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      {trigger ? <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger> : null}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl">
          <AlertDialog.Title className="text-lg font-semibold text-text">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted">{description}</AlertDialog.Description>
          {children ? <div className="mt-3">{children}</div> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={busy}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  onOpenChange?.(false);
                  if (controlledOpen === undefined) setInnerOpen(false);
                } catch {
                  // The caller reports the error (toast); the dialog stays open so it can be retried
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
