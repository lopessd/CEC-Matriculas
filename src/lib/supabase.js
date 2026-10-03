const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const storageKey = 'cec.supabase.session';

function getStoredSession() {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || 'null');
  } catch {
    return null;
  }
}

function saveSession(session) {
  if (session) localStorage.setItem(storageKey, JSON.stringify(session));
  else localStorage.removeItem(storageKey);
}

function configured() {
  return Boolean(url && key);
}

async function currentSession() {
  const session = getStoredSession();
  if (!session?.refresh_token || !session.expires_at || session.expires_at * 1000 > Date.now() + 60_000) return session;
  const response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token })
  });
  if (!response.ok) { saveSession(null); return null; }
  const refreshed = await response.json();
  saveSession(refreshed);
  return refreshed;
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  if (!configured()) throw new Error('Supabase não foi configurado neste ambiente.');
  const session = await currentSession();
  const response = await fetch(`${url}/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${session?.access_token || key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || payload?.error || payload?.error_description || 'Não foi possível consultar o Supabase.');
  return payload;
}

export const supabase = {
  configured,
  getSession: getStoredSession,
  async signInWithPassword(email, password) {
    const session = await request('auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email, password },
      headers: { Authorization: `Bearer ${key}` }
    });
    saveSession(session);
    return session;
  },
  async signOut() {
    const session = getStoredSession();
    if (session?.access_token) {
      await request('auth/v1/logout', { method: 'POST' }).catch(() => null);
    }
    saveSession(null);
  },
  select(resource, query = '') {
    return request(`rest/v1/${resource}${query ? `?${query}` : ''}`);
  },
  rpc(name, args) {
    return request(`rest/v1/rpc/${name}`, { method: 'POST', body: args });
  },
  invokeFunction(name, body) {
    return request(`functions/v1/${name}`, { method: 'POST', body });
  },
  async downloadStorageObject(bucket, path) {
    if (!configured()) throw new Error('Supabase não foi configurado neste ambiente.');
    const session = await currentSession();
    if (!session?.access_token) throw new Error('Entre novamente para acessar o contrato.');
    const objectPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${url}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${objectPath}`, {
      headers: { apikey: key, Authorization: `Bearer ${session.access_token}` }
    });
    if (!response.ok) throw new Error('Não foi possível acessar o contrato assinado.');
    return response.blob();
  },
  insert(resource, values) {
    return request(`rest/v1/${resource}`, {
      method: 'POST', body: values,
      headers: { Prefer: 'return=representation' }
    });
  },
  update(resource, filter, values) {
    return request(`rest/v1/${resource}?${filter}`, {
      method: 'PATCH', body: values,
      headers: { Prefer: 'return=representation' }
    });
  }
};
