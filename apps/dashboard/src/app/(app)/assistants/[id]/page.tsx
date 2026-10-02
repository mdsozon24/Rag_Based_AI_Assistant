import type { Metadata } from 'next';
import { AssistantEditor } from '@/features/assistants/editor/assistant-editor';

export const metadata: Metadata = { title: 'Assistant' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AssistantEditor id={id} />;
}
