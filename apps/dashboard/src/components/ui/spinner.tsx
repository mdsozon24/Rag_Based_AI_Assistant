import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Decorative: whatever shows it also says what is loading (aria-busy, or a text label). */
export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={cn('size-4 animate-spin', className)} />;
}
