import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../components/ui';
import { getJourneyBoard, setInstallmentPaid, setJourneyStage } from '../services/data';
import { date as formatDate, money } from '../lib/format';
import { COLUMNS, KINDS } from '../lib/journey';

/* Quadro da campanha: cada coluna é uma etapa da jornada calculada no banco
   (onboarding_stage). A equipe pode mover um card à mão (arrastando ou pelo
   painel); a mudança vale até a família avançar sozinha no sistema. */
const PAGE = 40;
const REFRESH_MS = 60000;
const BILLING = { boleto: 'Boleto', cartao: 'Cartão', credit_card: 'Cartão', pix: 'Pix', dinheiro: 'Dinheiro' };
const METHODS = [['pix', 'Pix'], ['dinheiro', 'Dinheiro'], ['boleto', 'Boleto'], ['cartao', 'Cartão']];
const localDay = (value) => (value ? new Intl.DateTimeFormat('pt-BR').format(new Date(value)) : '');
const todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const centsToInput = (cents) => (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
const inputToCents = (value) => Math.round(Number(String(value || '').replace(/\./g, '').replace(',', '.')) * 100);

function timeAgo(value) {
  if (!value) return '';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'ontem' : `há ${days} dias`;
}

function whatsappUrl(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (!digits.startsWith('55')) digits = `55${digits}`;
  return `https://wa.me/${digits}`;
}

function journeyUrl(card) {
  if (!card.token) return '';
  const path = card.flow === 'rematricula' ? 'rematricula' : 'matricula';
  return `${window.location.origin}/${path}?j=${encodeURIComponent(card.token)}&f=${encodeURIComponent(card.flow || 'matricula_nova')}`;
}

const normalize = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function matches(card, term) {
  if (!term) return true;
  const digits = term.replace(/\D/g, '');
  if (digits.length >= 4 && String(card.guardian_phone || '').replace(/\D/g, '').includes(digits)) return true;
  const haystack = normalize([card.guardian_name, ...(card.students || []).map((s) => s.name)].join(' '));
  return haystack.includes(normalize(term));
}

function JourneyCard({ card, color, onOpen }) {
  const students = card.students || [];
  const billing = BILLING[card.billing_method] || card.billing_method;
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => { event.dataTransfer.setData('text/plain', card.guardian_id); event.dataTransfer.effectAllowed = 'move'; }}
      className={`kcard${card.needs_human ? ' is-human' : ''}`}
      style={{ '--accent': color }}
      onClick={() => onOpen(card)}
    >
      <div className="kcard-top">
        <strong>{card.guardian_name || 'Sem nome'}</strong>
        {card.last_activity_at ? <span className="kcard-time">{timeAgo(card.last_activity_at)}</span> : null}
      </div>
      {students.length ? (
        <ul className="kcard-students">
          {students.slice(0, 3).map((s, index) => (
            <li key={`${s.name}-${index}`}>{s.name}{s.grade || s.from ? <small> · {s.grade || s.from}</small> : null}</li>
          ))}
          {students.length > 3 ? <li className="kcard-more">+{students.length - 3} alunos</li> : null}
        </ul>
      ) : null}
      {card.manual || card.needs_human || card.unread_count > 0 || card.plan_name || billing || card.amount_cents ? (
        <div className="kcard-foot">
          {card.manual ? <span className="kpill kpill--manual" title={card.manual_info?.note || 'Movido pela equipe'}>Manual</span> : null}
          {card.needs_human ? <span className="kpill kpill--human">Precisa de humano</span> : null}
          {card.unread_count > 0 ? <span className="kpill kpill--unread">{card.unread_count} nova{card.unread_count > 1 ? 's' : ''}</span> : null}
          {billing ? <span className="kpill">{billing}</span> : null}
          {card.plan_name ? <span className="kpill" title={card.plan_name}>{card.plan_name.split(' — ')[0].split(' (')[0]}</span> : null}
          {card.amount_cents ? <span className="kcard-amount">{money(card.amount_cents)}</span> : null}
        </div>
      ) : null}
    </button>
  );
}

function Column({ column, cards, anonymous, onOpen, onDropCard }) {
  const [limit, setLimit] = useState(PAGE);
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const total = cards.reduce((sum, card) => sum + Number(card.amount_cents || 0), 0);
  const human = cards.filter((card) => card.needs_human).length;
  return (
    <section
      className={`kcol${over ? ' is-over' : ''}`}
      style={{ '--accent': column.color }}
      onDragEnter={(event) => { event.preventDefault(); depth.current += 1; setOver(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
      onDragLeave={() => { depth.current -= 1; if (depth.current <= 0) { depth.current = 0; setOver(false); } }}
      onDrop={(event) => { event.preventDefault(); depth.current = 0; setOver(false); const id = event.dataTransfer.getData('text/plain'); if (id) onDropCard(id, column); }}
    >
      <header className="kcol-head">
        <div className="kcol-title"><i /><strong>{column.label}</strong><span className="kcol-count">{cards.length}</span></div>
        <div className="kcol-hint">{column.hint}</div>
        {total || human ? (
          <div className="kcol-meta">
            {total ? <span>{money(total)}</span> : null}
            {human ? <span className="kcol-human">{human} precisa{human > 1 ? 'm' : ''} de humano</span> : null}
          </div>
        ) : null}
      </header>
      <div className="kcol-body">
        {column.anonymous && anonymous > 0 ? (
          <div className="kcol-ghost">+{anonymous} {anonymous > 1 ? 'links abertos' : 'link aberto'} sem identificação</div>
        ) : null}
        {cards.slice(0, limit).map((card) => <JourneyCard key={card.guardian_id} card={card} color={column.color} onOpen={onOpen} />)}
        {cards.length > limit ? (
          <button type="button" className="kcol-more" onClick={() => setLimit((value) => value + PAGE * 2)}>Mostrar mais {Math.min(cards.length - limit, PAGE * 2)} de {cards.length - limit}</button>
        ) : null}
        {!cards.length && !(column.anonymous && anonymous > 0) ? <div className="kcol-empty">Nenhuma família aqui</div> : null}
      </div>
    </section>
  );
}

function StageControl({ card, columns, current, onMove, busy }) {
  const [note, setNote] = useState('');
  const index = columns.findIndex((column) => column.key === current?.key);
  const prev = index > 0 ? columns[index - 1] : null;
  const next = index >= 0 && index < columns.length - 1 ? columns[index + 1] : null;
  const autoColumn = columns.find((column) => column.stages.includes(card.auto_stage));
  const move = (column) => onMove(card, column, note).then(() => setNote(''));
  return (
    <section className="kdrawer-section">
      <h3>Etapa</h3>
      <div className="kstage">
        <button type="button" className="btn" disabled={!prev || busy} onClick={() => move(prev)} title={prev ? `Voltar para ${prev.label}` : ''}>← {prev ? prev.label : 'Início'}</button>
        <select className="kstage-select" value={current?.key || ''} disabled={busy} onChange={(event) => move(columns.find((column) => column.key === event.target.value))}>
          {columns.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}
        </select>
        <button type="button" className="btn" disabled={!next || busy} onClick={() => move(next)} title={next ? `Avançar para ${next.label}` : ''}>{next ? next.label : 'Fim'} →</button>
      </div>
      <input className="kstage-note" placeholder="Motivo (opcional): ex. pagou na secretaria" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
      {card.manual ? (
        <div className="kmanual">
          <div>
            <strong>Movido à mão{card.manual_info?.by ? ` por ${card.manual_info.by}` : ''}</strong>
            <span>{card.manual_info?.at ? `${localDay(card.manual_info.at)} · ` : ''}pelo sistema estaria em “{autoColumn?.label || card.auto_stage}”{card.manual_info?.note ? ` · ${card.manual_info.note}` : ''}</span>
          </div>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onMove(card, autoColumn, '')}>Voltar ao automático</button>
        </div>
      ) : <span className="meta">Se a família avançar sozinha depois, o card volta a seguir o sistema.</span>}
    </section>
  );
}

function InstallmentRow({ item, onPay, busy }) {
  const [form, setForm] = useState(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const paid = item.status === 'pago';
  const overdue = item.status === 'vencido';
  const open = () => setForm({ method: item.method || 'pix', paidOn: todayIso(), amount: centsToInput(item.amount_cents), notify: false });
  async function save(event) {
    event.preventDefault();
    const cents = inputToCents(form.amount);
    await onPay(item, true, { method: form.method, paidOn: form.paidOn, amountCents: cents > 0 ? cents : item.amount_cents, notify: form.notify });
    setForm(null);
  }
  return (
    <div className={`kinst${paid ? ' is-paid' : ''}${overdue ? ' is-overdue' : ''}`}>
      <div className="kinst-top">
        <div className="who">
          <strong>Parcela {item.number}{item.student ? <small> · {item.student}</small> : null}</strong>
          <span>{money(item.amount_cents)} · vence {formatDate(item.due_date)}</span>
        </div>
        {paid ? (
          <div className="kinst-paid">
            <span className="kpill kpill--paid">Recebido</span>
            <small>{localDay(item.paid_at)}{item.method ? ` · ${BILLING[item.method] || item.method}` : ''}</small>
          </div>
        ) : <span className={`kpill${overdue ? ' kpill--human' : ''}`}>{overdue ? 'Vencida' : 'Em aberto'}</span>}
      </div>
      {!form ? (
        <div className="kinst-actions">
          {paid ? (
            confirmUndo
              ? <><span className="meta">Voltar esta parcela para em aberto?</span><button type="button" className="btn btn--danger" disabled={busy} onClick={() => onPay(item, false).then(() => setConfirmUndo(false))}>Sim, desfazer</button><button type="button" className="btn btn--ghost" onClick={() => setConfirmUndo(false)}>Cancelar</button></>
              : <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setConfirmUndo(true)}>Desfazer recebimento</button>
          ) : <button type="button" className="btn btn--primary" disabled={busy} onClick={open}>Marcar como recebido</button>}
        </div>
      ) : (
        <form className="kinst-form" onSubmit={save}>
          <label>Forma<select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })}>{METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Data<input type="date" value={form.paidOn} max={todayIso()} onChange={(event) => setForm({ ...form, paidOn: event.target.value })} required /></label>
          <label>Valor (R$)<input inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} required /></label>
          <label className="kinst-check"><input type="checkbox" checked={form.notify} onChange={(event) => setForm({ ...form, notify: event.target.checked })} />Avisar a família no WhatsApp</label>
          <div className="kinst-form-actions">
            <button type="button" className="btn btn--ghost" onClick={() => setForm(null)}>Cancelar</button>
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Salvando…' : 'Confirmar recebimento'}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function CardDrawer({ card, stageLabel, stageColor, onClose, columns, currentColumn, onMove, onPay, busy, error }) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const link = journeyUrl(card);
  const wa = whatsappUrl(card.guardian_phone);
  const billing = BILLING[card.billing_method] || card.billing_method;

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    await navigator.clipboard?.writeText(link);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="kdrawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="kdrawer" role="dialog" aria-modal="true" aria-label={card.guardian_name}>
        <div className="kdrawer-head">
          <div>
            <span className="kdrawer-stage" style={{ '--accent': stageColor }}><i />{stageLabel}{card.manual ? ' · manual' : ''}</span>
            <h2>{card.guardian_name}</h2>
            <span className="meta">{card.guardian_phone || 'sem telefone'}</span>
          </div>
          <button type="button" className="modal-close" aria-label="Fechar" onClick={onClose}>×</button>
        </div>

        {card.needs_human ? <div className="notice"><Badge tone="warn">Atenção</Badge><span>Esta família está com a equipe: a conversa saiu da IA ou a jornada pediu ajuda.</span></div> : null}

        <div className="kdrawer-actions">
          {wa ? <a className="btn btn--primary" href={wa} target="_blank" rel="noreferrer">Abrir WhatsApp</a> : null}
          {link ? <button type="button" className="btn" onClick={copy}>{copied ? 'Link copiado' : 'Copiar link da jornada'}</button> : null}
          <button type="button" className="btn" onClick={() => navigate(`/familias/${card.guardian_id}`)}>Ver ficha completa</button>
        </div>

        {error ? <div className="notice"><span>{error}</span></div> : null}

        <StageControl card={card} columns={columns} current={currentColumn} onMove={onMove} busy={busy} />

        {(card.installments || []).length ? (
          <section className="kdrawer-section">
            <h3>Parcelas</h3>
            {card.installments.map((item) => <InstallmentRow key={item.id} item={item} onPay={onPay} busy={busy} />)}
          </section>
        ) : null}

        <section className="kdrawer-section">
          <h3>Alunos</h3>
          {(card.students || []).length ? (card.students || []).map((s, index) => (
            <div className="kdrawer-row" key={`${s.name}-${index}`}>
              <div className="who"><strong>{s.name}{s.is_new ? <small className="kdrawer-new">novo</small> : null}</strong><span>{s.from && s.grade ? `${s.from} → ${s.grade}` : s.grade || s.from || '—'}</span></div>
              {s.amount_cents ? <strong className="kdrawer-money">{money(s.amount_cents)}</strong> : null}
            </div>
          )) : <div className="kcol-empty">Nenhum aluno vinculado ainda</div>}
          {card.amount_cents && (card.students || []).length > 1 ? <div className="kdrawer-total"><span>Total</span><strong>{money(card.amount_cents)}</strong></div> : null}
        </section>

        {card.plan_name || billing ? (
          <section className="kdrawer-section">
            <h3>Pagamento</h3>
            {card.plan_name ? <div className="kdrawer-kv"><span>Plano</span><strong>{card.plan_name}</strong></div> : null}
            {billing ? <div className="kdrawer-kv"><span>Forma</span><strong>{billing}</strong></div> : null}
          </section>
        ) : null}

        {card.conversation_id ? (
          <section className="kdrawer-section">
            <h3>Conversa no WhatsApp</h3>
            <div className="kdrawer-kv"><span>Atendimento</span><strong>{card.handler === 'humano' ? 'Equipe' : 'IA'}</strong></div>
            {card.last_message_at ? <div className="kdrawer-kv"><span>Última mensagem</span><strong>{timeAgo(card.last_message_at)}</strong></div> : null}
            {card.ai_summary ? <p className="kdrawer-summary">{card.ai_summary}</p> : null}
            {card.last_message_preview ? <blockquote className="kdrawer-quote">{card.last_message_preview}</blockquote> : null}
          </section>
        ) : null}

        {card.attempts ? <section className="kdrawer-section"><div className="kdrawer-kv"><span>Tentativas de contato</span><strong>{card.attempts}</strong></div></section> : null}
      </aside>
    </div>
  );
}

export default function Jornadas() {
  const [kind, setKind] = useState(() => {
    try { return localStorage.getItem('cec.board.kind') || 'rematricula'; } catch { return 'rematricula'; }
  });
  const [state, setState] = useState({ loading: true, error: null, data: null, at: null });
  const [search, setSearch] = useState('');
  const [onlyHuman, setOnlyHuman] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [toast, setToast] = useState('');
  const [, setTick] = useState(0);
  const searchRef = useRef(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await getJourneyBoard(kind);
      setState({ loading: false, error: null, data, at: new Date() });
    } catch (err) {
      setState((current) => ({ ...current, loading: false, error: err.message || 'Não foi possível carregar o quadro.' }));
    }
  }, [kind]);

  useEffect(() => {
    try { localStorage.setItem('cec.board.kind', kind); } catch { /* sem storage */ }
    setState({ loading: true, error: null, data: null, at: null });
    load();
  }, [kind, load]);

  // Atualiza sozinho a cada minuto e ao voltar para a aba.
  useEffect(() => {
    const timer = window.setInterval(() => { load(true); setTick((value) => value + 1); }, REFRESH_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onFocus); };
  }, [load]);

  // "/" foca a busca, como em outros sistemas.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function flash(message) { setToast(message); window.setTimeout(() => setToast(''), 2600); }

  // Troca local do card enquanto o banco confirma; depois recarrega o quadro.
  const patchCard = (guardianId, patch) => setState((current) => current.data ? {
    ...current,
    data: { ...current.data, cards: current.data.cards.map((card) => card.guardian_id === guardianId ? { ...card, ...patch } : card) }
  } : current);

  const moveCard = useCallback(async (card, column, note) => {
    if (!card || !column) return;
    const backToAuto = column.stages.includes(card.auto_stage);
    const stage = backToAuto ? null : column.stages[0];
    if (!backToAuto && column.stages.includes(card.stage) && card.manual) return;
    if (backToAuto && !card.manual) return;
    setBusy(true); setActionError('');
    patchCard(card.guardian_id, { stage: stage || card.auto_stage, manual: !backToAuto });
    try {
      await setJourneyStage(kind, card.guardian_id, stage, note);
      flash(backToAuto ? `${card.guardian_name}: voltou ao automático` : `${card.guardian_name} → ${column.label}`);
    } catch (err) {
      setActionError(err.message || 'Não foi possível mover a família.');
    } finally {
      setBusy(false);
      load(true);
    }
  }, [kind, load]);

  const payInstallment = useCallback(async (item, paid, options) => {
    setBusy(true); setActionError('');
    try {
      await setInstallmentPaid(item.id, paid, options);
      flash(paid ? `Parcela ${item.number} marcada como recebida` : `Parcela ${item.number} voltou para em aberto`);
    } catch (err) {
      setActionError(err.message || 'Não foi possível registrar o pagamento.');
    } finally {
      setBusy(false);
      await load(true);
    }
  }, [load]);

  const onDropCard = useCallback((guardianId, column) => {
    const card = (state.data?.cards || []).find((item) => item.guardian_id === guardianId);
    if (card && !column.stages.includes(card.stage)) moveCard(card, column, '');
  }, [state.data, moveCard]);

  const cards = useMemo(() => state.data?.cards || [], [state.data]);
  const visible = useMemo(() => cards.filter((card) => (!onlyHuman || card.needs_human) && matches(card, search.trim())), [cards, onlyHuman, search]);
  const humanCount = cards.filter((card) => card.needs_human).length;
  const columns = COLUMNS[kind].filter((column) => !column.optional || cards.some((card) => column.stages.includes(card.stage)));
  // Quem precisa de humano fica sempre no topo da coluna; o resto segue pela última atividade.
  const byColumn = useMemo(() => Object.fromEntries(columns.map((column) => [
    column.key,
    visible.filter((card) => column.stages.includes(card.stage)).sort((a, b) => Number(Boolean(b.needs_human)) - Number(Boolean(a.needs_human)))
  ])), [columns, visible]);
  const openCard = cards.find((card) => card.guardian_id === openId);
  const openColumn = openCard ? COLUMNS[kind].find((column) => column.stages.includes(openCard.stage)) : null;
  const searching = search.trim().length > 0;
  const inJourney = cards.filter((card) => !['a_contatar', 'conversa', 'perdida'].includes(card.stage)).length;
  const done = cards.filter((card) => card.stage === 'concluida').length;

  return (
    <div className="board-page">
      <div className="board-toolbar">
        <div className="segmented" role="tablist">
          {KINDS.map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={kind === value} className={kind === value ? 'is-active' : ''} onClick={() => { setKind(value); setOpenId(null); }}>{label}</button>
          ))}
        </div>
        <div className="board-search-wrap">
          <input
            ref={searchRef}
            className="control board-search"
            type="search"
            placeholder="Buscar pai, mãe, aluno ou telefone  ( / )"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && visible.length) setOpenId(visible[0].guardian_id);
              if (event.key === 'Escape') setSearch('');
            }}
          />
          {searching ? <span className="board-search-count">{visible.length ? `${visible.length} encontrada${visible.length > 1 ? 's' : ''} · Enter abre` : 'nenhuma família'}</span> : null}
        </div>
        <button type="button" className={`chip${onlyHuman ? ' is-active' : ''}`} onClick={() => setOnlyHuman((value) => !value)} disabled={!humanCount}>
          Precisa de humano<span className="chip-count">{humanCount}</span>
        </button>
        <div className="board-status">
          {state.data ? <span className="meta">{cards.length} famílias · {inJourney} na jornada · {done} concluídas</span> : null}
          <button type="button" className="btn btn--ghost" onClick={() => load()} disabled={state.loading}>{state.loading ? 'Atualizando…' : state.at ? `Atualizado ${timeAgo(state.at)}` : 'Atualizar'}</button>
        </div>
      </div>

      {state.error ? <div className="notice"><strong>Não foi possível carregar.</strong><span>{state.error}</span></div> : null}
      {!state.data && state.loading ? <div className="notice">Carregando o quadro…</div> : null}

      {state.data ? (
        <div className="kanban">
          {columns.map((column) => (
            <Column key={`${kind}-${column.key}`} column={column} cards={byColumn[column.key] || []} anonymous={state.data.anonymous_sessions || 0} onOpen={(card) => { setActionError(''); setOpenId(card.guardian_id); }} onDropCard={onDropCard} />
          ))}
        </div>
      ) : null}

      {openCard ? (
        <CardDrawer
          key={openCard.guardian_id}
          card={openCard}
          stageLabel={openColumn?.label || openCard.stage}
          stageColor={openColumn?.color}
          onClose={() => setOpenId(null)}
          columns={COLUMNS[kind]}
          currentColumn={openColumn}
          onMove={moveCard}
          onPay={payInstallment}
          busy={busy}
          error={actionError}
        />
      ) : null}
      {toast ? <div className="ktoast" role="status">{toast}</div> : null}
    </div>
  );
}
