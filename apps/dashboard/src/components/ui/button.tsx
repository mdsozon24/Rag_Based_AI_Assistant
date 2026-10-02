import Link from 'next/link';
import { Slot } from 'radix-ui';
import { forwardRef, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
export type ButtonSize = 'sm' | 'md';

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:cursor-not-allowed aria-disabled:opacity-55 [&_svg]:size-4 [&_svg]:shrink-0';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-card',
  secondary: 'border border-control/60 bg-surface text-text hover:bg-surface-2',
  ghost: 'text-text hover:bg-surface-2',
  danger: 'bg-danger text-danger-fg hover:bg-danger-hover shadow-card',
  'danger-ghost': 'text-danger hover:bg-danger-soft',
};

/** At least 36 px tall (40 on md) so touch targets stay usable. */
const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string): string {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks clicks; the label stays for screen readers. */
  loading?: boolean;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading = false, asChild = false, className, children, disabled, type, ...props }, ref) {
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={buttonClass(variant, size, className)} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button ref={ref} type={type ?? 'button'} className={buttonClass(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
});

export function LinkButton({ variant = 'secondary', size = 'md', className, ...props }: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

/** A square icon-only button; `label` is its accessible name (and tooltip). */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'children'> & { label: string; icon: ReactNode }>(function IconButton({ label, icon, className, variant = 'ghost', size = 'sm', ...props }, ref) {
  return (
    <Button ref={ref} variant={variant} size={size} aria-label={label} title={label} className={cn(size === 'sm' ? 'w-9 px-0' : 'w-10 px-0', className)} {...props}>
      {icon}
    </Button>
  );
});
