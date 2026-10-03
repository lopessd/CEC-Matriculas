import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { addCashMovement, asaasAdmin, getFinanceLedger } from '../services/data';
import { date as formatDate, dateTime, money } from '../lib/format';
import { METHOD_LABEL, downloadCsv, fold, inputToCents, todayIso } from '../lib/journey';

/* Extrato e caixa: o que entrou e saiu na conta do Asaas (extrato e saques) e
   o registro interno do painel — baixas manuais, estornos, vínculos e o caixa
   físico (dinheiro recebido na secretaria, saídas e depósitos no banco). */

const TABS = [['asaas', 'Extrato do Asaas'], ['interno', 'Registro do painel'], ['caixa', 'Caixa físico']];

const TX_TYPE = {
  PAYMENT_RECEIVED: 'Cobrança recebida', PAYMENT_FEE: 'Taxa da cobrança', TRANSFER: 'Transferência (saque)', TRANSFER_FEE: 'Taxa de transferência',
  TRANSFER_REVERSAL: 'Transferência devolvida', PAYMENT_REVERSAL: 'Estorno de cobrança', PAYMENT_REFUND_CANCELLED: 'Estorno cancelado',
  NOTIFICATION_FEE: 'Taxa de notificação', PIX_TRANSACTION_DEBIT: 'Pix enviado', PIX_TRANSACTION_CREDIT: 'Pix recebido',
  CREDIT_CARD_RECEIVABLE_ANTICIPATION: 'Antecipação', INTERNAL_TRANSFER_CREDIT: 'Transferência recebida', INTERNAL_TRANSFER_DEBIT: 'Transferência enviada',
  BILL_PAYMENT: 'Pagamento de conta', PAYMENT_CUSTODY_BLOCK: 'Bloqueio', PAYMENT_CUSTODY_BLOCK_REVERSAL: 'Desbloqueio'
};
const TRANSFER_STATUS = { PENDING: 'pendente', BANK_PROCESSING: 'processando', DONE: 'concluído', CANCELLED: 'cancelado', FAILED: 'falhou' };
const KIND = {
  recebimento: 'Recebimento', estorno: 'Recebimento desfeito', status: 'Status alterado', vinculo: 'Vínculo com o Asaas',
  caixa_entrada: 'Entrada no caixa', caixa_saida: 'Saída do caixa', caixa_deposito: 'Depósito no banco', ajuste: 'Ajuste de caixa'
};
const SOURCE = { manual: 'Secretaria', asaas: 'Asaas (webhook)', asaas_sync: 'Sincronização Asaas', asaas_webhook: 'Asaas (webhook)', sistema: 'Sistema' };

const firstOfMonth = () => `${todayIso().slice(0, 8)}01`;

function Period({ start, finish, onChange }) {
  const presets = [
    ['Este mês', firstOfMonth(), todayIso()],
    ['30 dias', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), todayIso()],
    ['90 dias', new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), todayIso()]
  ];
  return (
    <div className="ops-period">
      {presets.map(([label, from, to]) => <button key={label} type="button" className={`chip${start === from && finish === to ? ' is-active' : ''}`} onClick={() => onChange(from, to)}>{label}</button>)}
      <input className="control" type="date" value={start} max={finish} onChange={(event) => onChange(event.target.value, finish)} />
      <span className="meta">até</span>
      <input className="control" type="date" value={finish} min={start} max={todayIso()} onChange={(event) => onChange(start, event.target.value)} />
    </div>
  );
}

function AsaasStatement({ start, finish }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [search, setSearch] = useState('');
  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await asaasAdmin('statement', { start, finish }) });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, [start, finish]);
  useEffect(() => { load(); }, [load]);
  const data = state.data;
  const term = fold(search);
  const transactions = (data?.transactions || []).filter((item) => !term || fold(`${item.description} ${TX_TYPE[item.type] || item.type}`).includes(term));
  const credits = (data?.transactions || []).filter((item) => item.value_cents > 0).reduce((sum, item) => sum + item.value_cents, 0);
  const debits = (data?.transactions || []).filter((item) => item.value_cents < 0).reduce((sum, item) => sum + item.value_cents, 0);
  const withdrawn = (data?.transfers || []).filter((item) => item.status !== 'CANCELLED' && item.status !== 'FAILED').reduce((sum, item) => sum + item.value_cents, 0);

  if (state.error) return <div className="notice"><strong>Não foi possível ler o Asaas.</strong><span>{state.error}</span></div>;
  return (
    <>
      <div className="dz-stats">
        <div className="dz-stat tone-ok"><span className="dz-stat-label">Saldo disponível</span><span className="dz-stat-value">{data?.balance_cents != null ? money(data.balance_cents) : '—'}</span><span className="dz-stat-sub">{data ? (data.environment === 'sandbox' ? 'sandbox (testes)' : 'conta de produção') : 'carregando…'}</span></div>
        <div className="dz-stat"><span className="dz-stat-label">Entradas no período</span><span className="dz-stat-value">{money(credits)}</span><span className="dz-stat-sub">cobranças e créditos</span></div>
        <div className="dz-stat"><span className="dz-stat-label">Saídas no período</span><span className="dz-stat-value">{money(Math.abs(debits))}</span><span className="dz-stat-sub">taxas, estornos e saques</span></div>
        <div className="dz-stat"><span className="dz-stat-label">Saques</span><span className="dz-stat-value">{money(withdrawn)}</span><span className="dz-stat-sub">{(data?.transfers || []).length} transferência(s)</span></div>
      </div>

      <section className="card">
        <div className="card-head">
          <div><div className="card-title">Movimentações da conta</div><div className="card-sub">Extrato do Asaas de {formatDate(start)} a {formatDate(finish)}{data?.has_more ? ' · mostrando as 100 mais recentes' : ''}</div></div>
          <div className="ops-inline">
            <input className="control ops-search" type="search" placeholder="Filtrar descrição" value={search} onChange={(event) => setSearch(event.target.value)} />
            <button type="button" className="btn" disabled={!transactions.length} onClick={() => downloadCsv(`extrato-asaas-${start}-a-${finish}.csv`, ['Data', 'Tipo', 'Descrição', 'Valor', 'Saldo'], transactions.map((item) => [item.date, TX_TYPE[item.type] || item.type, item.description, (item.value_cents / 100).toFixed(2).replace('.', ','), (item.balance_cents / 100).toFixed(2).replace('.', ',')]))}>Baixar CSV</button>
          </div>
        </div>
        {state.loading ? <div className="meta">Carregando o extrato…</div> : (
          <div className="ops-table-wrap is-flat">
            <table className="ops-table">
              <thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th className="num">Valor</th><th className="num">Saldo</th></tr></thead>
              <tbody>
                {transactions.map((item) => (
                  <tr key={item.id}>
                    <td className="cell">{formatDate(item.date)}</td>
                    <td className="cell">{TX_TYPE[item.type] || item.type}</td>
                    <td className="cell is-dim">{item.description}</td>
                    <td className={`num cell-strong ${item.value_cents < 0 ? 'is-negative' : 'is-positive'}`}>{money(item.value_cents)}</td>
                    <td className="num cell is-dim">{money(item.balance_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!transactions.length ? <div className="ops-empty">Nenhuma movimentação no período.</div> : null}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head"><div><div className="card-title">Saques e transferências</div><div className="card-sub">Dinheiro que saiu do Asaas para a conta da escola</div></div></div>
        {(data?.transfers || []).length ? (
          <div className="ops-table-wrap is-flat">
            <table className="ops-table">
              <thead><tr><th>Data</th><th>Destino</th><th>Status</th><th className="num">Valor</th><th className="num">Taxa</th></tr></thead>
              <tbody>{data.transfers.map((item) => <tr key={item.id}><td className="cell">{formatDate(String(item.date || '').slice(0, 10))}</td><td className="cell">{item.bank || item.pix_key || item.description || item.type}</td><td className="cell">{TRANSFER_STATUS[item.status] || item.status}</td><td className="num cell-strong">{money(item.value_cents)}</td><td className="num cell is-dim">{money(item.fee_cents)}</td></tr>)}</tbody>
            </table>
          </div>
        ) : <div className="meta">{state.loading ? 'Carregando…' : 'Nenhum saque no período.'}</div>}
      </section>
    </>
  );
}

function Ledger({ start, finish, cashOnly, reloadKey }) {
  const [state, setState] = useState({ loading: true, error: null, rows: [] });
  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    let alive = true;
    setState((current) => ({ ...current, loading: true }));
    getFinanceLedger({ from: start, to: finish })
      .then((rows) => { if (alive) setState({ loading: false, error: null, rows: rows || [] }); })
      .catch((error) => { if (alive) setState({ loading: false, error: error.message, rows: [] }); });
    return () => { alive = false; };
  }, [start, finish, reloadKey]);

  const cashRow = (row) => row.kind.startsWith('caixa_') || row.kind === 'ajuste' || (row.method === 'dinheiro' && ['recebimento', 'estorno'].includes(row.kind));
  const term = fold(search);
  const rows = useMemo(() => state.rows.filter((row) =>
    (!cashOnly || cashRow(row)) &&
    (!kind || row.kind === kind) &&
    (!source || row.source === source) &&
    (!term || fold([row.guardian_name, row.student_name, row.description, row.actor_name, row.provider_charge_id].join(' ')).includes(term))
  ), [state.rows, cashOnly, kind, source, term]);

  // Caixa: dinheiro recebido entra, desfeito sai; saídas e depósitos saem.
  const signed = (row) => {
    const value = Number(row.amount_cents || 0);
    if (['caixa_saida', 'caixa_deposito', 'estorno'].includes(row.kind)) return -value;
    if (['recebimento', 'caixa_entrada', 'ajuste'].includes(row.kind)) return value;
    return 0;
  };
  const cash = state.rows.filter(cashRow);
  const cashIn = cash.filter((row) => signed(row) > 0).reduce((sum, row) => sum + signed(row), 0);
  const cashOut = cash.filter((row) => signed(row) < 0).reduce((sum, row) => sum + signed(row), 0);
  const manual = state.rows.filter((row) => row.kind === 'recebimento' && row.source === 'manual');

  return (
    <>
      {cashOnly ? (
        <div className="dz-stats">
          <div className="dz-stat"><span className="dz-stat-label">Entrou em dinheiro</span><span className="dz-stat-value">{money(cashIn)}</span><span className="dz-stat-sub">recebimentos e entradas</span></div>
          <div className="dz-stat"><span className="dz-stat-label">Saiu do caixa</span><span className="dz-stat-value">{money(Math.abs(cashOut))}</span><span className="dz-stat-sub">saídas e depósitos</span></div>
          <div className="dz-stat tone-ok"><span className="dz-stat-label">Saldo do período</span><span className="dz-stat-value">{money(cashIn + cashOut)}</span><span className="dz-stat-sub">deveria estar na gaveta / depositado</span></div>
        </div>
      ) : (
        <div className="dz-stats">
          <div className="dz-stat"><span className="dz-stat-label">Baixas manuais</span><span className="dz-stat-value">{manual.length}</span><span className="dz-stat-sub">{money(manual.reduce((sum, row) => sum + Number(row.amount_cents || 0), 0))} marcados pela secretaria</span></div>
          <div className="dz-stat"><span className="dz-stat-label">Pelo Asaas</span><span className="dz-stat-value">{state.rows.filter((row) => row.kind === 'recebimento' && row.source !== 'manual').length}</span><span className="dz-stat-sub">webhook ou sincronização</span></div>
          <div className="dz-stat tone-warn"><span className="dz-stat-label">Desfeitos</span><span className="dz-stat-value">{state.rows.filter((row) => row.kind === 'estorno').length}</span><span className="dz-stat-sub">recebimentos voltados para em aberto</span></div>
          <div className="dz-stat"><span className="dz-stat-label">Vínculos</span><span className="dz-stat-value">{state.rows.filter((row) => row.kind === 'vinculo').length}</span><span className="dz-stat-sub">cobranças ligadas/desligadas</span></div>
        </div>
      )}
      <section className="card">
        <div className="card-head">
          <div><div className="card-title">{cashOnly ? 'Movimentos do caixa' : 'Tudo que aconteceu no financeiro'}</div><div className="card-sub">Cada linha diz quem fez, quando e de onde veio</div></div>
          <div className="ops-inline">
            <input className="control ops-search" type="search" placeholder="Família, aluno, descrição" value={search} onChange={(event) => setSearch(event.target.value)} />
            {!cashOnly ? <select className="control ops-select" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">Todos os tipos</option>{Object.entries(KIND).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : null}
            {!cashOnly ? <select className="control ops-select" value={source} onChange={(event) => setSource(event.target.value)}><option value="">Todas as origens</option>{Object.entries(SOURCE).filter(([value]) => value !== 'asaas_webhook').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : null}
            <button type="button" className="btn" disabled={!rows.length} onClick={() => downloadCsv(`${cashOnly ? 'caixa' : 'registro-financeiro'}-${start}-a-${finish}.csv`, ['Data', 'Tipo', 'Origem', 'Família', 'Aluno', 'Parcela', 'Forma', 'Valor', 'Descrição', 'Por'], rows.map((row) => [dateTime(row.occurred_at), KIND[row.kind] || row.kind, SOURCE[row.source] || row.source, row.guardian_name || '', row.student_name || '', row.installment_number || '', METHOD_LABEL[row.method] || row.method || '', (Number(row.amount_cents || 0) / 100).toFixed(2).replace('.', ','), row.description || '', row.actor_name || '']))}>Baixar CSV</button>
          </div>
        </div>
        {state.error ? <div className="notice"><span>{state.error}</span></div> : null}
        {state.loading ? <div className="meta">Carregando…</div> : (
          <div className="ops-table-wrap is-flat">
            <table className="ops-table">
              <thead><tr><th>Quando</th><th>O quê</th><th>Família · aluno</th><th>Origem</th><th className="num">Valor</th><th>Por</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="cell">{dateTime(row.occurred_at)}</td>
                    <td>
                      <div className="cell-stack">
                        <strong className="cell">{KIND[row.kind] || row.kind}{row.method ? ` · ${METHOD_LABEL[row.method] || row.method}` : ''}</strong>
                        <span>{row.description || (row.installment_number ? `Parcela ${row.installment_number}${row.due_date ? ` · vence ${formatDate(row.due_date)}` : ''}` : '')}{row.from_status && row.to_status && row.kind === 'status' ? ` · ${row.from_status} → ${row.to_status}` : ''}</span>
                      </div>
                    </td>
                    <td>
                      {row.guardian_id ? <Link className="cell" to={`/familias/${row.guardian_id}?aba=financeiro`}>{row.guardian_name}</Link> : <span className="cell is-dim">—</span>}
                      {row.student_name ? <div className="meta">{row.student_name}</div> : null}
                    </td>
                    <td className="cell is-dim">{SOURCE[row.source] || row.source}</td>
                    <td className={`num cell-strong ${cashOnly && signed(row) < 0 ? 'is-negative' : ''}`}>{row.amount_cents != null ? money(cashOnly ? signed(row) : row.amount_cents) : '—'}</td>
                    <td className="cell is-dim">{row.actor_name || (row.source === 'manual' ? 'Equipe' : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length ? <div className="ops-empty">Nada registrado no período.</div> : null}
          </div>
        )}
      </section>
    </>
  );
}

function CashForm({ onSaved }) {
  const [form, setForm] = useState({ kind: 'caixa_deposito', amount: '', description: '', occurredOn: todayIso() });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      await addCashMovement({ kind: form.kind, amountCents: inputToCents(form.amount), description: form.description, occurredOn: form.occurredOn });
      setForm((current) => ({ ...current, amount: '', description: '' }));
      setMessage('Movimento registrado.');
      onSaved();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  return (
    <form className="card cash-form" onSubmit={submit}>
      <div className="card-title">Lançar no caixa</div>
      <div className="card-sub">Dinheiro recebido de parcela entra sozinho quando a parcela é marcada como recebida em dinheiro. Aqui vão os outros movimentos.</div>
      <div className="cash-form-grid">
        <label className="field"><span className="cash-label">Tipo</span><select className="control" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}><option value="caixa_deposito">Depósito no banco</option><option value="caixa_saida">Saída (despesa, troco)</option><option value="caixa_entrada">Entrada avulsa</option><option value="ajuste">Ajuste de conferência</option></select></label>
        <label className="field"><span className="cash-label">Valor (R$)</span><input className="control" inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="0,00" required /></label>
        <label className="field"><span className="cash-label">Data</span><input className="control" type="date" value={form.occurredOn} max={todayIso()} onChange={(event) => setForm({ ...form, occurredOn: event.target.value })} /></label>
        <label className="field cash-form-wide"><span className="cash-label">Descrição</span><input className="control" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Ex.: depósito no Banco do Brasil, envelope da semana" required /></label>
      </div>
      <div className="cash-form-foot">{message ? <span className="meta">{message}</span> : <span />}<button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Salvando…' : 'Registrar'}</button></div>
    </form>
  );
}

export default function Extrato() {
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('cec.extrato.tab') || 'asaas'; } catch { return 'asaas'; }
  });
  const [period, setPeriod] = useState({ start: firstOfMonth(), finish: todayIso() });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => { try { localStorage.setItem('cec.extrato.tab', tab); } catch { /* sem storage */ } }, [tab]);
  return (
    <div className="ops">
      <div className="ops-toolbar">
        <div className="segmented" role="tablist">
          {TABS.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'is-active' : ''} onClick={() => setTab(value)}>{label}</button>)}
        </div>
        <Period start={period.start} finish={period.finish} onChange={(start, finish) => setPeriod({ start, finish })} />
      </div>
      {tab === 'asaas' ? <AsaasStatement start={period.start} finish={period.finish} /> : null}
      {tab === 'interno' ? <Ledger start={period.start} finish={period.finish} reloadKey={reloadKey} /> : null}
      {tab === 'caixa' ? <><CashForm onSaved={() => setReloadKey((value) => value + 1)} /><Ledger start={period.start} finish={period.finish} cashOnly reloadKey={reloadKey} /></> : null}
    </div>
  );
}
