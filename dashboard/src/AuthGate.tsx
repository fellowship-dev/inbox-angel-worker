import { useState, useEffect, useRef } from 'preact/hooks';
import { setupCustomDomain } from './api';

interface AuthStatus {
  configured: boolean;
  prefill: { name: string; email: string };
  telemetry_default: boolean;
  turnstile_site_key: string | null;
}

interface Props {
  onSave: (token: string) => void;
}

const STARTUP_MESSAGES = [
  { after: 0,  text: 'Starting up' },
  { after: 6,  text: 'Running database setup' },
  { after: 20, text: 'Setting up your instance' },
  { after: 40, text: 'Almost there' },
];

function StartupLoader() {
  const [elapsed, setElapsed] = useState(0);
  const [dots, setDots] = useState('');

  useEffect(() => {
    const tick = setInterval(() => {
      setElapsed(e => e + 1);
      setDots(d => d.length >= 3 ? '' : d + '.');
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  const msg = [...STARTUP_MESSAGES].reverse().find(m => elapsed >= m.after)?.text ?? 'Starting up';
  const isSlowStart = elapsed >= 6;

  return (
    <div style={s.wrap}>
      <div style={{ ...s.box, alignItems: 'center', gap: '0.75rem' }}>
        <div style={s.logo}>🪄 InboxAngel</div>
        <p style={{ ...s.muted, margin: 0 }}>{msg}{dots}</p>
        {isSlowStart && (
          <p style={{ ...s.muted, fontSize: '0.75rem', margin: 0 }}>
            First startup runs database migrations — only happens once.
          </p>
        )}
      </div>
    </div>
  );
}

function loadTurnstileScript() {
  if (document.querySelector('script[data-cf-turnstile]')) return;
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  s.async = true;
  s.setAttribute('data-cf-turnstile', '1');
  document.head.appendChild(s);
}

function SetupDone({ email, emailVerificationSent, onContinue }: {
  email: string;
  emailVerificationSent: boolean;
  onContinue: () => void;
}) {
  const [phase, setPhase] = useState<'email' | 'custom-domain'>('email');
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [hostname, setHostname] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json() as Promise<{ custom_domain?: string | null; base_domain?: string | null }>)
      .then(d => {
        if (d.custom_domain) setHostname(d.custom_domain);
        else if (d.base_domain) setHostname(`inbox-angel.${d.base_domain}`);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (countdown === null || !hostname) return;
    if (countdown <= 0) {
      window.location.href = `https://${hostname}/#/onboarding`;
      return;
    }
    const t = setTimeout(() => setCountdown(c => (c ?? 1) - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, hostname]);

  const provision = async () => {
    setProvisioning(true);
    setProvisionError(null);
    try {
      const result = await setupCustomDomain();
      setHostname(result.hostname);
      setCountdown(5);
    } catch (e: any) {
      setProvisionError(e.message ?? 'Failed to set up custom domain');
    } finally {
      setProvisioning(false);
    }
  };

  if (phase === 'email') {
    return (
      <div style={s.wrap}>
        <div style={s.box}>
          <div style={s.logo}>🪄 InboxAngel</div>
          <div style={s.successBadge}>✓ Account created</div>
          <h1 style={s.title}>One more thing</h1>
          {emailVerificationSent ? (
            <>
              <p style={s.subtitle}>
                We've asked Cloudflare to send a verification email to <strong>{email}</strong>.
              </p>
              <div style={s.notice}>
                <strong>Why?</strong> InboxAngel sends monitoring alerts and password reset emails
                through Cloudflare Email Workers. Cloudflare requires destination addresses to be
                verified once — this is the only step they put in your way.
              </div>
              <p style={s.muted}>Click the link in that email, then you're fully set up. You can continue to the dashboard in the meantime.</p>
            </>
          ) : (
            <>
              <p style={s.subtitle}>
                To receive <strong>password reset emails</strong> and <strong>monitoring alerts</strong>,
                you need to verify your email as a destination in Cloudflare Email Routing.
              </p>
              <div style={s.notice}>
                <strong>Why?</strong> InboxAngel sends emails via Cloudflare's Email Workers
                binding (<code style={s.code}>SEND_EMAIL</code>), which can only deliver to
                verified destination addresses — this is a Cloudflare platform requirement,
                not something we can bypass.
              </div>
              <ol style={s.steps}>
                <li>Go to <strong>Cloudflare Dashboard → your zone → Email → Routing → Destinations</strong></li>
                <li>Click <strong>Add destination</strong> and enter <code style={s.code}>{email}</code></li>
                <li>Check your inbox and click the verification link Cloudflare sends</li>
              </ol>
              <p style={s.muted}>You can skip this for now and verify later — just know you won't receive emails until it's done.</p>
            </>
          )}
          <button type="button" style={s.btn} onClick={() => setPhase('custom-domain')}>
            Continue →
          </button>
        </div>
      </div>
    );
  }

  // Phase 2: custom domain setup
  return (
    <div style={s.wrap}>
      <div style={s.box}>
        <div style={s.logo}>🪄 InboxAngel</div>
        <h1 style={s.title}>Custom domain</h1>
        <p style={s.subtitle}>
          Access your dashboard at a clean URL instead of the default workers.dev address.
        </p>

        {countdown !== null && hostname ? (
          <div style={{
            background: '#dcfce7', border: '1px solid #bbf7d0',
            borderRadius: '8px', padding: '1rem', textAlign: 'center',
          }}>
            <p style={{ margin: 0, fontSize: '0.95rem', color: '#15803d', fontWeight: 600 }}>
              Custom domain is live!
            </p>
            <p style={{ margin: '0.25rem 0 0', fontFamily: 'monospace', fontSize: '0.9rem', color: '#166534' }}>
              {hostname}
            </p>
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#166534' }}>
              Redirecting in {countdown}s…
            </p>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={provision}
              disabled={provisioning}
              style={{ ...s.btn, opacity: provisioning ? 0.6 : 1 }}
            >
              {provisioning ? 'Setting up…' : 'Set up custom domain'}
            </button>
            {provisionError && <p style={{ ...s.error, marginTop: '0.5rem' }}>{provisionError}</p>}
            <button type="button" onClick={onContinue} style={s.link}>
              Skip for now →
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function AuthGate({ onSave }: Props) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [view, setView] = useState<'auth' | 'forgot' | 'forgot-sent' | 'setup-done'>('auth');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [telemetry, setTelemetry] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingToken, setPendingToken] = useState('');
  const [emailVerificationSent, setEmailVerificationSent] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json() as Promise<AuthStatus>)
      .then(s => {
        setStatus(s);
        setName(s.prefill.name);
        setEmail(s.prefill.email);
        setTelemetry(s.telemetry_default);
        if (s.turnstile_site_key) loadTurnstileScript();
      })
      .catch(() => setStatus({ configured: false, prefill: { name: '', email: '' }, telemetry_default: false, turnstile_site_key: null }));
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

      // Collect Turnstile token if widget is present
      const cf_turnstile_token = status?.turnstile_site_key
        ? (document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null)?.value ?? undefined
        : undefined;

      const body = status?.configured
        ? { email, password, ...(cf_turnstile_token ? { cf_turnstile_token } : {}) }
        : { name, email, password, telemetry, ...(cf_turnstile_token ? { cf_turnstile_token } : {}) };

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

      const { token, email_verification_sent } = await res.json() as { token: string; email_verification_sent?: boolean };
      localStorage.setItem('ia_api_key', token);
      if (!status?.configured) {
        setPendingToken(token);
        setEmailVerificationSent(email_verification_sent ?? false);
        setView('setup-done');
      } else {
        onSave(token);
      }
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  };

  const submitForgot = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setView('forgot-sent');
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  };

  if (!status) {
    return <StartupLoader />;
  }

  if (view === 'forgot') {
    return (
      <div style={s.wrap}>
        <form onSubmit={submitForgot} style={s.box}>
          <div style={s.logo}>🪄 InboxAngel</div>
          <h1 style={s.title}>Reset password</h1>
          <p style={s.subtitle}>Enter your email and we'll send you a reset link.</p>
          <label style={s.label}>
            Email
            <input
              type="email"
              placeholder="you@yourcompany.com"
              value={email}
              onInput={e => setEmail((e.target as HTMLInputElement).value)}
              style={s.input}
              required
              autoFocus
            />
          </label>
          {error && <p style={s.error}>{error}</p>}
          <button type="submit" style={s.btn} disabled={loading}>
            {loading ? '…' : 'Send reset link →'}
          </button>
          <button type="button" onClick={() => { setView('auth'); setError(''); }} style={s.link}>
            ← Back to sign in
          </button>
        </form>
      </div>
    );
  }

  if (view === 'forgot-sent') {
    return (
      <div style={s.wrap}>
        <div style={s.box}>
          <div style={s.logo}>🪄 InboxAngel</div>
          <h1 style={s.title}>Check your inbox</h1>
          <p style={s.subtitle}>If an account exists for <strong>{email}</strong>, we've sent a reset link. It expires in 1 hour.</p>
          <button type="button" onClick={() => { setView('auth'); setError(''); }} style={s.link}>
            ← Back to sign in
          </button>
        </div>
      </div>
    );
  }

  if (view === 'setup-done') {
    return <SetupDone
      email={email}
      emailVerificationSent={emailVerificationSent}
      onContinue={() => {
        window.location.hash = '#/onboarding';
        onSave(pendingToken);
      }}
    />;
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
            <span>Your name <span style={{ fontWeight: 400, color: '#9ca3af' }}>— optional</span></span>
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
          {isSetup && <span style={s.hint}>Used to log in and receive monitoring alerts.</span>}
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

        {status?.turnstile_site_key && (
          <div
            ref={turnstileRef}
            class="cf-turnstile"
            data-sitekey={status.turnstile_site_key}
            data-theme="light"
          />
        )}

        {error && <p style={s.error}>{error}</p>}

        <button type="submit" style={s.btn} disabled={loading}>
          {loading ? '…' : isSetup ? 'Create account →' : 'Sign in →'}
        </button>

        {!isSetup && (
          <button type="button" onClick={() => { setView('forgot'); setError(''); }} style={s.link}>
            Forgot your password?
          </button>
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
  hint: { fontWeight: 400, fontSize: '0.78rem', color: '#9ca3af', marginTop: '0.1rem' } as const,
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
  link: {
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: '0.8rem',
    color: '#6b7280',
    cursor: 'pointer',
    textAlign: 'center' as const,
    textDecoration: 'underline',
  } as const,
  muted: { color: '#9ca3af', fontSize: '0.875rem' } as const,
  successBadge: {
    display: 'inline-block',
    background: '#dcfce7',
    color: '#16a34a',
    fontSize: '0.8rem',
    fontWeight: 600,
    padding: '0.25rem 0.6rem',
    borderRadius: '4px',
  } as const,
  notice: {
    fontSize: '0.8rem',
    color: '#374151',
    background: '#fef9c3',
    border: '1px solid #fde68a',
    borderRadius: '6px',
    padding: '0.75rem 1rem',
    lineHeight: 1.5,
  } as const,
  code: {
    fontFamily: 'monospace',
    fontSize: '0.85em',
    background: '#f3f4f6',
    padding: '0.1em 0.3em',
    borderRadius: '3px',
  } as const,
  steps: {
    margin: '0',
    paddingLeft: '1.25rem',
    fontSize: '0.875rem',
    color: '#374151',
    lineHeight: 1.8,
  } as const,
};
