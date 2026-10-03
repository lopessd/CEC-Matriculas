import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import ContractSetup from '../components/ContractSetup';
import FamilyPayments from '../components/FamilyPayments';
import { FamilyHeaderContext } from '../contexts/FamilyHeaderContext';
import { getFamilyDetail, getPaymentPlans, getSignedContractFile, setEnrollmentPaymentPlan, setFamilyBilling } from '../services/data';
import { date as formatDate, dateTime, money } from '../lib/format';
import {
  INSTALLMENT_LABEL, KIND_LABEL, METHODS, METHOD_LABEL, contractUrl, formatCpfView, formatPhoneView,
  journeyUrl, localDay, stageInfo, timeAgo, whatsappUrl
} from '../lib/journey';

/* Ficha da família: tudo de um responsável em um lugar. Abas por assunto
   (resumo, contrato, financeiro, histórico), guardadas na URL (?aba=). */

const TABS = [['resumo', 'Resumo'], ['contrato', 'Contrato'], ['financeiro', 'Financeiro'], ['historico', 'Histórico']];
const ENROLLMENT_STATUS = {
  pre_matricula: 'Pré-matrícula', em_fila: 'Na fila', contatada: 'Contatada', conversando: 'Conversando',
  precisa_humano: 'Precisa de humano', link_enviado: 'Link enviado', link_aberto: 'Link aberto',
  formulario_iniciado: 'Preenchendo', aguardando_assinatura: 'Aguardando assinatura', aguardando_pagamento: 'Aguardando pagamento',
  pagamento_vencido: 'Pagamento vencido', concluida: 'Concluída', sem_interesse: 'Sem interesse', opt_out: 'Saiu da lista',
  fora_campanha: 'Fora da campanha'
};
const initials = (value = '') => value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '—';
const CLOSED = ['sem_interesse', 'opt_out', 'fora_campanha'];

function useCopy() {
  const [copied, setCopied] = useState('');
  const copy = async (label, value) => {
    await navigator.clipboard?.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(''), 1800);
  };
  return [copied, copy];
}

function PaymentSetup({ guardianId, current, onChanged }) {
  const [plans, setPlans] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const campaignId = current[0]?.campaign_id;
  const unsigned = current.filter((item) => !item.signed_at && !CLOSED.includes(item.status));
  const planId = unsigned[0]?.payment_plan_id || '';
  const method = current.find((item) => item.preferred_payment_method)?.preferred_payment_method || '';
  useEffect(() => { getPaymentPlans(campaignId).then(setPlans).catch(() => setPlans([])); }, [campaignId]);

  async function run(task, success) {
    setBusy(true); setMessage('');
    try { await task(); setMessage(success); await onChanged(); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return (
    <div className="fd-setup">
      <label className="field">
        <span className="fd-label">Plano {unsigned.length ? '' : '(fixado na assinatura)'}</span>
        <select className="control" value={planId} disabled={busy || !unsigned.length} onChange={(event) => run(async () => { for (const item of unsigned) await setEnrollmentPaymentPlan(item.id, event.target.value); }, 'Plano atualizado')}>
          <option value="">{unsigned.length ? 'A família escolhe' : current[0]?.payment_plan_name || '—'}</option>
          {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.installments}x · {plan.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="fd-label">Forma de pagamento</span>
        <select className="control" value={method} disabled={busy} onChange={(event) => run(() => setFamilyBilling(guardianId, event.target.value), 'Forma de pagamento atualizada')}>
          <option value="">Não definida</option>
          {METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {message ? <span className="meta">{message}</span> : null}
    </div>
  );
}

function Resumo({ detail, current, journey, onChanged }) {
  const { guardian, conversation, installments } = detail;
  const total = current.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);
  const active = installments.filter((item) => item.status !== 'cancelado' && current.some((enrollment) => enrollment.id === item.enrollment_id));
  const paid = active.filter((item) => item.status === 'pago');
  return (
    <div className="fd-grid">
      <div className="fd-col">
        <section className="card">
          <div className="card-head"><div><div className="card-title">Alunos em {current[0]?.academic_year || 'campanha'}</div><div className="card-sub">{current[0]?.campaign_name || 'Nenhuma matrícula na campanha ativa'}</div></div>{total ? <strong className="fd-total">{money(total)}</strong> : null}</div>
          {current.length ? current.map((item) => (
            <div key={item.id} className="fd-student">
              <div className="avatar">{initials(item.student_name)}</div>
              <div className="fd-student-main">
                <strong>{item.student_name}{item.is_new_student ? <small className="kdrawer-new">novo</small> : null}</strong>
                <span>{item.from_class_name ? `${item.from_class_name} → ` : ''}{item.grade_name || '—'}{item.birth_date ? ` · nasc. ${formatDate(item.birth_date)}` : ''}</span>
              </div>
              <div className="fd-student-flags">
                <span className={`fd-flag${item.signed_at ? ' is-ok' : ''}`}>{item.signed_at ? `Assinou ${localDay(item.signed_at)}` : 'Sem assinatura'}</span>
                <span className="fd-flag">{ENROLLMENT_STATUS[item.status] || item.status}</span>
              </div>
              <strong className="fd-money">{money(item.amount_cents)}</strong>
            </div>
          )) : <div className="meta">Esta família ainda não tem matrícula na campanha ativa.</div>}
        </section>

        <section className="card">
          <div className="card-head"><div><div className="card-title">Pagamento</div><div className="card-sub">{active.length ? `${paid.length} de ${active.length} parcelas recebidas` : 'As parcelas nascem na assinatura'}</div></div></div>
          {current.length ? <PaymentSetup guardianId={guardian.id} current={current} onChanged={onChanged} /> : null}
          {journey?.plan_name || journey?.billing_method ? <p className="meta" style={{ marginTop: 10 }}>Na jornada online a família escolheu: {[journey.plan_name, METHOD_LABEL[journey.billing_method]].filter(Boolean).join(' · ')}</p> : null}
        </section>

      </div>

      <div className="fd-col">
        <section className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>Responsável</div>
          <dl className="fd-dl">
            <div><dt>CPF</dt><dd>{formatCpfView(guardian.cpf)}</dd></div>
            <div><dt>RG</dt><dd>{guardian.rg || '—'}</dd></div>
            <div><dt>WhatsApp</dt><dd>{formatPhoneView(guardian.phone)}</dd></div>
            <div><dt>E-mail</dt><dd>{guardian.email || '—'}</dd></div>
            <div className="is-wide"><dt>Endereço</dt><dd>{guardian.address || '—'}</dd></div>
            {guardian.notes ? <div className="is-wide"><dt>Observações</dt><dd>{guardian.notes}</dd></div> : null}
            <div><dt>Cliente no Asaas</dt><dd>{guardian.asaas_customer_id || 'ainda não'}</dd></div>
            <div><dt>Cadastro</dt><dd>{localDay(guardian.created_at)}</dd></div>
          </dl>
        </section>
        {conversation ? (
          <section className="card">
            <div className="card-head"><div className="card-title">WhatsApp</div><span className="meta">{conversation.handler === 'humano' ? 'com a equipe' : 'com a IA'} · {timeAgo(conversation.last_message_at)}</span></div>
            {conversation.ai_summary ? <p className="kdrawer-summary">{conversation.ai_summary}</p> : null}
            {conversation.last_message_preview ? <blockquote className="kdrawer-quote" style={{ marginTop: 10 }}>{conversation.last_message_preview}</blockquote> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Documents({ documents }) {
  const [showLegacy, setShowLegacy] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const legacyCount = documents.filter((item) => item.legacy).length;
  const rows = documents.filter((item) => showLegacy || !item.legacy);
  async function open(item, download) {
    setBusy(item.id); setError('');
    const preview = download ? null : window.open('', '_blank');
    try {
      const blob = await getSignedContractFile(item.signed_storage_path);
      const url = URL.createObjectURL(blob);
      if (download) {
        const link = document.createElement('a');
        link.href = url;
        link.download = `contrato-${item.student_name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')}${item.legacy ? '-legado' : ''}.pdf`;
        document.body.appendChild(link); link.click(); link.remove();
      } else if (preview) preview.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { preview?.close(); setError(cause.message); } finally { setBusy(''); }
  }
  return (
    <section className="card">
      <div className="card-head">
        <div><div className="card-title">Contratos e documentos</div><div className="card-sub">{documents.length ? 'Um contrato por aluno' : 'Nenhum documento gerado ainda'}</div></div>
        {legacyCount ? <label className="fp-check"><input type="checkbox" checked={showLegacy} onChange={(event) => setShowLegacy(event.target.checked)} />Mostrar versões antigas ({legacyCount})</label> : null}
      </div>
      {error ? <div className="notice"><span>{error}</span></div> : null}
      {rows.length ? (
        <div className="ops-table-wrap is-flat">
          <table className="ops-table">
            <thead><tr><th>Aluno</th><th>Modelo</th><th>Situação</th><th>Assinado</th><th /></tr></thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id} className={item.legacy ? 'is-legacy' : ''}>
                  <td className="cell-strong">{item.student_name}</td>
                  <td className="cell is-dim">{item.version}{item.legacy ? <span className="fp-flag">legado</span> : null}</td>
                  <td><span className={`fp-status fp-status--${item.status === 'assinado' ? 'ok' : 'mute'}`}>{item.status}</span></td>
                  <td className="cell is-dim">{item.completed_at ? `${dateTime(item.completed_at)}${item.signer_full_name ? ` · ${item.signer_full_name}` : ''}` : '—'}</td>
                  <td className="ops-actions">{item.signed_storage_path ? <><button type="button" className="btn btn--ghost" disabled={busy === item.id} onClick={() => open(item, false)}>Ver</button><button type="button" className="btn" disabled={busy === item.id} onClick={() => open(item, true)}>Baixar</button></> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function Contracts({ contracts }) {
  const [copied, copy] = useCopy();
  if (!contracts.length) return null;
  const label = { pronta: 'Aguardando a família', codigo_enviado: 'Código enviado', verificada: 'E-mail confirmado', assinada: 'Assinado', cancelada: 'Cancelado', expirada: 'Expirado' };
  return (
    <section className="card">
      <div className="card-title" style={{ marginBottom: 12 }}>Links de assinatura gerados</div>
      {contracts.map((item) => (
        <div key={item.id} className="fd-line">
          <span><strong>{(item.students || []).join(', ')}</strong> · {label[item.status] || item.status} · criado {localDay(item.created_at)}{item.open_count ? ` · aberto ${item.open_count}x` : ''}</span>
          {item.status !== 'assinada' && item.status !== 'cancelada' && item.status !== 'expirada'
            ? <button type="button" className="btn btn--ghost" onClick={() => copy(item.id, contractUrl(item.token))}>{copied === item.id ? 'Copiado' : 'Copiar link'}</button>
            : <span className="meta">{item.signed_at ? `assinado ${localDay(item.signed_at)}` : ''}</span>}
        </div>
      ))}
    </section>
  );
}

function AsaasPlanned({ guardian }) {
  const planned = [
    ['Cobranças e links do Asaas', 'Lista de todas as cobranças do cliente (inclusive avulsas), com link, boleto, Pix e situação, direto do Asaas.'],
    ['Segunda via e novo vencimento', 'Gerar a segunda via ou mudar a data da cobrança sem abrir o painel do Asaas.'],
    ['Link de pagamento avulso', 'Cobrança fora das parcelas (material, uniforme, acordo) com link para mandar no WhatsApp.'],
    ['Avisos enviados', 'Histórico de e-mails e SMS que o Asaas mandou para a família.'],
    ['Cancelar ou estornar', 'Cancelar cobrança em aberto ou pedir estorno, com registro no livro financeiro.']
  ];
  return (
    <section className="card asaas-plan">
      <div className="card-head">
        <div><div className="card-title">Asaas da família</div><div className="card-sub">{guardian.asaas_customer_id ? `Cliente ${guardian.asaas_customer_id}` : 'Ainda sem cliente no Asaas: ele é criado na primeira cobrança ou localizado pelo CPF ao sincronizar.'}</div></div>
        <span className="fp-flag">próximas etapas</span>
      </div>
      <ul>
        {planned.map(([title, text]) => <li key={title}><strong>{title}</strong><span>{text}</span></li>)}
      </ul>
    </section>
  );
}

function Historico({ events, ledger }) {
  const [filter, setFilter] = useState('tudo');
  const items = useMemo(() => {
    const fromEvents = events.map((event) => ({ id: `e-${event.id}`, at: event.created_at, title: event.title, body: [event.student_name, event.body].filter(Boolean).join(' · '), kind: 'jornada', code: event.code }));
    const fromLedger = ledger.map((row) => ({ id: `l-${row.id}`, at: row.occurred_at, title: { recebimento: 'Recebimento', estorno: 'Recebimento desfeito', vinculo: 'Vínculo com o Asaas', status: 'Parcela mudou de status' }[row.kind] || row.kind, body: [row.student_name, row.installment_number ? `parcela ${row.installment_number}` : null, row.amount_cents != null ? money(row.amount_cents) : null, METHOD_LABEL[row.method], row.description, row.actor_name ? `por ${row.actor_name}` : null].filter(Boolean).join(' · '), kind: 'financeiro', code: row.source }));
    return [...fromEvents, ...fromLedger].filter((item) => filter === 'tudo' || item.kind === filter).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }, [events, ledger, filter]);
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">Linha do tempo</div>
        <div className="segmented">{[['tudo', 'Tudo'], ['jornada', 'Jornada'], ['financeiro', 'Financeiro']].map(([value, label]) => <button key={value} type="button" className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
      </div>
      {items.length ? items.map((item) => (
        <div className="timeline-row" key={item.id}>
          <div className="timeline-time">{dateTime(item.at)}</div>
          <div className="timeline-rail"><i /><u /></div>
          <div className="timeline-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}><h4>{item.title}</h4><span className="timeline-code">{item.code}</span></div>
            <p>{item.body || 'Evento registrado no sistema.'}</p>
          </div>
        </div>
      )) : <div className="meta">Nada registrado ainda.</div>}
    </section>
  );
}

export default function FamilyDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([value]) => value === params.get('aba')) ? params.get('aba') : 'resumo';
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const setFamilyHeader = useContext(FamilyHeaderContext);
  const [copied, copy] = useCopy();

  const load = useCallback(async (silent = false) => {
    if (!silent) setState((current) => ({ ...current, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await getFamilyDetail(id) });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const data = state.data;
  const current = useMemo(() => (data?.enrollments || []).filter((item) => item.campaign_active), [data]);
  const journey = data?.journeys?.[0];
  const kind = journey?.flow || current[0]?.campaign_kind || 'rematricula';
  const stage = stageInfo(journey?.stage || (current.some((item) => item.completed_at) ? 'concluida' : current.some((item) => item.signed_at) ? 'pagamento' : current.length ? 'conversa' : 'a_contatar'), kind);

  useEffect(() => {
    if (!data?.guardian) return undefined;
    setFamilyHeader({ enrollmentId: id, crumb: `Famílias / ${KIND_LABEL[kind] || ''}`, title: data.guardian.full_name });
    return () => setFamilyHeader(null);
  }, [data, id, kind, setFamilyHeader]);

  if (state.loading && !data) return <div className="notice">Carregando a família…</div>;
  if (state.error && !data) return <div className="notice"><strong>Não foi possível carregar.</strong><span>{state.error}</span></div>;
  if (!data) return <div className="notice">Família não encontrada.</div>;

  const { guardian } = data;
  const link = journey ? journeyUrl(journey) : '';
  const wa = whatsappUrl(guardian.phone);
  const unsigned = current.filter((item) => !item.signed_at && !item.completed_at && !CLOSED.includes(item.status));
  const currentInstallments = data.installments.filter((item) => current.some((enrollment) => enrollment.id === item.enrollment_id));
  const openCents = currentInstallments.filter((item) => ['pendente', 'vencido'].includes(item.status)).reduce((sum, item) => sum + item.amount_cents, 0);
  const setTab = (value) => setParams((currentParams) => { const next = new URLSearchParams(currentParams); next.set('aba', value); return next; }, { replace: true });

  return (
    <div className="ops">
      <Link className="back-link" to={`/familias?tipo=${kind}`}>← Famílias</Link>
      <section className="fd-head card">
        <div className="fd-head-main">
          <div className="avatar avatar--lg">{initials(guardian.full_name)}</div>
          <div>
            <span className="stage-pill" style={{ '--accent': stage.color }}><i />{stage.label}</span>
            <h2>{guardian.full_name}</h2>
            <span className="meta">{formatPhoneView(guardian.phone)} · {guardian.email || 'sem e-mail'} · CPF {formatCpfView(guardian.cpf)}</span>
          </div>
        </div>
        <div className="fd-head-stats">
          <div><span>Alunos</span><strong>{current.length}</strong></div>
          <div><span>Valor</span><strong>{money(current.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0))}</strong></div>
          <div><span>Em aberto</span><strong className={openCents ? 'is-warn' : ''}>{openCents ? money(openCents) : '—'}</strong></div>
        </div>
        <div className="fd-head-actions">
          {wa ? <a className="btn btn--primary" href={wa} target="_blank" rel="noreferrer">WhatsApp</a> : null}
          {link ? <button type="button" className="btn" onClick={() => copy('journey', link)}>{copied === 'journey' ? 'Link copiado' : 'Copiar link da jornada'}</button> : null}
          {unsigned.length ? <button type="button" className="btn" onClick={() => setTab('contrato')}>Link só para assinar</button> : null}
          <Link className="btn btn--ghost" to="/jornadas">Ver no quadro</Link>
        </div>
      </section>

      <div className="tabs">
        {TABS.map(([value, label]) => <button key={value} type="button" className={`tab${tab === value ? ' is-active' : ''}`} onClick={() => setTab(value)}>{label}{value === 'financeiro' && openCents ? <span className="tab-badge">{money(openCents)}</span> : null}</button>)}
      </div>

      {tab === 'resumo' ? <Resumo detail={data} current={current} journey={journey} onChanged={() => load(true)} /> : null}
      {tab === 'contrato' ? (
        <>
          {unsigned.length ? <ContractSetup key={unsigned.map((item) => item.id).join()} enrollments={unsigned} guardian={guardian} campaignId={unsigned[0].campaign_id} onCreated={() => load(true)} /> : <div className="notice notice--soft"><span>{current.length ? 'Todos os alunos desta campanha já assinaram.' : 'Sem matrícula na campanha ativa para gerar contrato.'}</span></div>}
          <Documents documents={data.documents} />
          <Contracts contracts={data.contracts} />
        </>
      ) : null}
      {tab === 'financeiro' ? (
        <>
          <section className="card">
            <div className="card-head"><div><div className="card-title">Parcelas e cobranças</div><div className="card-sub">{currentInstallments.length ? `${currentInstallments.filter((item) => item.status === 'pago').length} de ${currentInstallments.filter((item) => item.status !== 'cancelado').length} recebidas · ${INSTALLMENT_LABEL.pendente.toLowerCase()}: ${money(openCents)}` : 'Sem parcelas ainda'}</div></div><Link className="btn btn--ghost" to="/pagamentos">Todos os pagamentos →</Link></div>
            <FamilyPayments rows={currentInstallments} guardianId={guardian.id} onChanged={() => load(true)} />
          </section>
          <AsaasPlanned guardian={guardian} />
        </>
      ) : null}
      {tab === 'historico' ? <Historico events={data.events} ledger={data.ledger} /> : null}
    </div>
  );
}
