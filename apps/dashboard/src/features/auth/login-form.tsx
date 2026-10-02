'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { ApiError, post } from '@/lib/api/client';
import { apiErrorsFor, focusFirstError, validate, type FieldErrors } from '@/lib/forms';
import { safeNext } from '@/lib/navigation';
import { loginSchema } from '@/lib/schemas/auth';
import { ME_KEY } from '@/lib/session';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const client = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const next = safeNext(params.get('next'));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setUnverified(false);
    const checked = validate(loginSchema, values);
    if (!checked.ok) {
      setErrors(checked.errors);
      focusFirstError(formRef.current);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await post('/v1/auth/login', checked.value);
      client.removeQueries();
      await client.invalidateQueries({ queryKey: ME_KEY });
      router.replace(next);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'email_not_verified') setUnverified(true);
      setErrors(error instanceof ApiError && error.status === 401 ? { _form: 'The email or password is incorrect.' } : apiErrorsFor(error));
      focusFirstError(formRef.current);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-xl font-semibold text-text">Sign in</h1>
      <p className="mt-1 text-sm text-muted">
        New to Voice of Octo?{' '}
        <Link href={`/signup${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-accent-text underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
      <form ref={formRef} onSubmit={submit} noValidate className="mt-6 flex flex-col gap-4">
        <FormError errors={errors} shown={['email', 'password']} />
        {unverified ? (
          <div className="rounded-md bg-info-soft px-3 py-2.5 text-sm text-text">
            {resent ? (
              <p role="status">We sent a new link to {values.email}.</p>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await post('/v1/auth/resend-verification', { email: values.email }).catch(() => undefined);
                  setResent(true);
                }}
              >
                Send the verification email again
              </Button>
            )}
          </div>
        ) : null}
        <Field label="Email" error={errors.email} required>
          {(props) => <Input {...props} type="email" autoComplete="email" value={values.email} onChange={(e) => setValues({ ...values, email: e.target.value })} />}
        </Field>
        <Field label="Password" error={errors.password} required>
          {(props) => <Input {...props} type="password" autoComplete="current-password" value={values.password} onChange={(e) => setValues({ ...values, password: e.target.value })} />}
        </Field>
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-sm font-medium text-accent-text underline-offset-4 hover:underline">
            Forgot your password?
          </Link>
        </div>
        <Button type="submit" variant="primary" loading={busy}>
          Sign in
        </Button>
        {process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === 'true' ? (
          // A full navigation: the API redirects to Google and back with a session
          <a href="/v1/auth/google/start" className="inline-flex h-10 items-center justify-center rounded-md border border-control/60 bg-surface text-sm font-medium text-text hover:bg-surface-2">
            Continue with Google
          </a>
        ) : null}
      </form>
    </>
  );
}
