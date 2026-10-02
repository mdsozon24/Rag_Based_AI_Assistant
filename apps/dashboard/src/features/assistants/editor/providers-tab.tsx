'use client';

import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, InlineField } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { KeyValueEditor, StringListInput } from '@/components/ui/list-inputs';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Switch } from '@/components/ui/switch';
import type { ComponentKind, FieldDescriptor, ProviderCatalog, ProviderDescriptor } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { errorsUnder } from '@/lib/forms';
import { getIn, numberValue, textValue } from '@/lib/object-path';
import { useCredentialOptions } from '@/features/shared/lookups';
import { useProviderCatalog } from '../api';
import { useEditor } from './context';

const KIND_LABEL: Record<ComponentKind, { title: string; description: string }> = {
  transcriber: { title: 'Transcriber (speech to text)', description: 'Turns the caller’s speech into text.' },
  model: { title: 'Model (LLM)', description: 'Decides what to say and which tools to use.' },
  voice: { title: 'Voice (text to speech)', description: 'Speaks the replies.' },
};

const FIELD_HELP: Record<string, string> = {
  voiceId: 'The vendor’s voice id.',
  language: 'Overrides the assistant language for this component.',
  keyterms: 'Words to recognise reliably (names, products), one per line.',
  temperature: 'Lower is more predictable.',
  maxTokens: 'Longest reply, in tokens.',
  credentialId: 'An organization provider key used to call your endpoint.',
  headers: 'Extra HTTP headers sent to your endpoint.',
  url: 'Your endpoint (https or wss).',
};

const label = (name: string) => name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

export function ProvidersTab() {
  const catalog = useProviderCatalog();
  if (catalog.isPending) return <LoadingState label="Loading providers…" />;
  if (catalog.isError) return <ErrorState error={catalog.error} title="Could not load the provider catalog" onRetry={() => void catalog.refetch()} />;
  return (
    <div className="flex flex-col gap-5">
      <PresetPicker catalog={catalog.data} />
      {(['transcriber', 'model', 'voice'] as const).map((kind) => (
        <ComponentPicker key={kind} kind={kind} catalog={catalog.data} />
      ))}
    </div>
  );
}

function PresetPicker({ catalog }: { catalog: ProviderCatalog }) {
  const { draft, update, readOnly } = useEditor();
  const current = draft.preset ?? 'balanced';
  return (
    <Card>
      <CardHeader title="Preset" description="A tested combination of transcriber, model and voice. Anything you set below overrides it." />
      <CardBody>
        <fieldset>
          <legend className="sr-only">Provider preset</legend>
          <div className="grid gap-3 md:grid-cols-3">
            {catalog.presets.map((preset) => {
              const checked = current === preset.name;
              return (
                <label key={preset.name} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus', checked ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-control')}>
                  <input type="radio" name="preset" value={preset.name} checked={checked} disabled={readOnly} onChange={() => update('preset', preset.name)} className="mt-1 size-4 accent-[var(--accent)]" />
                  <span className="flex flex-col gap-1">
                    <span className="flex items-center gap-2 text-sm font-semibold text-text capitalize">
                      {preset.name}
                      {preset.default ? <Badge>Default</Badge> : null}
                    </span>
                    <span className="text-xs text-muted">{preset.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </CardBody>
    </Card>
  );
}

function ComponentPicker({ kind, catalog }: { kind: ComponentKind; catalog: ProviderCatalog }) {
  const { draft, update, errors, readOnly } = useEditor();
  const credentials = useCredentialOptions();
  const preset = catalog.presets.find((p) => p.name === (draft.preset ?? 'balanced')) ?? catalog.presets[0];
  const presetComponent = preset[kind];
  const current = (draft[kind] ?? {}) as Record<string, unknown>;
  const explicit = typeof current.provider === 'string' ? current.provider : undefined;
  const effective = explicit ?? presetComponent.provider;
  const providers = catalog.components[kind].providers;
  const descriptor = providers.find((p) => p.id === effective);
  // Fallbacks: the component's own, or the preset's unless the provider differs from the preset (mergeComponent)
  const fallbacks = (Array.isArray(current.fallbacks) ? current.fallbacks : explicit && explicit !== presetComponent.provider ? [] : (presetComponent.fallbacks ?? [])) as { provider: string; model?: string }[];
  const modelPlaceholder = explicit && explicit !== presetComponent.provider ? descriptor?.defaultModel : (presetComponent.model ?? descriptor?.defaultModel);
  const listId = `${kind}-models`;
  const vendor = descriptor?.credentialVendor;
  const ownKey = credentials.data?.data.some((c) => c.provider === vendor);

  return (
    <Card>
      <CardHeader title={KIND_LABEL[kind].title} description={KIND_LABEL[kind].description} />
      <CardBody className="flex flex-col gap-4">
        {errors[kind] ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {errors[kind]}
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Provider" description={explicit ? descriptor?.description : `From the ${preset.name} preset.`}>
            {(props) => (
              <Select
                {...props}
                value={explicit ?? ''}
                disabled={readOnly}
                onChange={(e) => {
                  const next = e.target.value;
                  // Another provider's fields would not fit: changing the provider starts the component afresh
                  if (!next) update(kind, undefined);
                  else if (next !== explicit) update(kind, { provider: next });
                }}
              >
                <option value="">
                  Preset: {presetComponent.provider}
                  {presetComponent.model ? ` (${presetComponent.model})` : ''}
                </option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} — {p.description}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Model" description="Leave empty for the default shown." error={errors[`${kind}.model`]}>
            {(props) => <Input {...props} list={listId} value={(current.model as string | undefined) ?? ''} placeholder={modelPlaceholder} readOnly={readOnly} onChange={(e) => update(`${kind}.model`, textValue(e.target.value))} />}
          </Field>
          <datalist id={listId}>
            {descriptor?.suggestedModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>

        {descriptor ? (
          <div className="grid gap-4 md:grid-cols-2">
            {descriptor.fields
              .filter((f) => f.name !== 'model')
              .map((field) => (
                <ProviderField key={field.name} kind={kind} field={field} provider={descriptor} />
              ))}
          </div>
        ) : null}

        {vendor && credentials.data ? (
          <p className="flex items-start gap-2 text-xs text-muted">
            <KeyRound aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {vendor === 'custom' ? (
              'Your own endpoint: it is called with the provider key you pick above, if any.'
            ) : ownKey ? (
              <span>Calls use your organization’s {vendor} key (billed to your {vendor} account).</span>
            ) : (
              <span>
                No {vendor} key of your own: calls use the platform’s key, if the platform has one.{' '}
                <Link href="/settings/provider-keys" className="font-medium text-accent-text underline-offset-4 hover:underline">
                  Add a provider key
                </Link>
              </span>
            )}
          </p>
        ) : null}

        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-text">Reliability: retries, timeouts and fallbacks</summary>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            {catalog.components[kind].policy
              .filter((f) => f.type === 'integer' || f.type === 'number')
              .map((field) => (
                <ProviderField key={field.name} kind={kind} field={field} />
              ))}
          </div>
          <div className="mt-3">
            <h4 className="text-sm font-medium text-text">Fallbacks, in order</h4>
            {fallbacks.length ? (
              <ol className="mt-1 list-inside list-decimal text-sm text-muted">
                {fallbacks.map((f, i) => (
                  <li key={i}>
                    {f.provider}
                    {f.model ? ` (${f.model})` : ''}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1 text-sm text-muted">None: if the provider fails, the assistant says its fallback message.</p>
            )}
            <p className="mt-1 text-xs text-muted">Fallbacks follow the preset. A custom fallback list can be set through the API (`{kind}.fallbacks`).</p>
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

/** One provider or policy field, rendered from its catalog descriptor. */
function ProviderField({ kind, field, provider }: { kind: ComponentKind; field: FieldDescriptor; provider?: ProviderDescriptor }) {
  const { draft, update, errors, readOnly } = useEditor();
  const credentials = useCredentialOptions();
  const path = `${kind}.${field.name}`;
  const value = getIn(draft, path);
  const range = field.min !== undefined || field.max !== undefined ? `${field.exclusiveMin ? 'More than ' : ''}${field.min ?? ''}${field.min !== undefined && field.max !== undefined ? '–' : ''}${field.max ?? ''}` : '';
  const description = [FIELD_HELP[field.name], field.type === 'number' || field.type === 'integer' ? range : '', field.default !== undefined ? `Default ${String(field.default)}.` : ''].filter(Boolean).join(' ');
  const error = errors[path];

  if (field.type === 'boolean') {
    return (
      <InlineField label={label(field.name)} description={description || undefined}>
        {(props) => <Switch {...props} checked={value === true} disabled={readOnly} onCheckedChange={(checked) => update(path, checked)} />}
      </InlineField>
    );
  }
  if (field.type === 'string-list') {
    return (
      <Field label={label(field.name)} description={description || 'One per line.'} error={error}>
        {(props) => <StringListInput {...props} value={value as string[] | undefined} onChange={(v) => update(path, v)} />}
      </Field>
    );
  }
  if (field.type === 'map') {
    return (
      <div className="md:col-span-2">
        <p className="mb-1 text-sm font-medium text-text">{label(field.name)}</p>
        {description ? <p className="mb-2 text-xs text-muted">{description}</p> : null}
        <KeyValueEditor idPrefix={path.replace(/\./g, '-')} value={value as Record<string, string> | undefined} onChange={(v) => update(path, v)} keyLabel="Header" valueLabel="Value" addLabel="Add header" errors={errorsUnder(errors, path)} />
      </div>
    );
  }
  if (field.type === 'enum') {
    return (
      <Field label={label(field.name)} description={description || undefined} error={error}>
        {(props) => (
          <Select {...props} value={value === undefined ? '' : String(value)} disabled={readOnly} onChange={(e) => update(path, e.target.value === '' ? undefined : typeof field.values?.[0] === 'number' ? Number(e.target.value) : e.target.value)}>
            <option value="">Default</option>
            {field.values?.map((v) => (
              <option key={String(v)} value={String(v)}>
                {String(v)}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  if (field.name === 'credentialId' && provider?.id === 'custom' && credentials.data) {
    const options = credentials.data.data.filter((c) => c.provider === 'custom');
    return (
      <Field label="Provider key" description={description} error={error}>
        {(props) => (
          <Select {...props} value={(value as string | undefined) ?? ''} disabled={readOnly} onChange={(e) => update(path, textValue(e.target.value))}>
            <option value="">None</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.masked})
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    const step = field.type === 'integer' ? 1 : field.max !== undefined && field.max <= 2 ? 0.05 : 0.1;
    return (
      <Field label={label(field.name)} description={description || undefined} error={error}>
        {(props) => <Input {...props} type="number" inputMode="decimal" min={field.min} max={field.max} step={step} value={value === undefined ? '' : String(value)} placeholder={field.default !== undefined ? String(field.default) : 'Default'} readOnly={readOnly} onChange={(e) => update(path, numberValue(e.target.value))} />}
      </Field>
    );
  }
  return (
    <Field label={label(field.name)} description={description || undefined} error={error} required={field.required}>
      {(props) => <Input {...props} type={field.format === 'url' ? 'url' : 'text'} value={(value as string | undefined) ?? ''} maxLength={field.max} readOnly={readOnly} onChange={(e) => update(path, textValue(e.target.value))} />}
    </Field>
  );
}
