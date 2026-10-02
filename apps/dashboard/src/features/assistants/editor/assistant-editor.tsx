'use client';

import { Headphones, MoreHorizontal, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Menu, MenuItem } from '@/components/ui/menu';
import { PageBody, PageHeader } from '@/components/ui/page';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import type { Assistant } from '@/lib/api/types';
import { apiErrorsFor, focusFirstError, validate, zodToErrors, type FieldErrors } from '@/lib/forms';
import { createMergePatch, deepEqual } from '@/lib/merge-patch';
import { setIn } from '@/lib/object-path';
import { assistantName, assistantSpecSchema, type AssistantSpec } from '@/lib/schemas/assistant';
import { useSession } from '@/lib/session';
import { publicationState, useAssistant, useAssistantMutations } from '../api';
import { PublishDialog } from '../publish-dialog';
import { TalkPanel } from '../talk-panel';
import { EditorProvider } from './context';
import { AdvancedTab, AnalysisTab, KnowledgeTab, ToolsTab } from './other-tabs';
import { PromptTab } from './prompt-tab';
import { ProvidersTab } from './providers-tab';
import { VersionsTab } from './versions-tab';

/** Which tab shows a config field (for error markers and jumping to the first error). */
export const TAB_FIELDS: Record<string, string[]> = {
  prompt: ['name', 'firstMessage', 'firstMessageMode', 'systemPrompt', 'language', 'variableDefaults'],
  providers: ['preset', 'transcriber', 'model', 'voice'],
  tools: ['toolIds'],
  knowledge: ['knowledgeBaseIds'],
  analysis: ['analysis'],
  advanced: ['endpointing', 'interruption', 'idle', 'maxDurationSeconds', 'maxDurationMessage', 'endCallPhrases', 'fallbackMessage', 'voicemailMessage', 'backgroundSound', 'serverUrl', 'debug'],
};

export function tabOf(path: string): string | null {
  const top = path.split('.')[0];
  return Object.entries(TAB_FIELDS).find(([, fields]) => fields.includes(top))?.[0] ?? null;
}

export function AssistantEditor({ id }: { id: string }) {
  const query = useAssistant(id);
  if (query.isPending) {
    return (
      <PageBody>
        <LoadingState label="Loading assistant…" rows={5} />
      </PageBody>
    );
  }
  if (query.isError) {
    return (
      <PageBody>
        <ErrorState error={query.error} title="Could not load this assistant" onRetry={() => void query.refetch()} />
      </PageBody>
    );
  }
  return <LoadedEditor assistant={query.data} />;
}

export function LoadedEditor({ assistant }: { assistant: Assistant }) {
  const { can } = useSession();
  const router = useRouter();
  const toast = useToast();
  const { save, remove } = useAssistantMutations(assistant.id);
  const readOnly = !can('assistants:manage');
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<AssistantSpec>(assistant.config);
  const [name, setName] = useState(assistant.name);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [tab, setTab] = useState('prompt');
  const [talking, setTalking] = useState(false);

  const dirty = name !== assistant.name || !deepEqual(draft, assistant.config);

  // Leaving the page (reload, close tab) with unsaved edits asks first
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const editor = useMemo(
    () => ({
      draft,
      errors,
      readOnly,
      update: (path: string, value: unknown) => setDraft((current) => setIn(current, path, value)),
    }),
    [draft, errors, readOnly]
  );

  function showErrors(next: FieldErrors) {
    setErrors(next);
    const first = Object.keys(next).find((path) => path !== '_form');
    const target = first ? tabOf(first) : null;
    if (target) setTab(target);
    focusFirstError(rootRef.current);
  }

  /** Validate and save; true when saved (or nothing to save). */
  async function saveDraft(): Promise<boolean> {
    const checkedName = validate(assistantName, name);
    const checkedSpec = assistantSpecSchema.safeParse(draft);
    const problems: FieldErrors = { ...(checkedName.ok ? {} : { name: Object.values(checkedName.errors)[0] }), ...(checkedSpec.success ? {} : zodToErrors(checkedSpec.error)) };
    if (Object.keys(problems).length) {
      showErrors(problems);
      return false;
    }
    const patch = createMergePatch(assistant.config, draft);
    const body = { ...(name !== assistant.name ? { name: name.trim() } : {}), ...(patch ? { config: patch } : {}) };
    if (!Object.keys(body).length) return true;
    try {
      const saved = await save.mutateAsync(body);
      setDraft(saved.config);
      setName(saved.name);
      setErrors({});
      return true;
    } catch (error) {
      showErrors(apiErrorsFor(error, 'config.'));
      return false;
    }
  }

  const errorCount = (key: string) => Object.keys(errors).filter((path) => tabOf(path) === key).length;
  const marker = (key: string) => {
    const count = errorCount(key);
    return count ? (
      <Badge tone="danger">
        {count}
        <span className="sr-only"> {count === 1 ? 'error' : 'errors'}</span>
      </Badge>
    ) : null;
  };
  const state = publicationState(assistant);

  return (
    <EditorProvider value={editor}>
      <div ref={rootRef}>
        <PageBody className={dirty ? 'pb-28' : undefined}>
          <PageHeader
            breadcrumb={
              <Link href="/assistants" className="underline-offset-4 hover:underline">
                Assistants
              </Link>
            }
            title={assistant.name}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={state.tone}>{state.label}</Badge>
                {dirty ? <Badge tone="warning">Unsaved changes</Badge> : null}
                {readOnly ? <Badge>View only</Badge> : null}
              </span>
            }
            actions={
              <>
                <Button onClick={() => setTalking(true)} disabled={!can('calls:create')} title={!assistant.publishedVersion ? 'Publish a version to talk to it' : undefined}>
                  <Headphones aria-hidden="true" />
                  Talk to assistant
                </Button>
                {readOnly ? null : <PublishDialog assistant={assistant} dirty={dirty} saveFirst={saveDraft} />}
                {readOnly ? null : (
                  <Menu
                    label="More actions"
                    trigger={
                      <Button variant="ghost" size="md" className="w-10 px-0" aria-label="More actions">
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    }
                  >
                    <ConfirmDialog
                      trigger={
                        <MenuItem tone="danger" onSelect={(event) => event.preventDefault()}>
                          <Trash2 aria-hidden="true" />
                          Delete assistant
                        </MenuItem>
                      }
                      title={`Delete ${assistant.name}?`}
                      description="It disappears from lists and can no longer take calls. Past calls and their transcripts are kept."
                      confirmLabel="Delete assistant"
                      onConfirm={async () => {
                        try {
                          await remove.mutateAsync();
                          toast.success('Assistant deleted');
                          router.push('/assistants');
                        } catch (error) {
                          toast.error('Could not delete the assistant', error);
                          throw error;
                        }
                      }}
                    />
                  </Menu>
                )}
              </>
            }
          />

          <div className="mb-5">
            <FormError errors={errors} shown={Object.keys(errors).filter((path) => tabOf(path) !== null)} />
          </div>

          <Tabs
            label="Assistant settings"
            value={tab}
            onValueChange={setTab}
            items={[
              {
                value: 'prompt',
                label: 'Prompt',
                badge: marker('prompt'),
                content: (
                  <div className="flex flex-col gap-5">
                    <Card>
                      <CardBody>
                        <Field label="Name" error={errors.name} required>
                          {(props) => <Input {...props} value={name} maxLength={100} readOnly={readOnly} onChange={(e) => setName(e.target.value)} />}
                        </Field>
                      </CardBody>
                    </Card>
                    <PromptTab />
                  </div>
                ),
              },
              { value: 'providers', label: 'Models & voice', badge: marker('providers'), content: <ProvidersTab /> },
              { value: 'tools', label: 'Tools', badge: marker('tools'), content: <ToolsTab /> },
              { value: 'knowledge', label: 'Knowledge', content: <KnowledgeTab /> },
              { value: 'analysis', label: 'Analysis', badge: marker('analysis'), content: <AnalysisTab /> },
              { value: 'advanced', label: 'Advanced', badge: marker('advanced'), content: <AdvancedTab /> },
              {
                value: 'versions',
                label: 'Versions',
                content: (
                  <VersionsTab
                    assistant={assistant}
                    readOnly={readOnly}
                    onRestored={(restored) => {
                      setDraft(restored.config);
                      setName(restored.name);
                      setErrors({});
                    }}
                  />
                ),
              },
            ]}
          />
        </PageBody>

        {dirty && !readOnly ? (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur lg:left-64">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
              <p className="text-sm font-medium text-text">You have unsaved changes.</p>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setDraft(assistant.config);
                    setName(assistant.name);
                    setErrors({});
                  }}
                >
                  Discard
                </Button>
                <Button
                  variant="primary"
                  loading={save.isPending}
                  onClick={async () => {
                    if (await saveDraft()) toast.success('Draft saved', assistant.publishedVersion ? 'Publish to put it live.' : undefined);
                  }}
                >
                  Save draft
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <TalkPanel assistant={assistant} open={talking} onOpenChange={setTalking} />
      </div>
    </EditorProvider>
  );
}
