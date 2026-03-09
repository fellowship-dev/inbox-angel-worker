import { useState, useEffect } from 'preact/hooks';
import { useIsMobile } from './hooks';
import { Overview } from './pages/Overview';
import { DomainDetail } from './pages/Domain';
import { AddDomain } from './pages/AddDomain';
import { ReportDetail } from './pages/ReportDetail';
import { DomainSettings } from './pages/DomainSettings';
import { Explore } from './pages/Explore';
import { Anomalies } from './pages/Anomalies';
import { EmailCheck } from './pages/EmailCheck';
import { Team } from './pages/Team';
import { AcceptInvite } from './pages/AcceptInvite';
import { ResetPassword } from './pages/ResetPassword';
import { AuthGate } from './AuthGate';
import { getVersion, logout, type VersionInfo } from './api';

const DISMISS_KEY = 'ia_update_dismissed';

function UpdateBanner({ info, onDismiss }: { info: VersionInfo; onDismiss: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '0.75rem', flexWrap: 'wrap',
      background: '#fefce8', border: '1px solid #fde68a',
      borderRadius: '8px', padding: '0.6rem 1rem', marginBottom: '1rem',
      fontSize: '0.875rem', color: '#92400e',
    }}>
      <span>
        New version available: <strong>v{info.latest}</strong>
        {' '}— you're on <strong>v{info.current}</strong>
      </span>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexShrink: 0 }}>
        <a href={info.release_url} target="_blank" rel="noreferrer" style={{
          color: '#92400e', fontWeight: 600, textDecoration: 'underline',
        }}>
          View release
        </a>
        <button onClick={onDismiss} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#b45309', fontSize: '1rem', lineHeight: 1, padding: '0 2px',
        }}>✕</button>
      </div>
    </div>
  );
}

function getRoute(): string {
  return window.location.hash.replace(/^#/, '') || '/';
}

function navActive(route: string, section: 'domains' | 'check' | 'team'): boolean {
  if (section === 'check') return route === '/check';
  if (section === 'team') return route === '/team';
  return route === '/' || route === '/add' || route.startsWith('/domains/');
}

export function App() {
  const [route, setRoute] = useState(getRoute);
  const [hasKey, setHasKey] = useState(() => !!localStorage.getItem('ia_api_key'));
  const [update, setUpdate] = useState<VersionInfo | null>(null);
  const handleUnauth = () => { localStorage.removeItem('ia_api_key'); setHasKey(false); };

  // Unauthenticated routes — must be checked before auth gate
  const inviteMatch = route.match(/^\/invite\/(.+)$/);
  if (inviteMatch) {
    return <AcceptInvite token={inviteMatch[1]} onAccepted={() => setHasKey(true)} />;
  }
  const resetMatch = route.match(/^\/reset\/(.+)$/);
  if (resetMatch) {
    return <ResetPassword token={resetMatch[1]} onReset={() => { setHasKey(true); window.location.hash = '/'; }} />;
  }

  useEffect(() => {
    const onHash = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (sessionStorage.getItem(DISMISS_KEY)) return;
    getVersion().then(v => { if (v.update_available) setUpdate(v); }).catch(() => {});
  }, []);

  const mobile = useIsMobile();

  if (!hasKey) return <AuthGate onSave={() => setHasKey(true)} />;

  return (
    <div style={{ ...styles.shell, padding: mobile ? '0 1rem' : '0 1.5rem' }}>
      <header style={styles.header}>
        <a href="#/" style={styles.logo}>InboxAngel</a>
        <nav style={styles.nav}>
          <a href="#/" style={{ ...styles.navLink, ...(navActive(route, 'domains') ? styles.navLinkActive : {}) }}>
            Domains
          </a>
          <a href="#/check" style={{ ...styles.navLink, ...(navActive(route, 'check') ? styles.navLinkActive : {}) }}>
            {mobile ? 'Check' : 'Email check'}
          </a>
          <a href="#/team" style={{ ...styles.navLink, ...(navActive(route, 'team') ? styles.navLinkActive : {}) }}>
            Team
          </a>
          <button
            onClick={async () => { await logout(); setHasKey(false); }}
            style={styles.logoutBtn}
          >
            {mobile ? '↩' : 'Sign out'}
          </button>
        </nav>
      </header>
      <main style={styles.main}>
        {update && (
          <UpdateBanner info={update} onDismiss={() => {
            sessionStorage.setItem(DISMISS_KEY, '1');
            setUpdate(null);
          }} />
        )}
        {route === '/' && <Overview onUnauthorized={handleUnauth} />}
        {route === '/add' && <AddDomain onUnauthorized={handleUnauth} />}
        {route === '/check' && <EmailCheck />}
        {route === '/team' && <Team onUnauthorized={handleUnauth} />}
        {/^\/domains\/(\d+)$/.test(route) && !/\/settings$/.test(route) && (
          <DomainDetail id={parseInt(route.split('/')[2], 10)} onUnauthorized={handleUnauth} />
        )}
        {/^\/domains\/(\d+)\/settings$/.test(route) && (
          <DomainSettings id={parseInt(route.split('/')[2], 10)} onUnauthorized={handleUnauth} />
        )}
        {/^\/domains\/(\d+)\/explore$/.test(route) && (
          <Explore domainId={parseInt(route.split('/')[2], 10)} onUnauthorized={handleUnauth} />
        )}
        {/^\/domains\/(\d+)\/anomalies$/.test(route) && (
          <Anomalies domainId={parseInt(route.split('/')[2], 10)} onUnauthorized={handleUnauth} />
        )}
        {(() => {
          const m = route.match(/^\/domains\/(\d+)\/reports\/(\d{4}-\d{2}-\d{2})$/);
          return m ? <ReportDetail domainId={parseInt(m[1], 10)} date={m[2]} onUnauthorized={handleUnauth} /> : null;
        })()}
        {route !== '/' && route !== '/add' && route !== '/check' && route !== '/team' &&
         !/^\/domains\/\d+$/.test(route) &&
         !/^\/domains\/\d+\/settings$/.test(route) &&
         !/^\/domains\/\d+\/explore$/.test(route) &&
         !/^\/domains\/\d+\/anomalies$/.test(route) &&
         !/^\/domains\/\d+\/reports\/\d{4}-\d{2}-\d{2}$/.test(route) && (
          <p style={{ color: '#9ca3af' }}>Page not found. <a href="#/">Back to overview</a></p>
        )}
      </main>
    </div>
  );
}

const styles = {
  shell: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: '760px',
    margin: '0 auto',
    padding: '0 1.5rem',
    color: '#111827',
  } as const,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1.25rem 0',
    borderBottom: '1px solid #e5e7eb',
    marginBottom: '1.5rem',
  } as const,
  logo: {
    fontWeight: 700,
    fontSize: '1.1rem',
    textDecoration: 'none',
    color: '#111827',
  } as const,
  nav: {
    display: 'flex',
    gap: '1rem',
  } as const,
  navLink: {
    fontSize: '0.875rem',
    textDecoration: 'none',
    color: '#6b7280',
  } as const,
  navLinkActive: {
    color: '#111827',
    fontWeight: 600,
  } as const,
  logoutBtn: {
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: '0.875rem',
    color: '#9ca3af',
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const,
  main: {
    paddingBottom: '3rem',
  } as const,
};
