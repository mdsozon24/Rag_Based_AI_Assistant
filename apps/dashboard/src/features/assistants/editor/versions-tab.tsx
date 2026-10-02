'use client';

import { History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { InlineField } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TBody, Td, Th, THead, Tr } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import type { Assistant, AssistantVersion } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { useAssistantMutations, useVersion, useVersions } from '../api';

export function VersionsTab({ assistant, readOnly, onRestored }: { assistant: Assistant; readOnly: boolean; onRestored: (assistant: Assistant) => void }) {
  const versions = useVersions(assistant.id);
  const [viewing, setViewing] = useState<number | null>(null);
  if (versions.isPending) return <LoadingState label="Loading versions…" />;
  if (versions.isError) return <ErrorState error={versions.error} title="Could not load versions" onRetry={() => void versions.refetch()} />;
  if (!versions.data.data.length) return <EmptyState icon={<History />} title="Nothing published yet" description="Each publish saves an immutable version. Calls use the published one; you can roll back at any time." />;
  return (
    <>
      <Table label="Published versions">
        <THead>
          <Tr>
            <Th>Version</Th>
            <Th>Note</Th>
            <Th className="hidden sm:table-cell">Published</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Tr>
        </THead>
        <TBody>
          {versions.data.data.map((version) => (
            <Tr key={version.id}>
              <Td>
                <span className="font-medium">v{version.version}</span> {version.published ? <Badge tone="success">Live</Badge> : null}
              </Td>
              <Td className="max-w-xs text-muted">{version.note || '—'}</Td>
              <Td className="hidden text-muted sm:table-cell">{formatDateTime(version.createdAt)}</Td>
              <Td>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button size="sm" onClick={() => setViewing(version.version)}>
                    View
                  </Button>
                  {readOnly ? null : <RollbackButton assistant={assistant} version={version} onRestored={onRestored} />}
                </div>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <VersionDialog assistantId={assistant.id} version={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

function RollbackButton({ assistant, version, onRestored }: { assistant: Assistant; version: AssistantVersion; onRestored: (assistant: Assistant) => void }) {
  const { rollback } = useAssistantMutations(assistant.id);
  const toast = useToast();
  const [restoreDraft, setRestoreDraft] = useState(version.published);
  return (
    <ConfirmDialog
      tone="primary"
      trigger={
        <Button size="sm">
          <RotateCcw aria-hidden="true" />
          {version.published ? 'Restore draft' : 'Roll back'}
        </Button>
      }
      title={version.published ? `Restore v${version.version} into the draft?` : `Make v${version.version} live?`}
      description={version.published ? 'The draft is replaced with this version. Unsaved and unpublished changes are lost.' : `New calls will use v${version.version}. Calls in progress keep their version.`}
      confirmLabel={version.published ? 'Restore draft' : `Make v${version.version} live`}
      onConfirm={async () => {
        try {
          const updated = await rollback.mutateAsync({ version: version.version, restoreDraft });
          if (restoreDraft) onRestored(updated);
          toast.success(version.published ? `Draft restored from v${version.version}` : `v${version.version} is live`);
        } catch (error) {
          toast.error('Could not roll back', error);
          throw error;
        }
      }}
    >
      {version.published ? null : (
        <InlineField label="Also replace the draft with this version" description="Otherwise the draft keeps your current edits.">
          {(props) => <Checkbox {...props} checked={restoreDraft} onChange={(e) => setRestoreDraft(e.target.checked)} />}
        </InlineField>
      )}
    </ConfirmDialog>
  );
}

function VersionDialog({ assistantId, version, onClose }: { assistantId: string; version: number | null; onClose: () => void }) {
  const detail = useVersion(assistantId, version);
  return (
    <Dialog open={version !== null} onOpenChange={(open) => !open && onClose()} title={`Version ${version ?? ''}`} description="The exact config calls of this version run with." size="lg">
      {detail.isPending ? (
        <LoadingState rows={4} />
      ) : detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed text-text">{JSON.stringify(detail.data.config ?? {}, null, 2)}</pre>
      )}
    </Dialog>
  );
}
