import { redirect } from 'next/navigation';

/** The dashboard opens on the assistants list. */
export default function Home() {
  redirect('/assistants');
}
