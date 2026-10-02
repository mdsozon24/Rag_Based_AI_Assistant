'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, LinkButton } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/states';
import { ApiError, errorMessage, get, post } from '@/lib/api/client';
import { apiErrorsFor, focusFirstError, validate, type FieldErrors } from '@/lib/forms';
import { emailOnlySchema, resetSchema } from '@/lib/schemas/auth';
import { ME_KEY, useOrgSwitch, type Me } from '@/lib/session';

const link = 'text-sm font-medium text-accent-text underline-offset-4 hover:underline';

function Outcome({ ok, title, children }: { ok: boolean; title: string; children?: ReactNode }) {
  return (
    <div role={ok ? 'status' : 'alert'} className="flex flex-col items-start gap-3">
      {ok ? <CircleCheck aria-hidden="true" className="size-8 text-success" /> : <CircleAlert aria-hidden="true" className="size-8 text-danger" />}
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      {children}
    </div>
  );
}

/** Single-use tokens are consumed once even when React runs effects twice (dev) or the page re-renders. */
const verifications = new Map<string, Promise<unknown>>();

export function VerifyEmail() {
  const token = useSearchParams().get('token') ?? '';
  const query = useQuery({
    queryKey: ['verify-email', token],
    enabled: token.length >= 10,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: () => {
      if (!verifications.has(token)) verifications.set(token, post('/v1/auth/verify-email', { token }));
      return verifications.get(token)!;
    },
  });
  if (token.length < 10) return <Outcome ok={false} title="This link is incomplete">{<p className="text-sm text-muted">Open the link from your email again, or ask for a new one when you sign in.</p>}</Outcome>;
  if (query.isPending) return <LoadingState label="Confirming your email…" rows={2} />;
  if (query.isError)
    return (
      <Outcome ok={false} title="We could not confirm your email">
        <p className="text-sm text-muted">{query.error instanceof ApiError && query.error.status === 400 ? 'The link has expired or was already used. Sign in to get a new one.' : errorMessage(query.error)}</p>
        <LinkButton href="/login" variant="primary">
          Go to sign in
        </LinkButton>
      </Outcome>
    );
  return (
    <Outcome ok title="Email confirmed">
      <p className="text-sm text-muted">Your account is ready. Sign in to continue.</p>
      <LinkButton href="/login" variant="primary">
        Sign in
      </LinkButton>
    </Outcome>
  );
}

export function ForgotPassword() {
  const formRef = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const checked = validate(emailOnlySchema, { email });
    if (!checked.ok) {
      setErrors(checked.errors);
      focusFirstError(formRef.current);
      return;
    }
    setBusy(true);
    try {
      await post('/v1/auth/forgot-password', checked.value);
      setSent(true);
    } catch (error) {
      setErrors(apiErrorsFor(error));
      focusFirstError(formRef.current);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div role="status" className="flex flex-col items-start gap-3">
        <MailCheck aria-hidden="true" className="size-8 text-accent" />
        <h1 className="text-xl font-semibold text-text">Check your email</h1>
        <p className="text-sm text-muted">If an account exists for {email}, we sent a link to choose a new password. It expires in 1 hour.</p>
        <Link href="/login" className={link}>
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <>
      <h1 className="text-xl font-semibold text-text">Reset your password</h1>
      <p className="mt-1 text-sm text-muted">We will email you a link to choose a new one.</p>
      <form ref={formRef} onSubmit={submit} noValidate className="mt-6 flex flex-col gap-4">
        <FormError errors={errors} shown={['email']} />
        <Field label="Email" error={errors.email} required>
          {(props) => <Input {...props} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          Send reset link
        </Button>
        <Link href="/login" className={link}>
          Back to sign in
        </Link>
      </form>
    </>
  );
}

export function ResetPassword() {
  const token = useSearchParams().get('token') ?? '';
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ password: '', confirm: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const checked = validate(resetSchema, values);
    if (!checked.ok) {
      setErrors(checked.errors);
      focusFirstError(formRef.current);
      return;
    }
    setBusy(true);
    try {
      await post('/v1/auth/reset-password', { token, password: checked.value.password });
      setDone(true);
    } catch (error) {
      setErrors(error instanceof ApiError && error.status === 400 && !error.issues.length ? { _form: 'This link has expired or was already used. Ask for a new one.' } : apiErrorsFor(error));
      focusFirstError(formRef.current);
    } finally {
      setBusy(false);
    }
  }

  if (!token) return <Outcome ok={false} title="This link is incomplete">{<Link href="/forgot-password" className={link}>Ask for a new link</Link>}</Outcome>;
  if (done)
    return (
      <Outcome ok title="Password changed">
        <p className="text-sm text-muted">You were signed out everywhere. Sign in with your new password.</p>
        <LinkButton href="/login" variant="primary">
          Sign in
        </LinkButton>
      </Outcome>
    );
  return (
    <>
      <h1 className="text-xl font-semibold text-text">Choose a new password</h1>
      <form ref={formRef} onSubmit={submit} noValidate className="mt-6 flex flex-col gap-4">
        <FormError errors={errors} shown={['password', 'confirm']} />
        <Field label="New password" description="At least 10 characters." error={errors.password} required>
          {(props) => <Input {...props} type="password" autoComplete="new-password" value={values.password} onChange={(e) => setValues({ ...values, password: e.target.value })} />}
        </Field>
        <Field label="Repeat the password" error={errors.confirm} required>
          {(props) => <Input {...props} type="password" autoComplete="new-password" value={values.confirm} onChange={(e) => setValues({ ...values, confirm: e.target.value })} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          Change password
        </Button>
      </form>
    </>
  );
}

export function AcceptInvitation() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const client = useQueryClient();
  const { reset } = useOrgSwitch();
  const me = useQuery({ queryKey: ME_KEY, queryFn: () => get<Me>('/v1/me'), retry: false });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const here = `/invite?token=${encodeURIComponent(token)}`;

  if (!token) return <Outcome ok={false} title="This invitation link is incomplete">{<p className="text-sm text-muted">Open the link from your email again.</p>}</Outcome>;
  if (me.isPending) return <LoadingState rows={2} />;
  if (me.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-xl font-semibold text-text">You are invited</h1>
        <p className="text-sm text-muted">Sign in with the email address the invitation was sent to, or create an account with it, to join the organization.</p>
        <div className="flex flex-wrap gap-2">
          <LinkButton href={`/login?next=${encodeURIComponent(here)}`} variant="primary">
            Sign in
          </LinkButton>
          <LinkButton href={`/signup?next=${encodeURIComponent(here)}`}>Create an account</LinkButton>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-xl font-semibold text-text">Join the organization</h1>
      <p className="text-sm text-muted">
        You are signed in as <strong className="text-text">{me.data.user.email}</strong>. The invitation must be for this address.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error instanceof ApiError && error.status === 400 ? 'This invitation is invalid, has expired, or is for a different email address.' : errorMessage(error)}
        </p>
      ) : null}
      <Button
        variant="primary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await post('/v1/invitations/accept', { token });
            await reset();
            client.removeQueries({ queryKey: ['verify-email'] });
            router.replace('/');
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Accept invitation
      </Button>
    </div>
  );
}
