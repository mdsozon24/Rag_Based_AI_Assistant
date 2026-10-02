'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { post } from '@/lib/api/client';
import { apiErrorsFor, focusFirstError, validate, type FieldErrors } from '@/lib/forms';
import { safeNext } from '@/lib/navigation';
import { signupSchema } from '@/lib/schemas/auth';

export function SignupForm() {
  const params = useSearchParams();
  const next = safeNext(params.get('next'), '');
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ name: '', email: '', password: '', orgName: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const checked = validate(signupSchema, { ...values, orgName: values.orgName.trim() || undefined });
    if (!checked.ok) {
      setErrors(checked.errors);
      focusFirstError(formRef.current);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await post('/v1/auth/signup', checked.value);
      setSentTo(checked.value.email);
    } catch (error) {
      setErrors(apiErrorsFor(error));
      focusFirstError(formRef.current);
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div role="status" className="flex flex-col items-start gap-3">
        <MailCheck aria-hidden="true" className="size-8 text-accent" />
        <h1 className="text-xl font-semibold text-text">Check your email</h1>
        <p className="text-sm text-muted">
          We sent a confirmation link to <strong className="text-text">{sentTo}</strong>. Open it to finish creating your account. The link expires in 24 hours.
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={resent}
          onClick={async () => {
            await post('/v1/auth/resend-verification', { email: sentTo }).catch(() => undefined);
            setResent(true);
          }}
        >
          {resent ? 'Sent again' : 'Send the link again'}
        </Button>
        <Link href={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="text-sm font-medium text-accent-text underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold text-text">Create your account</h1>
      <p className="mt-1 text-sm text-muted">
        Already have one?{' '}
        <Link href={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-accent-text underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
      <form ref={formRef} onSubmit={submit} noValidate className="mt-6 flex flex-col gap-4">
        <FormError errors={errors} shown={['name', 'email', 'password', 'orgName']} />
        <Field label="Your name" error={errors.name} required>
          {(props) => <Input {...props} autoComplete="name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} />}
        </Field>
        <Field label="Work email" error={errors.email} required>
          {(props) => <Input {...props} type="email" autoComplete="email" value={values.email} onChange={(e) => setValues({ ...values, email: e.target.value })} />}
        </Field>
        <Field label="Password" description="At least 10 characters." error={errors.password} required>
          {(props) => <Input {...props} type="password" autoComplete="new-password" value={values.password} onChange={(e) => setValues({ ...values, password: e.target.value })} />}
        </Field>
        <Field label="Organization name" description="Optional. You can rename it later." error={errors.orgName}>
          {(props) => <Input {...props} autoComplete="organization" value={values.orgName} onChange={(e) => setValues({ ...values, orgName: e.target.value })} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          Create account
        </Button>
      </form>
    </>
  );
}
