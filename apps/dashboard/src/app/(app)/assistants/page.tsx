import type { Metadata } from 'next';
import { AssistantList } from '@/features/assistants/assistant-list';

export const metadata: Metadata = { title: 'Assistants' };

export default function Page() {
  return <AssistantList />;
}
