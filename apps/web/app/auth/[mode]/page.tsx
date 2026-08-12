'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AuthPage({ params }: { params: { mode: string } }) {
  const register = params.mode === 'register';
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    const response = await fetch(`/api/v1/auth/${register ? 'register' : 'login'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: data.get('email'), displayName: data.get('displayName'), deviceFingerprint: 'browser-login' }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      setError(body.error ?? 'Authentication failed.');
      setPending(false);
      return;
    }
    if (register) router.push('/auth/login'); else router.push('/');
  }

  return <main className="page-shell"><p className="eyebrow">AssuraPay secure access</p><h1>{register ? 'Create account' : 'Sign in'}</h1>
    <form className="panel" onSubmit={submit} aria-label={register ? 'Create account' : 'Sign in'}>
      <label>Email<input name="email" type="email" autoComplete="email" required /></label>
      {register && <label>Display name<input name="displayName" autoComplete="name" required /></label>}
      {error && <p role="alert">{error}</p>}
      <button className="button button--primary" disabled={pending}>{pending ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button>
    </form>
  </main>;
}
