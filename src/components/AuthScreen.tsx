import React, { useState } from 'react';

interface AuthUser { id: string; email: string; createdAt: string; isAdmin?: boolean; }

interface AuthScreenProps {
  onAuthenticated: (user: AuthUser) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthenticated }) => {
  const resetToken = new URLSearchParams(window.location.search).get('resetToken');
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(resetToken ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : mode === 'register' ? '/api/auth/register' : mode === 'forgot' ? '/api/auth/forgot-password' : '/api/auth/reset-password';
      const body = mode === 'reset' ? { token: resetToken, password } : mode === 'forgot' ? { email } : { email, password };
      let response: Response;
      try {
        response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } catch {
        throw new Error('Cannot reach the server. Make sure it is running.');
      }
      const data = await response.json().catch(() => {
        throw new Error('The server did not respond correctly. Restart it and try again.');
      });
      if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
      if (mode === 'login' || mode === 'register') onAuthenticated(data.user);
      else if (mode === 'reset') { setMessage(data.message); setMode('login'); window.history.replaceState({}, '', window.location.pathname); }
      else setMessage(data.message);
    } catch (requestError: any) {
      setError(requestError.message || 'The request could not be completed.');
    } finally { setBusy(false); }
  };

  const title = mode === 'login' ? 'Log in to start talking' : mode === 'register' ? 'Create an account' : mode === 'forgot' ? 'Reset your password' : 'Choose a new password';

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100 flex items-center justify-center">
      <section className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-7 shadow-2xl">
        <div className="mb-7">
          <p className="text-sm font-medium text-emerald-400">Bangla AI Assistant</p>
          <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
          <p className="mt-2 text-sm text-slate-400">Your conversations and uploaded files are kept separately in your own account.</p>
        </div>
        {/* noValidate: show the server's validation messages instead of the browser's own */}
        <form onSubmit={submit} noValidate className="space-y-4">
          {mode !== 'reset' && <label className="block text-sm text-slate-300">Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none focus:border-emerald-500" /></label>}
          {mode !== 'forgot' && <label className="block text-sm text-slate-300">{mode === 'reset' ? 'New password' : 'Password'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none focus:border-emerald-500" /></label>}
          {(mode === 'register' || mode === 'reset') && <p className="text-xs text-slate-500">Password must be at least 8 characters.</p>}
          {error && <p className="rounded-lg border border-rose-800/60 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">{error}</p>}
          {message && <p className="rounded-lg border border-emerald-800/60 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">{message}</p>}
          <button disabled={busy} className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50">{busy ? 'Please wait...' : mode === 'login' ? 'Log in' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Update password'}</button>
        </form>
        <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-400">
          {mode === 'forgot' && <button onClick={() => setMode('login')} className="hover:text-emerald-300">Log in</button>}
          {mode === 'login' && <><button onClick={() => setMode('register')} className="hover:text-emerald-300">Create an account</button><button onClick={() => setMode('forgot')} className="hover:text-emerald-300">Forgot password?</button></>}
          {mode === 'register' && <button onClick={() => setMode('login')} className="hover:text-emerald-300">Already have an account? Log in</button>}
        </div>
      </section>
    </main>
  );
};
