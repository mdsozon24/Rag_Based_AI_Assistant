/** Wordmark with a simple mark; the text is the accessible name. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold text-text">
      <svg aria-hidden="true" viewBox="0 0 32 32" className="size-7 shrink-0">
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <circle cx="16" cy="13" r="6" fill="none" stroke="var(--accent-fg)" strokeWidth="2.5" />
        <path d="M9 22c1.5 3 3 3 4.5 0M14.5 22c1 3 2 3 3 0M18.5 22c1.5 3 3 3 4.5 0" fill="none" stroke="var(--accent-fg)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {compact ? <span className="sr-only">Voice of Octo</span> : <span className="text-lg tracking-tight">Voice of Octo</span>}
    </span>
  );
}
