import type { Metadata } from 'next';
import { NewAssistant } from '@/features/assistants/new-assistant';

export const metadata: Metadata = { title: 'New assistant' };

export default function Page() {
  return <NewAssistant />;
}
