const getKey = () => localStorage.getItem('ia_api_key') ?? '';

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: { 'X-Api-Key': getKey(), 'Content-Type': 'application/json', ...init.headers },
  });
}

// Converts HTTP status codes to user-friendly messages.
// Preserves '401' as a literal string — pages check e.message === '401' to trigger logout.
async function throwApiError(res: Response): Promise<never> {
  if (res.status === 401) throw new Error('401');
  let serverMsg: string | undefined;
  try { serverMsg = ((await res.json()) as { error?: string }).error; } catch { /* ignore */ }
  const fallback: Record<number, string> = {
    403: 'You don\'t have permission to do that',
    404: 'Not found',
    409: 'Already exists',
    429: 'Too many requests — please wait a moment and try again',
    500: 'Server error — please try again',
    503: 'Service unavailable — please try again shortly',
  };
  throw new Error(serverMsg ?? fallback[res.status] ?? `Unexpected error (${res.status})`);
}

export async function addDomain(domain: string): Promise<import('./types').AddDomainResult> {
  const res = await apiFetch('/api/domains', { method: 'POST', body: JSON.stringify({ domain }) });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function getDomains(): Promise<{ domains: import('./types').Domain[] }> {
  const res = await apiFetch('/api/domains');
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function getDomainStats(id: number, days = 7): Promise<import('./types').DomainStats> {
  const res = await apiFetch(`/api/domains/${id}/stats?days=${days}`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function getDomainSources(id: number, days = 7): Promise<{ sources: import('./types').FailingSource[] }> {
  const res = await apiFetch(`/api/domains/${id}/sources?days=${days}`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function getDomainReport(id: number, date: string): Promise<import('./types').DayReport> {
  const res = await apiFetch(`/api/domains/${id}/reports?date=${date}`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function getDomainExplore(id: number, days = 30): Promise<{ days: number; domain: string; sources: import('./types').AnomalySource[] }> {
  const res = await apiFetch(`/api/domains/${id}/explore?days=${days}`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function getCheckResults(): Promise<{ results: import('./types').CheckResult[] }> {
  const res = await apiFetch('/api/check-results');
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  release_url: string;
}

export async function getVersion(): Promise<VersionInfo> {
  const res = await fetch('/api/version');
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function checkDomainDns(id: number): Promise<{ found: boolean; has_rua: boolean }> {
  const res = await apiFetch(`/api/domains/${id}/dns-check`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function deleteDomain(id: number): Promise<void> {
  const res = await apiFetch(`/api/domains/${id}`, { method: 'DELETE' });
  if (!res.ok) await throwApiError(res);
}

export async function setDomainAlerts(id: number, enabled: boolean): Promise<void> {
  const res = await apiFetch(`/api/domains/${id}/alerts`, {
    method: 'PATCH',
    body: JSON.stringify({ alerts_enabled: enabled }),
  });
  if (!res.ok) await throwApiError(res);
}

export interface MonitorSub {
  id: number;
  email: string;
  domain: string;
  active: number;
  created_at: number;
}

export async function getMonitorSubs(domainId: number): Promise<{ subs: MonitorSub[] }> {
  const res = await apiFetch(`/api/domains/${domainId}/monitor-subs`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function setMonitorSubActive(subId: number, active: boolean): Promise<void> {
  const res = await apiFetch(`/api/monitor-subs/${subId}`, {
    method: 'PATCH',
    body: JSON.stringify({ active }),
  });
  if (!res.ok) await throwApiError(res);
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  last_login_at: number | null;
  created_at: number;
}

export async function getTeam(): Promise<{ users: TeamMember[]; current_user_id: string }> {
  const res = await apiFetch('/api/team');
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function inviteTeamMember(email: string): Promise<{ token: string }> {
  const res = await apiFetch('/api/team/invite', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function removeTeamMember(id: string): Promise<void> {
  const res = await apiFetch(`/api/team/${id}`, { method: 'DELETE' });
  if (!res.ok) await throwApiError(res);
}

export async function logout(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('ia_api_key');
}
