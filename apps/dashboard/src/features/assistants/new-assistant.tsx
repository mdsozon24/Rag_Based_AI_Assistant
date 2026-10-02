'use client';

import { FileText, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Button, LinkButton } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { PageBody, PageHeader } from '@/components/ui/page';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { apiErrorsFor, focusFirstError, validate, type FieldErrors } from '@/lib/forms';
import { assistantName } from '@/lib/schemas/assistant';
import { useCreateAssistant, useTemplates } from './api';

const BLANK = 'blank';

export function NewAssistant() {
  const router = useRouter();
  const templates = useTemplates();
  const create = useCreateAssistant();
  const formRef = useRef<HTMLFormElement>(null);
  const [choice, setChoice] = useState<string>(BLANK);
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const template = templates.data?.data.find((t) => t.id === choice);

  async function submit(event: FormEvent) {
    event.preventDefault();
    // A template brings its own name; a blank assistant needs one
    const checked = name.trim() || choice === BLANK ? validate(assistantName, name) : ({ ok: true, value: undefined } as const);
    if (!checked.ok) {
      setErrors({ name: Object.values(checked.errors)[0] });
      focusFirstError(formRef.current);
      return;
    }
    setErrors({});
    try {
      const assistant = await create.mutateAsync({ ...(checked.value ? { name: checked.value } : {}), ...(choice !== BLANK ? { templateId: choice } : {}) });
      router.push(`/assistants/${assistant.id}`);
    } catch (error) {
      setErrors(apiErrorsFor(error));
      focusFirstError(formRef.current);
    }
  }

  const options = [{ id: BLANK, name: 'Blank assistant', description: 'Start from scratch with the balanced provider preset.' }, ...(templates.data?.data ?? [])];

  return (
    <PageBody>
      <PageHeader
        breadcrumb={
          <Link href="/assistants" className="underline-offset-4 hover:underline">
            Assistants
          </Link>
        }
        title="New assistant"
        description="Pick a starting point. Everything can be changed in the editor before you publish."
      />
      <form ref={formRef} onSubmit={submit} noValidate className="flex max-w-3xl flex-col gap-6">
        <FormError errors={errors} shown={['name']} />
        <fieldset>
          <legend className="mb-3 text-base font-semibold text-text">Starting point</legend>
          {templates.isPending ? (
            <LoadingState label="Loading templates…" rows={2} />
          ) : templates.isError ? (
            <ErrorState error={templates.error} title="Could not load templates" onRetry={() => void templates.refetch()} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {options.map((option) => {
                const checked = choice === option.id;
                return (
                  <label
                    key={option.id}
                    className={cn('flex cursor-pointer gap-3 rounded-lg border bg-surface p-4 shadow-card has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus', checked ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-control')}
                  >
                    <input type="radio" name="template" value={option.id} checked={checked} onChange={() => setChoice(option.id)} className="mt-1 size-4 accent-[var(--accent)]" />
                    <span className="flex flex-col gap-1">
                      <span className="flex items-center gap-2 text-sm font-semibold text-text">
                        {option.id === BLANK ? <FileText aria-hidden="true" className="size-4 text-muted" /> : <Sparkles aria-hidden="true" className="size-4 text-accent" />}
                        {option.name}
                      </span>
                      <span className="text-sm text-muted">{option.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
        <Field label="Name" description={template ? `Leave empty to use “${template.name}”.` : undefined} error={errors.name} required={choice === BLANK}>
          {(props) => <Input {...props} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create assistant
          </Button>
          <LinkButton href="/assistants">Cancel</LinkButton>
        </div>
      </form>
    </PageBody>
  );
}
