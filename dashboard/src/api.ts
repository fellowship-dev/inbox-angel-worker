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
