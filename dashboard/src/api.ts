const getKey = () => localStorage.getItem('ia_api_key') ?? '';

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: { 'X-Api-Key': getKey(), 'Content-Type': 'application/json', ...init.headers },
  });
}

export async function addDomain(domain: string): Promise<import('./types').AddDomainResult> {
  const res = await apiFetch('/api/domains', { method: 'POST', body: JSON.stringify({ domain }) });
  if (!res.ok) {
    const body = await res.json() as { error?: string };
    throw new Error(body.error ?? `${res.status}`);
  }
  return res.json();
}

export async function getDomains(): Promise<{ domains: import('./types').Domain[] }> {
  const res = await apiFetch('/api/domains');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getDomainStats(id: number, days = 7): Promise<import('./types').DomainStats> {
  const res = await apiFetch(`/api/domains/${id}/stats?days=${days}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getDomainSources(id: number, days = 7): Promise<{ sources: import('./types').FailingSource[] }> {
  const res = await apiFetch(`/api/domains/${id}/sources?days=${days}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getDomainReport(id: number, date: string): Promise<import('./types').DayReport> {
  const res = await apiFetch(`/api/domains/${id}/reports?date=${date}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getDomainExplore(id: number, days = 30): Promise<{ days: number; domain: string; sources: import('./types').AnomalySource[] }> {
  const res = await apiFetch(`/api/domains/${id}/explore?days=${days}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getCheckResults(): Promise<{ results: import('./types').CheckResult[] }> {
  const res = await apiFetch('/api/check-results');
  if (!res.ok) throw new Error(`${res.status}`);
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
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function deleteDomain(id: number): Promise<void> {
  const res = await apiFetch(`/api/domains/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status}`);
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
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function setMonitorSubActive(subId: number, active: boolean): Promise<void> {
  const res = await apiFetch(`/api/monitor-subs/${subId}`, {
    method: 'PATCH',
    body: JSON.stringify({ active }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  last_login_at: number | null;
  created_at: number;
}

export async function getTeam(): Promise<{ users: TeamMember[] }> {
  const res = await apiFetch('/api/team');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function inviteTeamMember(email: string): Promise<{ token: string }> {
  const res = await apiFetch('/api/team/invite', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? `${res.status}`);
  }
  return res.json();
}

export async function removeTeamMember(id: string): Promise<void> {
  const res = await apiFetch(`/api/team/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status}`);
}
