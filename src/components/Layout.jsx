import { useEffect, useState } from 'react';
import { NavLink, Outlet, matchPath, useLocation } from 'react-router-dom';
import { FamilyHeaderContext } from '../contexts/FamilyHeaderContext';
import Icon from './Icon';
import cecLogo from '../assets/cec-logo.png';
import { getWhatsappPulse } from '../services/data';

const navigation = [
  { section: 'Operação' },
  { path: '/jornadas', label: 'Jornadas', icon: 'board', dot: '#F07E26' },
  { path: '/follow-up', label: 'Follow-up (teste)', icon: 'sparkle', dot: '#C0392B' },
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', dot: '#E4581C' },
  { path: '/familias', label: 'Famílias', icon: 'families', dot: '#3AA757' },
  { path: '/matriculados', label: 'Matriculados', icon: 'enrolled', dot: '#3AA757' },
  { path: '/assinaturas', label: 'Assinaturas', icon: 'signature', dot: '#3AA757' },
  { section: 'Financeiro' },
  { path: '/pagamentos', label: 'Pagamentos', icon: 'payment', dot: '#3A82C7' },
  { path: '/financeiro/extrato', label: 'Extrato e caixa', icon: 'ledger', dot: '#3A82C7' },
  { section: 'Sistema' },
  { path: '/configuracoes', label: 'Configurações', icon: 'settings', dot: '#A8B8E0' }
];

const heads = {
  '/jornadas': ['Campanha 2027', 'Jornadas das famílias'],
  '/follow-up': ['Teste · WhatsApp', 'Follow-up das conversas'],
  '/dashboard': ['Campanha 2027', 'Visão geral da operação'],
  '/familias': ['Campanha 2027', 'Famílias'],
  '/matriculados': ['Resultado da campanha', 'Matriculados'],
  '/assinaturas': ['Contratos', 'Assinaturas'],
  '/pagamentos': ['Financeiro', 'Pagamentos'],
  '/financeiro/extrato': ['Financeiro', 'Extrato do Asaas e caixa'],
  '/configuracoes': ['Cadastros da campanha', 'Configurações'],
  '/rematricula': ['Jornada online do responsável', 'Página individual de rematrícula'],
  '/matricula': ['Novas matrículas', 'Link público de pré-matrícula'],
  '/links': ['Links das famílias', 'Consultar e copiar links cadastrados']
};

const headerLinks = [
  { path: '/links', label: 'Links individuais', url: 'ver e gerenciar', icon: 'link', dot: '#F07E26' }
];

/** Migalha e título do header, derivados da rota atual. */
function headFor(pathname) {
  const fam = matchPath('/familias/:id/*', pathname) || matchPath('/familias/:id', pathname);
  if (fam) {
    return ['Famílias', 'Detalhe da família'];
  }
  return heads[pathname] || ['', ''];
}

function ago(value) {
  if (!value) return 'sem mensagens ainda';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.round(hours / 24)} dias`;
}

/** Atividade real do WhatsApp: fila de envio e última mensagem trocada. */
function WhatsappPulse() {
  const [pulse, setPulse] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => getWhatsappPulse().then((value) => { if (alive) setPulse(value); }).catch(() => {});
    load();
    const timer = window.setInterval(load, 60000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  const recent = pulse?.lastMessageAt && Date.now() - new Date(pulse.lastMessageAt).getTime() < 3 * 3600000;
  return (
    <div className="status-box">
      <div className="status-line"><span className={`dot ${recent ? 'dot-green' : 'dot-idle'}`} /> WhatsApp {recent ? 'ativo' : 'sem movimento recente'}</div>
      <p>{pulse ? <>fila: {pulse.queue} na espera<br />última mensagem {ago(pulse.lastMessageAt)}</> : 'carregando…'}</p>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src={cecLogo} alt="Centro Educacional Cristão" />
      </div>

      <nav className="nav">
        {navigation.map((item) => item.section ? <div key={item.section} className="nav-label">{item.section}</div> : (
          <NavLink
            key={item.path}
            to={item.path}
            style={{ '--accent': item.dot }}
            className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}
          >
            <span className="nav-icon" aria-hidden="true"><Icon name={item.icon} /></span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot"><WhatsappPulse /></div>
    </aside>
  );
}

function Topbar({ crumb, title }) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <div className="crumb">{crumb}</div>
        <h1>{title}</h1>
      </div>
      <div className="topbar-links">
        {headerLinks.map((l) => (
          <NavLink
            key={l.path}
            to={l.path}
            style={{ '--accent': l.dot }}
            className={({ isActive }) => `topbar-link${isActive ? ' is-active' : ''}`}
          >
            <span className="link-icon" aria-hidden="true"><Icon name={l.icon} /></span>
            <span>{l.label}</span>
            <small>{l.url}</small>
          </NavLink>
        ))}
      </div>
    </header>
  );
}

export default function Layout() {
  const { pathname } = useLocation();
  const [familyHeader, setFamilyHeader] = useState(null);
  const familyRoute = matchPath('/familias/:id/*', pathname) || matchPath('/familias/:id', pathname);
  const [fallbackCrumb, fallbackTitle] = headFor(pathname);
  const useLiveHeader = familyRoute && familyHeader?.enrollmentId === familyRoute.params.id;
  const crumb = useLiveHeader ? familyHeader.crumb : fallbackCrumb;
  const title = useLiveHeader ? familyHeader.title : fallbackTitle;

  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  useEffect(() => { document.title = title ? `${title} · CEC` : 'CEC · Matrícula Inteligente'; }, [title]);
  useEffect(() => { if (!familyRoute) setFamilyHeader(null); }, [familyRoute]);

  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <Topbar crumb={crumb} title={title} />
        <div className="body"><FamilyHeaderContext.Provider value={setFamilyHeader}><Outlet /></FamilyHeaderContext.Provider></div>
      </main>
    </div>
  );
}
