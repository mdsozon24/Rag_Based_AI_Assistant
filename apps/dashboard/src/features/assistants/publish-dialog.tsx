'use client';

import { Rocket } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api/client';
import type { Assistant } from '@/lib/api/types';
import { useAssistantMutations } from './api';

/**
 * Publishing snapshots the saved draft into an immutable version that new calls use. Unsaved edits
 * are saved first (`saveFirst` returns false when they did not validate).
 */
export function PublishDialog({ assistant, dirty, saveFirst, disabled }: { assistant: Assistant; dirty: boolean; saveFirst: () => Promise<boolean>; disabled?: boolean }) {
  const { publish } = useAssistantMutations(assistant.id);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nothingNew = !dirty && assistant.publishedVersion && !assistant.hasUnpublishedChanges;
  const next = (assistant.latestVersion ?? 0) + 1;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (dirty && !(await saveFirst())) {
        setError('Fix the highlighted fields first; nothing was published.');
        return;
      }
      const version = await publish.mutateAsync(note.trim());
      toast.success(`Version ${version.version} is live`, 'New calls use it now.');
      setOpen(false);
      setNote('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not publish.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="primary" disabled={disabled || Boolean(nothingNew)} title={nothingNew ? 'Nothing new to publish' : undefined}>
          <Rocket aria-hidden="true" />
          Publish
        </Button>
      }
      title={`Publish version ${next}`}
      description="New calls use the published version. Calls already in progress keep theirs. You can roll back at any time."
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={run}>
            {dirty ? 'Save and publish' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {dirty ? <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-text">You have unsaved changes. They are saved first, then published.</p> : null}
        {error ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <Field label="What changed" description="Optional note for the version history (up to 500 characters).">
          {(props) => <Textarea {...props} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
