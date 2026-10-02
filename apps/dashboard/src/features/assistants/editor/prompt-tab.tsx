'use client';

import { BUILT_IN_VARIABLES, isBuiltInVariable, variablesIn } from '@engine/assistant/variables.ts';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { KeyValueEditor } from '@/components/ui/list-inputs';
import { errorsUnder } from '@/lib/forms';
import { SpecText, SpecTextarea, useEditor } from './context';

const LANGUAGES = ['en', 'en-US', 'en-GB', 'bn', 'bn-BD', 'hi', 'ar', 'es', 'fr', 'de', 'pt', 'id', 'ur'];

export function PromptTab() {
  const { draft, update, errors, readOnly } = useEditor();
  const mode = draft.firstMessageMode ?? 'assistant-speaks-first';
  const used = [...new Set([...variablesIn(draft.systemPrompt), ...variablesIn(draft.firstMessage)])];
  const defaults = draft.variableDefaults ?? {};
  const needed = used.filter((name) => !isBuiltInVariable(name) && !Object.hasOwn(defaults, name));

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Instructions" description="How the assistant behaves. Use {{variable}} for values each call fills in." />
        <CardBody className="flex flex-col gap-5">
          <SpecTextarea path="systemPrompt" label="System prompt" maxLength={30_000} rows={12} placeholder="You are a friendly receptionist for {{business_name}}…" />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-text">Who speaks first</legend>
            {(
              [
                ['assistant-speaks-first', 'The assistant greets the caller'],
                ['assistant-waits-for-user', 'The assistant waits for the caller'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm text-text">
                <input type="radio" name="firstMessageMode" value={value} checked={mode === value} disabled={readOnly} onChange={() => update('firstMessageMode', value)} className="size-4 accent-[var(--accent)]" />
                {label}
              </label>
            ))}
          </fieldset>
          <SpecTextarea path="firstMessage" label="First message" description={mode === 'assistant-speaks-first' ? 'Spoken as soon as the call connects.' : 'Used only if the assistant speaks first.'} maxLength={2000} rows={3} />
          <div className="grid gap-4 sm:grid-cols-2">
            <SpecText path="language" label="Language" description="A language code such as en, bn or en-US. Providers use it for speech." placeholder="en" list="language-options" />
            <datalist id="language-options">
              {LANGUAGES.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Variables" description="Placeholders in the prompt and first message are filled per call. A default is used when the call gives none." />
        <CardBody className="flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-medium text-text">Used in this assistant</h3>
            {used.length ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {used.map((name) => (
                  <li key={name}>
                    <Badge tone={isBuiltInVariable(name) ? 'info' : needed.includes(name) ? 'warning' : 'success'}>
                      {`{{${name}}}`} · {isBuiltInVariable(name) ? 'built in' : needed.includes(name) ? 'each call must give it' : 'has a default'}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">None yet.</p>
            )}
          </div>
          <div>
            <h3 className="text-sm font-medium text-text">Defaults</h3>
            <p className="mb-2 text-xs text-muted">Built in, always available: {Object.keys(BUILT_IN_VARIABLES).map((n) => `{{${n}}}`).join(', ')}.</p>
            {readOnly ? (
              <pre className="rounded-md bg-surface-2 p-3 text-xs">{JSON.stringify(defaults, null, 2)}</pre>
            ) : (
              <KeyValueEditor idPrefix="variable-defaults" value={draft.variableDefaults} onChange={(value) => update('variableDefaults', value)} keyLabel="Variable" valueLabel="Default value" addLabel="Add default" errors={errorsUnder(errors, 'variableDefaults')} />
            )}
            {errors.variableDefaults ? <p className="mt-1 text-xs font-medium text-danger">{errors.variableDefaults}</p> : null}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
