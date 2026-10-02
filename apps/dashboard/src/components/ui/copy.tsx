'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from './button';

/** Copies text; announces the result through its own label change. */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </Button>
  );
}

/** Monospace value that wraps (keys, ids, URLs). */
export function Code({ children }: { children: string }) {
  return <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs break-all text-text">{children}</code>;
}
