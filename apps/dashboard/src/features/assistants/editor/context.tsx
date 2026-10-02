'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { Field, InlineField } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { FieldErrors } from '@/lib/forms';
import { getIn, numberValue, textValue } from '@/lib/object-path';
import type { AssistantSpec } from '@/lib/schemas/assistant';

export interface EditorState {
  draft: AssistantSpec;
  /** Set a config path; undefined removes it (back to the default). */
  update: (path: string, value: unknown) => void;
  errors: FieldErrors;
  readOnly: boolean;
}

const EditorContext = createContext<EditorState | null>(null);

export function EditorProvider({ value, children }: { value: EditorState; children: ReactNode }) {
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorState {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside EditorProvider');
  return value;
}

interface BoundProps {
  path: string;
  label: ReactNode;
  description?: ReactNode;
  placeholder?: string;
  className?: string;
}

export function SpecText({ path, label, description, placeholder, className, maxLength, type = 'text', list }: BoundProps & { maxLength?: number; type?: 'text' | 'url'; list?: string }) {
  const { draft, update, errors, readOnly } = useEditor();
  const value = (getIn(draft, path) as string | undefined) ?? '';
  return (
    <Field label={label} description={description} error={errors[path]} className={className}>
      {(props) => <Input {...props} type={type} list={list} value={value} placeholder={placeholder} maxLength={maxLength} readOnly={readOnly} onChange={(e) => update(path, textValue(e.target.value))} />}
    </Field>
  );
}

export function SpecTextarea({ path, label, description, placeholder, className, maxLength, rows = 4 }: BoundProps & { maxLength: number; rows?: number }) {
  const { draft, update, errors, readOnly } = useEditor();
  const value = (getIn(draft, path) as string | undefined) ?? '';
  return (
    <Field
      label={label}
      description={
        <span className="flex flex-wrap justify-between gap-2">
          <span>{description}</span>
          <span className="tabular-nums" aria-label={`${value.length} of ${maxLength} characters`}>
            {value.length.toLocaleString()} / {maxLength.toLocaleString()}
          </span>
        </span>
      }
      error={errors[path]}
      className={className}
    >
      {(props) => <Textarea {...props} rows={rows} value={value} placeholder={placeholder} maxLength={maxLength} readOnly={readOnly} onChange={(e) => update(path, textValue(e.target.value))} />}
    </Field>
  );
}

export function SpecNumber({ path, label, description, placeholder, className, min, max, step = 1, unit }: BoundProps & { min?: number; max?: number; step?: number; unit?: string }) {
  const { draft, update, errors, readOnly } = useEditor();
  const value = getIn(draft, path) as number | undefined;
  return (
    <Field label={unit ? `${label} (${unit})` : label} description={description ?? (min !== undefined && max !== undefined ? `${min}–${max}` : undefined)} error={errors[path]} className={className}>
      {(props) => (
        <Input
          {...props}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value ?? ''}
          placeholder={placeholder ?? 'Default'}
          readOnly={readOnly}
          onChange={(e) => update(path, numberValue(e.target.value))}
        />
      )}
    </Field>
  );
}

export function SpecSwitch({ path, label, description, defaultValue = false }: BoundProps & { defaultValue?: boolean }) {
  const { draft, update, readOnly } = useEditor();
  const value = (getIn(draft, path) as boolean | undefined) ?? defaultValue;
  return (
    <InlineField label={label} description={description}>
      {(props) => <Switch {...props} checked={value} disabled={readOnly} onCheckedChange={(checked) => update(path, checked)} />}
    </InlineField>
  );
}

export function SpecSelect({ path, label, description, options, defaultLabel, className }: BoundProps & { options: { value: string; label: string }[]; defaultLabel?: string }) {
  const { draft, update, errors, readOnly } = useEditor();
  const value = (getIn(draft, path) as string | undefined) ?? '';
  return (
    <Field label={label} description={description} error={errors[path]} className={className}>
      {(props) => (
        <Select {...props} value={value} disabled={readOnly} onChange={(e) => update(path, textValue(e.target.value))}>
          {defaultLabel !== undefined ? <option value="">{defaultLabel}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
