'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ControlProps } from './field';
import { Button } from './button';
import { Input, Textarea } from './input';

/** A list of short strings, one per line (phrases, categories, key terms). */
export function StringListInput({ value, onChange, rows = 4, placeholder, ...control }: ControlProps & { value: string[] | undefined; onChange: (value: string[] | undefined) => void; rows?: number; placeholder?: string }) {
  // Local text so a trailing newline (the start of the next item) is kept while typing
  const [text, setText] = useState((value ?? []).join('\n'));
  return (
    <Textarea
      {...control}
      rows={rows}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const items = e.target.value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        onChange(items.length ? items : undefined);
      }}
    />
  );
}

/**
 * Key/value pairs (variable defaults, headers). Each row has labelled inputs; rows are added and
 * removed with buttons.
 */
export function KeyValueEditor({
  value,
  onChange,
  keyLabel = 'Name',
  valueLabel = 'Value',
  addLabel = 'Add',
  errors = {},
  idPrefix,
}: {
  value: Record<string, string> | undefined;
  onChange: (value: Record<string, string> | undefined) => void;
  keyLabel?: string;
  valueLabel?: string;
  addLabel?: string;
  /** Messages by key. */
  errors?: Record<string, string>;
  idPrefix: string;
}) {
  // Rows keep their order and allow a blank key while it is being typed
  const [rows, setRows] = useState<{ key: string; value: string }[]>(() => Object.entries(value ?? {}).map(([k, v]) => ({ key: k, value: v })));
  const commit = (next: { key: string; value: string }[]) => {
    setRows(next);
    const entries = next.filter((row) => row.key.trim() !== '').map((row) => [row.key.trim(), row.value] as const);
    onChange(entries.length ? Object.fromEntries(entries) : undefined);
  };
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => {
        const error = errors[row.key.trim()];
        return (
          <div key={index} className="flex flex-col gap-1">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <label htmlFor={`${idPrefix}-key-${index}`} className="sr-only">
                  {keyLabel} {index + 1}
                </label>
                <Input id={`${idPrefix}-key-${index}`} placeholder={keyLabel} value={row.key} aria-invalid={error ? true : undefined} aria-describedby={error ? `${idPrefix}-err-${index}` : undefined} onChange={(e) => commit(rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))} />
              </div>
              <div className="flex-[2]">
                <label htmlFor={`${idPrefix}-value-${index}`} className="sr-only">
                  {valueLabel} {index + 1}
                </label>
                <Input id={`${idPrefix}-value-${index}`} placeholder={valueLabel} value={row.value} onChange={(e) => commit(rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))} />
              </div>
              <Button variant="ghost" size="sm" className="w-9 px-0" aria-label={`Remove ${row.key || `row ${index + 1}`}`} onClick={() => commit(rows.filter((_, i) => i !== index))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            {error ? (
              <p id={`${idPrefix}-err-${index}`} className="text-xs font-medium text-danger">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
      <Button size="sm" className="self-start" onClick={() => commit([...rows, { key: '', value: '' }])}>
        <Plus aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  );
}
