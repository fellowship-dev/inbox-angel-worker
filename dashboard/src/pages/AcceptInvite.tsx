import { useState, useEffect } from 'preact/hooks';

interface InviteInfo {
  email: string;
  invited_by: string;
  role: string;
}

interface Props {
  token: string;
  onAccepted: (sessionToken: string) => void;
}

export function AcceptInvite({ token, onAccepted }: Props) {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`/api/invites/${token}`)
      .then(r => r.ok ? r.json() as Promise<InviteInfo> : Promise.reject(r.status))
      .then(setInvite)
      .catch(() => setLoadError('This invite link is invalid or has expired.'));
  }, [token]);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`/api/invites/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), password }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? `Error ${res.status}`);
        return;
      }
      const { token: sessionToken } = await res.json() as { token: string };
      localStorage.setItem('ia_api_key', sessionToken);
      onAccepted(sessionToken);
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  };

  if (loadError) {
    return (
      <div style={s.wrap}>
        <div style={s.box}>
          <div style={s.logo}>🪄 InboxAngel</div>
          <h1 style={s.title}>Invite not found</h1>
          <p style={s.muted}>{loadError}</p>
          <a href="#/" style={s.btn}>Go to dashboard</a>
        </div>
      </div>
    );
  }

  if (!invite) {
    return (
      <div style={s.wrap}>
        <div style={s.box}><p style={s.muted}>Loading…</p></div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <form onSubmit={submit} style={s.box}>
        <div style={s.logo}>🪄 InboxAngel</div>
        <h1 style={s.title}>You're invited</h1>
        <p style={s.subtitle}>
          <strong>{invite.invited_by}</strong> invited you to join their InboxAngel workspace as a <strong>{invite.role}</strong>.
        </p>

        <div style={s.emailBadge}>{invite.email}</div>

        <label style={s.label}>
          Your name
          <input
            type="text"
            placeholder="Jane Smith"
            value={name}
            onInput={e => setName((e.target as HTMLInputElement).value)}
            style={s.input}
            required
            autoFocus
            autoComplete="name"
          />
        </label>

        <label style={s.label}>
          Choose a password
          <input
            type="password"
            placeholder="At least 8 characters"
            value={password}
            onInput={e => setPassword((e.target as HTMLInputElement).value)}
            style={s.input}
            required
            autoComplete="new-password"
          />
        </label>

        <label style={s.label}>
          Confirm password
          <input
            type="password"
            placeholder="Same password again"
            value={confirm}
            onInput={e => setConfirm((e.target as HTMLInputElement).value)}
            style={s.input}
            required
            autoComplete="new-password"
          />
        </label>

        {error && <p style={s.error}>{error}</p>}

        <button type="submit" style={s.btn} disabled={loading}>
          {loading ? '…' : 'Create account →'}
        </button>
      </form>
    </div>
  );
}

const s = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f9fafb',
    padding: '2rem 1rem',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  } as const,
  box: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1rem',
    width: '100%',
    maxWidth: '400px',
    padding: '2rem',
    background: '#fff',
    borderRadius: '12px',
    boxShadow: '0 1px 6px rgba(0,0,0,0.1)',
  },
  logo: { fontSize: '1.1rem', fontWeight: 700, color: '#111827' } as const,
  title: { margin: 0, fontSize: '1.4rem', fontWeight: 700, letterSpacing: '-0.02em' },
  subtitle: { margin: 0, color: '#6b7280', fontSize: '0.875rem', lineHeight: 1.5 } as const,
  emailBadge: { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.875rem', color: '#15803d', fontWeight: 500 } as const,
  label: { display: 'flex', flexDirection: 'column' as const, gap: '0.35rem', fontSize: '0.875rem', fontWeight: 600, color: '#374151' },
  input: { padding: '0.6rem 0.75rem', border: '1.5px solid #d1d5db', borderRadius: '6px', fontSize: '0.95rem', outline: 'none', fontFamily: 'inherit' } as const,
  error: { margin: 0, color: '#dc2626', fontSize: '0.875rem' } as const,
  btn: { display: 'block', textAlign: 'center' as const, padding: '0.7rem', background: '#111827', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '1rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'none', marginTop: '0.25rem' } as const,
  muted: { color: '#9ca3af', fontSize: '0.875rem' } as const,
};
