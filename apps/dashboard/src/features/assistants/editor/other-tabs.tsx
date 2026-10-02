'use client';

import { BookOpen, Braces, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Checkbox, Textarea } from '@/components/ui/input';
import { StringListInput } from '@/components/ui/list-inputs';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useStructuredOutputOptions, useToolOptions } from '@/features/shared/lookups';
import { RUBRICS } from '@/lib/schemas/assistant';
import { SpecNumber, SpecSelect, SpecSwitch, SpecText, SpecTextarea, useEditor } from './context';

/** Checkbox list that edits an id array in the draft. */
function IdChecklist({ path, items, legend }: { path: 'toolIds' | 'analysis.structuredOutputIds'; items: { id: string; name: string; detail?: string }[]; legend: string }) {
  const { draft, update, errors, readOnly } = useEditor();
  const selected = (path === 'toolIds' ? draft.toolIds : draft.analysis?.structuredOutputIds) ?? [];
  return (
    <fieldset>
      <legend className="sr-only">{legend}</legend>
      {errors[path] ? (
        <p role="alert" className="mb-2 text-sm font-medium text-danger">
          {errors[path]}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {items.map((item) => {
          const checked = selected.includes(item.id);
          const id = `${path}-${item.id}`;
          return (
            <li key={item.id} className="flex items-start gap-3 px-3 py-2.5">
              <Checkbox
                id={id}
                checked={checked}
                disabled={readOnly}
                className="mt-0.5"
                onChange={(e) => {
                  const next = e.target.checked ? [...selected, item.id] : selected.filter((x) => x !== item.id);
                  update(path, next.length ? next : undefined);
                }}
              />
              <label htmlFor={id} className="flex flex-col">
                <span className="text-sm font-medium text-text">{item.name}</span>
                {item.detail ? <span className="text-xs text-muted">{item.detail}</span> : null}
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

export function ToolsTab() {
  const tools = useToolOptions();
  const { draft } = useEditor();
  const unknown = (draft.toolIds ?? []).filter((id) => tools.data && !tools.data.data.some((t) => t.id === id));
  return (
    <Card>
      <CardHeader
        title="Tools"
        description="Functions the assistant may call during a conversation (your endpoints, or built-ins such as ending the call)."
        actions={
          <LinkButton href="/tools/new" size="sm">
            New tool
          </LinkButton>
        }
      />
      <CardBody>
        {tools.isPending ? (
          <LoadingState label="Loading tools…" rows={2} />
        ) : tools.isError ? (
          <ErrorState error={tools.error} title="Could not load tools" onRetry={() => void tools.refetch()} />
        ) : tools.data.data.length === 0 ? (
          <EmptyState icon={<Wrench />} title="No tools yet" description="Create a tool, then attach it here." />
        ) : (
          <IdChecklist path="toolIds" legend="Tools this assistant can use" items={tools.data.data.map((t) => ({ id: t.id, name: t.name, detail: `${t.type} · ${t.description}` }))} />
        )}
        {unknown.length ? <p className="mt-2 text-sm text-warning">{unknown.length} attached tool(s) no longer exist; save to remove them.</p> : null}
      </CardBody>
    </Card>
  );
}

export function KnowledgeTab() {
  return (
    <EmptyState
      icon={<BookOpen />}
      title="Knowledge bases are not available yet"
      description="Uploading documents for the assistant to search during calls arrives with the knowledge base API. Until then, put essential facts in the system prompt."
      action={<LinkButton href="/knowledge-base">About knowledge bases</LinkButton>}
    />
  );
}

export function AnalysisTab() {
  const { draft, update, errors, readOnly } = useEditor();
  const outputs = useStructuredOutputOptions();
  const success = draft.analysis?.successEvaluation;
  const inline = draft.analysis?.structuredData;
  const [schemaText, setSchemaText] = useState(inline?.schema ? JSON.stringify(inline.schema, null, 2) : '');
  const [schemaError, setSchemaError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Summary" description="A short summary of every call, written after it ends." />
        <CardBody className="flex flex-col gap-4">
          <SpecSwitch path="analysis.summary.enabled" label="Summarise calls" />
          {draft.analysis?.summary?.enabled ? <SpecTextarea path="analysis.summary.prompt" label="Instructions" description="Optional: what the summary should cover." maxLength={5000} rows={3} /> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Success evaluation" description="A verdict on each call, for filters, boards and alerts." />
        <CardBody className="flex flex-col gap-4">
          <SpecSwitch path="analysis.successEvaluation.enabled" label="Evaluate calls" />
          {success?.enabled ? (
            <>
              <SpecSelect
                path="analysis.successEvaluation.rubric"
                label="Rubric"
                defaultLabel="Pass or fail (default)"
                options={RUBRICS.filter((r) => r !== 'pass-fail').map((r) => ({ value: r, label: { 'numeric-scale': 'Score from 1 to 10', descriptive: 'A short written verdict', categories: 'One of your categories', 'pass-fail': 'Pass or fail' }[r] }))}
              />
              {success.rubric === 'categories' ? (
                <Field label="Categories" description="2 to 20, one per line." error={errors['analysis.successEvaluation.categories']}>
                  {(props) => <StringListInput {...props} value={success.categories} onChange={(v) => update('analysis.successEvaluation.categories', v)} placeholder={'resolved\nescalated\nabandoned'} />}
                </Field>
              ) : null}
              <SpecTextarea path="analysis.successEvaluation.prompt" label="Question" description="What counts as success, e.g. “Did the caller get an appointment?”" maxLength={5000} rows={2} />
            </>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Structured outputs"
          description="Values extracted from every call and validated against a schema, e.g. “appointment booked: true”."
          actions={
            <LinkButton href="/structured-outputs" size="sm">
              Manage outputs
            </LinkButton>
          }
        />
        <CardBody className="flex flex-col gap-4">
          {outputs.isPending ? (
            <LoadingState label="Loading structured outputs…" rows={2} />
          ) : outputs.isError ? (
            <ErrorState error={outputs.error} title="Could not load structured outputs" onRetry={() => void outputs.refetch()} />
          ) : outputs.data.data.length === 0 ? (
            <EmptyState icon={<Braces />} title="No structured outputs yet" description="Define one (a JSON Schema) and attach it here." />
          ) : (
            <IdChecklist path="analysis.structuredOutputIds" legend="Structured outputs to extract" items={outputs.data.data.map((o) => ({ id: o.id, name: o.name, detail: o.description || undefined }))} />
          )}
          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-text">
              Inline schema <Badge>Older option</Badge>
            </summary>
            <div className="mt-3 flex flex-col gap-4">
              <p className="text-xs text-muted">One schema kept on this assistant only. Reusable structured outputs above are preferred.</p>
              <SpecSwitch path="analysis.structuredData.enabled" label="Extract with the inline schema" />
              <Field label="JSON Schema" description='An object schema, e.g. {"type": "object", "properties": {"booked": {"type": "boolean"}}}' error={schemaError ?? errors['analysis.structuredData.schema']}>
                {(props) => (
                  <Textarea
                    {...props}
                    rows={6}
                    className="font-mono text-xs"
                    value={schemaText}
                    readOnly={readOnly}
                    onChange={(e) => {
                      setSchemaText(e.target.value);
                      if (!e.target.value.trim()) {
                        setSchemaError(null);
                        update('analysis.structuredData.schema', undefined);
                        return;
                      }
                      try {
                        const parsed = JSON.parse(e.target.value);
                        setSchemaError(null);
                        update('analysis.structuredData.schema', parsed);
                      } catch {
                        setSchemaError('Not valid JSON yet');
                      }
                    }}
                  />
                )}
              </Field>
              <SpecTextarea path="analysis.structuredData.prompt" label="Instructions" maxLength={5000} rows={2} />
            </div>
          </details>
        </CardBody>
      </Card>
    </div>
  );
}

export function AdvancedTab() {
  const { draft, update, errors } = useEditor();
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Turn-taking" description="When the caller has finished speaking, and when they may interrupt." />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <SpecNumber path="endpointing.silenceMs" label="Silence that ends a turn" unit="ms" min={100} max={5000} step={50} description="Shorter answers faster but may cut callers off. 100–5000; the preset decides when empty." />
          <SpecNumber path="endpointing.minSpeechMs" label="Shortest speech that counts" unit="ms" min={20} max={2000} />
          <SpecNumber path="endpointing.sttFinalTimeoutMs" label="Wait for the final transcript" unit="ms" min={100} max={10000} />
          <SpecNumber path="endpointing.vadMarginDb" label="Speech above noise" unit="dB" min={3} max={40} step={0.5} />
          <SpecNumber path="endpointing.vadMinSpeechDb" label="Quietest speech" unit="dB" min={-90} max={-10} step={0.5} />
          <div className="md:col-span-2">
            <SpecSwitch path="interruption.enabled" label="Let callers interrupt the assistant" defaultValue />
          </div>
          <SpecNumber path="interruption.minSpeechMs" label="Speech needed to interrupt" unit="ms" min={20} max={2000} />
          <SpecNumber path="interruption.echoGuardDb" label="Echo guard" unit="dB" min={0} max={40} step={0.5} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Silence and limits" />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <SpecNumber path="idle.timeoutSeconds" label="Remind after silence" unit="s" min={0} max={600} description="0 turns reminders off." />
          <SpecNumber path="idle.maxPrompts" label="Reminders before ending" min={0} max={10} />
          <SpecText path="idle.message" label="Reminder" placeholder="Are you still there?" maxLength={1000} />
          <SpecText path="idle.endMessage" label="Goodbye after silence" maxLength={1000} />
          <SpecNumber path="maxDurationSeconds" label="Longest call" unit="s" min={10} max={7200} />
          <SpecText path="maxDurationMessage" label="Said when the time is up" maxLength={1000} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Messages and behaviour" />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label="End-call phrases" description="When the assistant says one of these, the call ends. One per line, up to 20." error={errors.endCallPhrases} className="md:col-span-2">
            {(props) => <StringListInput {...props} value={draft.endCallPhrases} onChange={(v) => update('endCallPhrases', v)} rows={3} />}
          </Field>
          <SpecText path="fallbackMessage" label="If providers fail" description="Said before ending when the model or voice is unavailable." maxLength={1000} />
          <SpecText path="voicemailMessage" label="Voicemail message" maxLength={1000} />
          <SpecSelect path="backgroundSound" label="Background sound" defaultLabel="Off (default)" options={[{ value: 'office', label: 'Office' }]} />
          <SpecText path="serverUrl" type="url" label="Webhook URL" description="Events for this assistant's calls (https)." placeholder="https://example.com/octo" />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Debugging" />
        <CardBody>
          <SpecSwitch path="debug.captureLlm" label="Keep full model prompts and replies" description="Stored for the debug view for a limited time. They contain what callers said: leave off unless you are investigating." />
        </CardBody>
      </Card>
      <p className="text-sm text-muted">Settings left empty use the defaults of the preset and the platform.</p>
    </div>
  );
}
