const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const storageKey = 'cec.supabase.session';
export const SESSION_EXPIRED_EVENT = 'cec:session-expired';

function getStoredSession() {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || 'null');
  } catch {
    return null;
  }
}

function saveSession(session) {
  if (session) {
    // O vencimento é contado pelo relógio deste computador (`expires_in`), não
    // pelo `expires_at` do servidor: num PC com relógio atrasado o token
    // parecia válido, nunca era renovado e tudo voltava 401 ("JWT expired").
    const localExpiresAt = session.expires_in ? Math.floor(Date.now() / 1000) + Number(session.expires_in) : session.local_expires_at;
    localStorage.setItem(storageKey, JSON.stringify({ ...session, local_expires_at: localExpiresAt }));
  } else localStorage.removeItem(storageKey);
}

function expireSession() {
  saveSession(null);
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

function configured() {
  return Boolean(url && key);
}

function isFresh(session) {
  const expiresAt = session?.local_expires_at || session?.expires_at;
  return Boolean(expiresAt && expiresAt * 1000 > Date.now() + 60_000);
}

// Uma renovação por vez: várias telas pedindo dados juntas renovavam o mesmo
// refresh token em paralelo, e o Supabase revoga o token reaproveitado.
let refreshing = null;

async function refreshSession(stale) {
  if (!refreshing) {
    refreshing = (async () => {
      // Outra aba pode já ter renovado.
      const latest = getStoredSession();
      if (latest?.access_token && latest.access_token !== stale?.access_token && isFresh(latest)) return latest;
      const refreshToken = latest?.refresh_token || stale?.refresh_token;
      if (!refreshToken) return null;
      const response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      }).catch(() => null);
      if (!response) throw new Error('Sem conexão com o Supabase.');
      if (!response.ok) { expireSession(); return null; }
      const refreshed = await response.json();
      saveSession(refreshed);
      return getStoredSession();
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function currentSession() {
  const session = getStoredSession();
  if (!session?.refresh_token || isFresh(session)) return session;
  return refreshSession(session);
}

async function send(path, { method, body, headers }, session) {
  return fetch(`${url}/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${session?.access_token || key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  if (!configured()) throw new Error('Supabase não foi configurado neste ambiente.');
  // Login manda a própria chave: não mexe na sessão guardada.
  let session = headers.Authorization ? null : await currentSession();
  let response = await send(path, { method, body, headers }, session);
  // Token recusado (vencido ou revogado): renova uma vez e tenta de novo.
  if (response.status === 401 && session?.refresh_token && !headers.Authorization) {
    session = await refreshSession(session);
    if (!session) throw new Error('Sua sessão expirou. Entre novamente.');
    response = await send(path, { method, body, headers }, session);
  }
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
      // scope=local: a equipe divide a mesma conta, e o "Sair" global
      // derrubava o login dos outros computadores.
      await request('auth/v1/logout?scope=local', { method: 'POST' }).catch(() => null);
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
