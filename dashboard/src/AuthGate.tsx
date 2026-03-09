import { useState, useEffect } from 'preact/hooks';

interface AuthStatus {
  configured: boolean;
  prefill: { name: string; email: string };
  telemetry_default: boolean;
}

interface Props {
  onSave: (token: string) => void;
}

export function AuthGate({ onSave }: Props) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [telemetry, setTelemetry] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json() as Promise<AuthStatus>)
      .then(s => {
        setStatus(s);
        setName(s.prefill.name);
        setEmail(s.prefill.email);
        setTelemetry(s.telemetry_default);
      })
      .catch(() => setStatus({ configured: false, prefill: { name: '', email: '' }, telemetry_default: false }));
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError('');

    if (!status?.configured) {
      if (password !== confirm) { setError('Passwords do not match'); return; }
      if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    }

    setLoading(true);
    try {
      const endpoint = status?.configured ? '/api/auth/login' : '/api/auth/setup';
      const body = status?.configured
        ? { email, password }
        : { name, email, password, telemetry };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? `Error ${res.status}`);
        return;
      }

      const { token } = await res.json() as { token: string };
      localStorage.setItem('ia_api_key', token);
      onSave(token);
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  };

  if (!status) {
    return (
      <div style={s.wrap}>
        <div style={s.box}><p style={s.muted}>Loading…</p></div>
      </div>
    );
  }

  const isSetup = !status.configured;

  return (
    <div style={s.wrap}>
      <form onSubmit={submit} style={s.box}>
        <div style={s.logo}>🪄 InboxAngel</div>
        <h1 style={s.title}>{isSetup ? 'Create your account' : 'Welcome back'}</h1>
        {isSetup && (
          <p style={s.subtitle}>Set up your InboxAngel instance. You'll use these credentials to log in.</p>
        )}

        {isSetup && (
          <label style={s.label}>
            Your name
            <input
              type="text"
              placeholder="Jane Smith"
              value={name}
              onInput={e => setName((e.target as HTMLInputElement).value)}
              style={s.input}
              autoComplete="name"
            />
          </label>
        )}

        <label style={s.label}>
          Email
          <input
            type="email"
            placeholder="you@yourcompany.com"
            value={email}
            onInput={e => setEmail((e.target as HTMLInputElement).value)}
            style={s.input}
            required
            autoComplete="email"
            autoFocus={!isSetup}
          />
        </label>

        <label style={s.label}>
          Password
          <input
            type="password"
            placeholder={isSetup ? 'Choose a password (8+ chars)' : 'Your password'}
            value={password}
            onInput={e => setPassword((e.target as HTMLInputElement).value)}
            style={s.input}
            required
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            autoFocus={isSetup}
          />
        </label>

        {isSetup && (
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
        )}

        {isSetup && (
          <label style={s.checkboxLabel}>
            <input
              type="checkbox"
              checked={telemetry}
              onChange={e => setTelemetry((e.target as HTMLInputElement).checked)}
              style={{ marginRight: '0.5rem', marginTop: '2px', flexShrink: 0 }}
            />
            <span>
              <strong>Share anonymous usage stats</strong>
              <span style={s.checkboxHint}>
                {' '}— helps improve InboxAngel. No personal data, no email addresses, no domain names. Just feature usage counts. You can change this later.
              </span>
            </span>
          </label>
        )}

        {error && <p style={s.error}>{error}</p>}

        <button type="submit" style={s.btn} disabled={loading}>
          {loading ? '…' : isSetup ? 'Create account →' : 'Sign in →'}
        </button>

        {!isSetup && (
          <p style={s.forgotHint}>
            Forgot your password? You can reset it by running{' '}
            <code style={s.code}>wrangler d1 execute DB --remote --command "DELETE FROM settings WHERE key='password_hash'"</code>{' '}
            then refreshing this page.
          </p>
        )}
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
  label: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.35rem',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: '#374151',
  },
  input: {
    padding: '0.6rem 0.75rem',
    border: '1.5px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '0.95rem',
    outline: 'none',
    fontFamily: 'inherit',
  } as const,
  checkboxLabel: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0',
    fontSize: '0.8rem',
    color: '#374151',
    cursor: 'pointer',
    lineHeight: 1.5,
  } as const,
  checkboxHint: { color: '#6b7280' } as const,
  error: { margin: 0, color: '#dc2626', fontSize: '0.875rem' } as const,
  btn: {
    padding: '0.7rem',
    background: '#111827',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: '0.25rem',
  } as const,
  forgotHint: {
    margin: 0,
    fontSize: '0.75rem',
    color: '#9ca3af',
    lineHeight: 1.6,
  } as const,
  code: {
    fontFamily: 'monospace',
    fontSize: '0.7rem',
    background: '#f3f4f6',
    padding: '1px 4px',
    borderRadius: '3px',
    wordBreak: 'break-all' as const,
  },
  muted: { color: '#9ca3af', fontSize: '0.875rem' } as const,
};
