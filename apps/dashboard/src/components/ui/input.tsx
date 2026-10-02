import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const control =
  'w-full rounded-md border border-control bg-surface px-3 text-sm text-text placeholder:text-muted/80 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-70 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, 'h-10', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 4, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(control, 'py-2 leading-relaxed', className)} {...props} />;
});

/** Native select: the most robust choice for keyboards, screen readers and phones. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(control, 'h-10 pr-8', className)} {...props}>
      {children}
    </select>
  );
});

export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function Checkbox({ className, ...props }, ref) {
  return <input ref={ref} type="checkbox" className={cn('size-4 rounded border-control accent-[var(--accent)]', className)} {...props} />;
});
