import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../services/data';
import { useAsyncData } from '../hooks/useAsyncData';

export default function AuthGate({ children }) {
  const [session, setSession] = useState(supabase.getSession());
  const [credentials, setCredentials] = useState({ email: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const profileState = useAsyncData(getCurrentProfile, [session?.access_token]);

  async function signIn(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const nextSession = await supabase.signInWithPassword(credentials.email, credentials.password);
      setSession(nextSession);
    } catch (err) {
      setError(err.message || 'Não foi possível entrar.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!supabase.configured()) return <div className="notice">Configure as variáveis públicas do Supabase para usar o painel.</div>;

  if (!session) {
    return (
      <main className="auth-page"><section className="auth-card">
        <h1>CEC · Matrícula Inteligente</h1>
        <p>Entre com a conta da equipe para acessar dados reais da campanha.</p>
        <form onSubmit={signIn} className="auth-form">
          <label>E-mail<input type="email" required value={credentials.email} onChange={(e) => setCredentials({ ...credentials, email: e.target.value })} /></label>
          <label>Senha<input type="password" required value={credentials.password} onChange={(e) => setCredentials({ ...credentials, password: e.target.value })} /></label>
          {error ? <div className="notice">{error}</div> : null}
          <button className="btn btn--primary" type="submit" disabled={submitting}>{submitting ? 'Entrando…' : 'Entrar no painel'}</button>
        </form>
      </section></main>
    );
  }

  if (profileState.loading) return <div className="notice">Validando acesso da equipe…</div>;
  // Sessão vencida (a renovação falhou e apagou o login): volta para a tela de
  // entrar em vez de mostrar "acesso pendente".
  if (!supabase.getSession()) {
    setTimeout(() => setSession(null), 0);
    return <div className="notice">Sua sessão expirou. Entre novamente…</div>;
  }
  if (profileState.error || !profileState.data?.active) {
    return <main className="auth-page"><section className="auth-card">
      <h1>Acesso pendente</h1>
      <p>Esta conta ainda não tem um perfil de equipe ativo. Peça a um administrador para liberá-la.</p>
      <button className="btn" type="button" onClick={async () => { await supabase.signOut(); setSession(null); }}>Sair</button>
    </section></main>;
  }
  return children;
}
