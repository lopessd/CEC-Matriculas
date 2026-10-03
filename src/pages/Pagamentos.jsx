import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import FamilyPayments from '../components/FamilyPayments';
import { AsaasBadge } from '../components/ui';
import { asaasAdmin, getInstallmentList } from '../services/data';
import { date as formatDate, money } from '../lib/format';
import { METHOD_LABEL, fold, formatPhoneView, timeAgo, todayIso, useSort } from '../lib/journey';

/* Pagamentos por família: cada linha soma as parcelas de todos os filhos; ao
   abrir, aparecem as cobranças com baixa, vínculo e atalhos do Asaas. O botão
   de sincronizar consulta cada cobrança no Asaas (cobre webhook perdido). */

const SITUATIONS = [
  ['todas', 'Todas'],
  ['aberto', 'Em aberto'],
  ['vencido', 'Com vencida'],
  ['quitado', 'Quitadas'],
  ['sem_cobranca', 'Sem cobrança no Asaas'],
  ['conferir', 'Pago só no painel'],
  ['sem_cliente', 'Sem cadastro no Asaas']
];

function summarize(rows) {
  const families = new Map();
  for (const row of rows) {
    if (!families.has(row.guardian_id)) families.set(row.guardian_id, { guardian_id: row.guardian_id, guardian_name: row.guardian_name, guardian_phone: row.guardian_phone, customerId: row.asaas_customer_id || null, rows: [] });
    families.get(row.guardian_id).rows.push(row);
  }
  const today = todayIso();
  return [...families.values()].map((family) => {
    const active = family.rows.filter((row) => row.status !== 'cancelado');
    const open = active.filter((row) => ['pendente', 'vencido'].includes(row.status));
    const paid = active.filter((row) => row.status === 'pago');
    const next = open.map((row) => row.due_date).sort()[0] || null;
    const overdue = open.filter((row) => row.status === 'vencido' || row.due_date < today);
    const methods = [...new Set(active.map((row) => row.method).filter(Boolean))];
    return {
      ...family,
      students: [...new Set(active.map((row) => row.student_name))],
      total: active.reduce((sum, row) => sum + row.amount_cents, 0),
      openCents: open.reduce((sum, row) => sum + row.amount_cents, 0),
      paidCents: paid.reduce((sum, row) => sum + Number(row.paid_amount_cents ?? row.amount_cents), 0),
      count: active.length,
      paidCount: paid.length,
      overdueCount: overdue.length,
      next,
      methods,
      linked: active.filter((row) => row.provider_charge_id).length,
      manualOnly: paid.filter((row) => row.paid_source === 'manual' && row.provider_charge_id).length,
      plan: active[0]?.payment_plan_name || null,
      kind: active[0]?.campaign_kind || null,
      synced: active.map((row) => row.asaas_synced_at).filter(Boolean).sort().pop() || null
    };
  });
}

function situationOf(family) {
  if (!family.count) return 'vazio';
  if (family.paidCount === family.count) return 'quitado';
  if (family.overdueCount) return 'vencido';
  return 'aberto';
}

const SITUATION_VIEW = {
  quitado: ['Quitado', 'ok'],
  vencido: ['Vencida', 'warn'],
  aberto: ['Em dia', 'mute'],
  vazio: ['Sem parcelas', 'mute']
};

function CustomerAction({ family, onDone }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (family.customerId) return <span className="meta">Cliente no Asaas: {family.customerId}</span>;
  async function create() {
    setBusy(true); setMessage('');
    try {
      const result = await asaasAdmin('customer', { guardian_id: family.guardian_id });
      setMessage(result.origin === 'criado' ? 'Cliente criado no Asaas.' : 'Cliente já existia no Asaas (achado pelo CPF) e foi vinculado.');
      await onDone();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  return (
    <span className="customer-action">
      {message ? <span className="meta">{message}</span> : <span className="meta">Sem cadastro no Asaas.</span>}
      <button type="button" className="btn btn--ghost" disabled={busy} onClick={create}>{busy ? 'Criando…' : 'Criar / vincular cliente no Asaas'}</button>
    </span>
  );
}

function SyncReport({ report, onClose }) {
  const changes = report.families.flatMap((family) => family.changes.map((change) => ({ ...change, family: family.guardian_name })));
  const unmatched = report.families.filter((family) => family.unmatched_payments.length);
  const missing = report.families.filter((family) => !family.customer_id && !family.errors.length);
  const errors = report.families.filter((family) => family.errors.length);
  const label = { pago: 'marcada como recebida', vencido: 'vencida', pendente: 'voltou para em aberto', estornado: 'estornada', vinculada: 'vinculada à cobrança', desvinculada: 'cobrança apagada no Asaas — desvinculada', conflito: 'recebida só no painel; no Asaas segue em aberto' };
  return (
    <section className="card sync-report">
      <div className="sync-report-head">
        <div>
          <div className="card-title">Sincronização com o Asaas</div>
          <div className="card-sub">{report.families.length} famílias conferidas · {report.environment === 'sandbox' ? 'ambiente de testes (sandbox)' : 'produção'} · {timeAgo(report.synced_at)}</div>
        </div>
        <button type="button" className="btn btn--ghost" onClick={onClose}>Fechar</button>
      </div>
      <div className="sync-report-grid">
        <div><strong>{report.changed}</strong><span>parcelas atualizadas</span></div>
        <div><strong>{report.unmatched}</strong><span>cobranças sem parcela</span></div>
        <div><strong>{missing.length}</strong><span>famílias sem cliente no Asaas</span></div>
        <div className={report.errors ? 'is-bad' : ''}><strong>{report.errors}</strong><span>erros</span></div>
      </div>
      {changes.length ? <ul className="sync-report-list">{changes.map((change, index) => <li key={`${change.installment_id}-${index}`} className={change.action === 'conflito' ? 'is-warn' : ''}><strong>{change.family}</strong> · {change.student} · parcela {change.number}: {label[change.action] || change.action}</li>)}</ul> : <p className="meta">Nenhuma parcela mudou: o banco já estava igual ao Asaas.</p>}
      {unmatched.length ? (
        <div className="sync-report-block">
          <h3>Cobranças no Asaas que não bateram com nenhuma parcela</h3>
          <p className="meta">Abra a família abaixo e use “Vincular cobrança do Asaas” na parcela certa.</p>
          <ul className="sync-report-list">{unmatched.map((family) => <li key={family.guardian_id}><strong>{family.guardian_name}</strong>: {family.unmatched_payments.map((payment) => `${money(payment.value_cents)} (${payment.status.toLowerCase()}, vence ${formatDate(payment.due_date)})`).join(' · ')}</li>)}</ul>
        </div>
      ) : null}
      {errors.length ? <div className="sync-report-block"><h3>Erros</h3><ul className="sync-report-list">{errors.map((family) => <li key={family.guardian_id} className="is-warn"><strong>{family.guardian_name}</strong>: {family.errors.map((error) => error.message).join('; ')}</li>)}</ul></div> : null}
    </section>
  );
}

export default function Pagamentos() {
  const [state, setState] = useState({ loading: true, error: null, rows: [] });
  const [asaas, setAsaas] = useState(null);
  const [report, setReport] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [search, setSearch] = useState('');
  const [situation, setSituation] = useState('todas');
  const [method, setMethod] = useState('');
  const [month, setMonth] = useState('');
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const rows = await getInstallmentList();
      setState({ loading: false, error: null, rows: rows || [] });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { asaasAdmin('status').then(setAsaas).catch((error) => setAsaas({ configured: false, error: error.message })); }, []);

  async function syncAll() {
    setSyncing(true); setSyncError('');
    try {
      const result = await asaasAdmin('sync');
      setReport(result);
      await load(true);
    } catch (error) {
      setSyncError(error.message || 'Não foi possível sincronizar.');
    } finally {
      setSyncing(false);
    }
  }

  const families = useMemo(() => summarize(state.rows), [state.rows]);
  const unmatchedByGuardian = useMemo(() => Object.fromEntries((report?.families || []).map((family) => [family.guardian_id, family.unmatched_payments])), [report]);
  const months = useMemo(() => [...new Set(state.rows.map((row) => row.due_date?.slice(0, 7)).filter(Boolean))].sort(), [state.rows]);
  const methods = useMemo(() => [...new Set(state.rows.map((row) => row.method).filter(Boolean))], [state.rows]);
  const term = fold(search.trim());
  const filtered = families.filter((family) => {
    if (term && !fold([family.guardian_name, ...family.students, family.guardian_phone].join(' ')).includes(term)) return false;
    if (method && !family.methods.includes(method)) return false;
    if (month && !family.rows.some((row) => row.due_date?.startsWith(month) && row.status !== 'cancelado')) return false;
    const current = situationOf(family);
    if (situation === 'aberto') return family.openCents > 0;
    if (situation === 'vencido') return current === 'vencido';
    if (situation === 'quitado') return current === 'quitado';
    if (situation === 'sem_cobranca') return family.rows.some((row) => row.status === 'pendente' && !row.provider_charge_id && row.method !== 'dinheiro');
    if (situation === 'conferir') return family.manualOnly > 0;
    if (situation === 'sem_cliente') return !family.customerId;
    return true;
  });
  const { sorted, sort, toggle } = useSort(filtered, {
    family: (family) => family.guardian_name,
    next: (family) => family.next || '9999',
    open: (family) => family.openCents,
    paid: (family) => family.paidCents,
    progress: (family) => family.paidCount / Math.max(family.count, 1)
  }, { key: 'next', dir: 'asc' });

  const active = state.rows.filter((row) => row.status !== 'cancelado');
  const today = todayIso();
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const sum = (list) => list.reduce((total, row) => total + Number(row.amount_cents || 0), 0);
  const paidRows = active.filter((row) => row.status === 'pago');
  const stats = [
    { label: 'A receber', value: money(sum(active.filter((row) => ['pendente', 'vencido'].includes(row.status)))), sub: `${active.filter((row) => ['pendente', 'vencido'].includes(row.status)).length} parcelas em aberto` },
    { label: 'Próximos 30 dias', value: money(sum(active.filter((row) => row.status === 'pendente' && row.due_date >= today && row.due_date <= in30))), sub: 'vencimentos até ' + formatDate(in30) },
    { label: 'Vencido', value: money(sum(active.filter((row) => row.status === 'vencido' || (row.status === 'pendente' && row.due_date < today)))), sub: 'precisa de contato', tone: 'warn' },
    { label: 'Recebido', value: money(paidRows.reduce((total, row) => total + Number(row.paid_amount_cents ?? row.amount_cents), 0)), sub: `${paidRows.filter((row) => row.paid_source === 'asaas').length} pelo Asaas · ${paidRows.filter((row) => row.paid_source !== 'asaas').length} na secretaria`, tone: 'ok' }
  ];
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '');

  return (
    <div className="ops">
      <div className="asaas-bar">
        <div className="asaas-bar-status">
          <span className={`dot ${asaas?.configured && !asaas?.error ? 'dot-green' : 'dot-idle'}`} />
          {asaas == null ? 'Conferindo o Asaas…'
            : !asaas.configured ? 'Asaas sem chave configurada no servidor'
              : asaas.error ? `Asaas respondeu com erro: ${asaas.error}`
                : <>Asaas conectado · {asaas.environment === 'sandbox' ? 'sandbox (testes)' : 'produção'}{asaas.balance_cents != null ? <> · saldo <strong>{money(asaas.balance_cents)}</strong></> : null}</>}
        </div>
        <div className="asaas-bar-actions">
          <Link className="btn btn--ghost" to="/financeiro/extrato">Extrato e caixa →</Link>
          <button type="button" className="btn btn--primary" onClick={syncAll} disabled={syncing || !asaas?.configured}>{syncing ? 'Sincronizando cada cobrança…' : 'Sincronizar com o Asaas'}</button>
        </div>
      </div>
      {syncError ? <div className="notice"><span>{syncError}</span></div> : null}
      {report ? <SyncReport report={report} onClose={() => setReport(null)} /> : null}

      <div className="dz-stats">
        {stats.map((stat) => (
          <div key={stat.label} className={`dz-stat${stat.tone ? ` tone-${stat.tone}` : ''}`}>
            <span className="dz-stat-label">{stat.label}</span>
            <span className="dz-stat-value">{stat.value}</span>
            <span className="dz-stat-sub">{stat.sub}</span>
          </div>
        ))}
      </div>

      <div className="ops-toolbar">
        <input className="control ops-search" type="search" placeholder="Buscar responsável, aluno ou telefone" value={search} onChange={(event) => setSearch(event.target.value)} />
        <select className="control ops-select" value={situation} onChange={(event) => setSituation(event.target.value)}>
          {SITUATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select className="control ops-select" value={method} onChange={(event) => setMethod(event.target.value)}>
          <option value="">Todas as formas</option>
          {methods.map((value) => <option key={value} value={value}>{METHOD_LABEL[value] || value}</option>)}
        </select>
        <select className="control ops-select" value={month} onChange={(event) => setMonth(event.target.value)}>
          <option value="">Todos os vencimentos</option>
          {months.map((value) => <option key={value} value={value}>{new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(`${value}-15T12:00:00`))}</option>)}
        </select>
        <span className="ops-count">{sorted.length} de {families.length} famílias</span>
      </div>

      {state.error ? <div className="notice"><strong>Não foi possível carregar.</strong><span>{state.error}</span></div> : null}
      {state.loading && !state.rows.length ? <div className="notice">Carregando pagamentos…</div> : null}

      {!state.loading || state.rows.length ? (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th><button type="button" onClick={() => toggle('family')}>Família{arrow('family')}</button></th>
                <th>Plano · forma</th>
                <th><button type="button" onClick={() => toggle('progress')}>Parcelas{arrow('progress')}</button></th>
                <th className="num"><button type="button" onClick={() => toggle('paid')}>Recebido{arrow('paid')}</button></th>
                <th className="num"><button type="button" onClick={() => toggle('open')}>Em aberto{arrow('open')}</button></th>
                <th><button type="button" onClick={() => toggle('next')}>Próximo vencimento{arrow('next')}</button></th>
                <th>Situação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((family) => {
                const [label, tone] = SITUATION_VIEW[situationOf(family)];
                const isOpen = openId === family.guardian_id;
                return [
                  <tr key={family.guardian_id} className={`ops-row${isOpen ? ' is-open' : ''}`} onClick={() => setOpenId(isOpen ? null : family.guardian_id)}>
                    <td>
                      <div className="cell-stack">
                        <strong className="cell-strong">{family.guardian_name}<AsaasBadge customerId={family.customerId} /></strong>
                        <span>{family.students.join(', ')}</span>
                      </div>
                    </td>
                    <td className="cell is-dim">{family.plan ? family.plan.split(' — ')[0] : '—'}{family.methods.length ? ` · ${family.methods.map((value) => METHOD_LABEL[value] || value).join(', ')}` : ''}</td>
                    <td>
                      <div className="ops-progress" title={`${family.paidCount} de ${family.count} pagas`}>
                        <i style={{ width: `${(family.paidCount / Math.max(family.count, 1)) * 100}%` }} />
                      </div>
                      <span className="meta">{family.paidCount}/{family.count} pagas{family.linked < family.count ? ` · ${family.count - family.linked} sem Asaas` : ''}</span>
                    </td>
                    <td className="num cell">{money(family.paidCents)}</td>
                    <td className="num cell-strong">{family.openCents ? money(family.openCents) : '—'}</td>
                    <td className="cell">{family.next ? formatDate(family.next) : '—'}</td>
                    <td><span className={`fp-status fp-status--${tone}`}>{label}</span>{family.manualOnly ? <span className="fp-flag" title="Recebido no painel mas em aberto no Asaas">conferir</span> : null}</td>
                    <td className="ops-open">{isOpen ? 'Fechar ▴' : 'Abrir ▾'}</td>
                  </tr>,
                  isOpen ? (
                    <tr key={`${family.guardian_id}-detail`} className="ops-detail">
                      <td colSpan={8}>
                        <div className="ops-detail-head">
                          <span>{formatPhoneView(family.guardian_phone)}</span>
                          <CustomerAction family={family} onDone={() => load(true)} />
                          <Link className="btn btn--ghost" to={`/familias/${family.guardian_id}?aba=financeiro`}>Ficha da família →</Link>
                        </div>
                        <FamilyPayments key={report?.synced_at || 'base'} rows={family.rows} guardianId={family.guardian_id} unmatched={unmatchedByGuardian[family.guardian_id]} onChanged={() => load(true)} />
                      </td>
                    </tr>
                  ) : null
                ];
              })}
            </tbody>
          </table>
          {!sorted.length ? <div className="ops-empty">{families.length ? 'Nenhuma família com esses filtros.' : 'Ainda não há parcelas: elas nascem quando o contrato é assinado.'}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
