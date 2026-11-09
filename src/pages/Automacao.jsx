import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmModal } from '../components/MessageComposer';
import { automationAction, getAutomation, getBilling, saveAutomation, setAutomationMode, setFollowupStatus, skipBillingCharge } from '../services/data';

/* Automação do contato de rematrícula. Quem decide quem recebe, quando e
   quantas por dia é o banco (`automation_candidates` e `automation_pick`); a
   Edge Function `automation-tick` envia uma família por vez. Aqui a equipe
   liga e desliga, ajusta os limites e os textos e acompanha o que saiu. */

const DAYS = [
  { n: 1, label: 'Seg' }, { n: 2, label: 'Ter' }, { n: 3, label: 'Qua' }, { n: 4, label: 'Qui' },
  { n: 5, label: 'Sex' }, { n: 6, label: 'Sáb' }, { n: 7, label: 'Dom' }
];

const BLOCK = {
  pode_receber: 'Podem receber',
  contato_recente: 'Receberam há pouco (esperando o intervalo)',
  conversando: 'Conversando agora (mensagem nas últimas 48 h)',
  com_a_equipe: 'Com a equipe (atendimento humano)',
  esperando_a_escola: 'A IA prometeu a equipe e ninguém respondeu',
  limite_de_contatos: 'Já receberam todos os contatos',
  nao_quer: 'Disseram que não querem',
  nao_vai_continuar: 'Não vão continuar',
  pediu_para_sair: 'Pediram para não receber mensagens',
  desativado_no_follow_up: 'Desativados no follow-up',
  sem_telefone: 'Sem telefone no cadastro',
  sem_aluno_em_2027: 'Só têm aluno no 9º ano (não seguem em 2027)',
  ja_assinou: 'Já assinaram'
};

const TEMPLATE_HINT = {
  contato_1: 'Vai para quem nunca conversou com a escola. Não leva link: a família responde e a IA continua a conversa e manda o link.',
  contato_2: 'Lembrete para quem não respondeu ao 1º contato, ou que já conversou e parou.',
  contato_3: 'Último lembrete. Deixa a porta aberta para a família dizer que não vai continuar.',
  jornada_parada: 'Para quem abriu a rematrícula e parou no meio. Vai com o link da própria família ({{link}}).'
};

const TICK = {
  desligada: 'Desligada.',
  fora_do_horario: 'Fora do horário de envio.',
  intervalo: 'Esperando o intervalo entre uma mensagem e outra.',
  enviando: 'Enviando uma mensagem agora.',
  limite_do_dia: 'Limite do dia atingido. Volta amanhã.',
  limite_da_hora: 'Limite da hora atingido. Volta em instantes.',
  ninguem_para_contatar: 'Ninguém para contatar agora.',
  whatsapp_desconectado: 'O WhatsApp da escola está desconectado.',
  envio_nao_configurado: 'O envio não está configurado no Supabase.',
  outra_rodada: 'Outra rodada em andamento.'
};

const STAGE = {
  a_contatar: 'Nunca contatada', conversa: 'Já conversou', identificacao: 'Parou nos dados', dados: 'Parou nos dados',
  alunos: 'Parou em alunos', condicoes: 'Parou no plano', assinatura: 'Parou na assinatura'
};

const fmt = (value, opts = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) =>
  (value ? new Intl.DateTimeFormat('pt-BR', opts).format(new Date(value)) : '—');
const phoneFmt = (value) => {
  const d = String(value || '').replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return value || '';
};
const LOWER = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
function proper(value) {
  const text = String(value || '');
  if (text !== text.toUpperCase()) return text;
  return text.toLowerCase().split(/\s+/).map((w, i) => (i && LOWER.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/** Dias de envio daqui até o prazo, contando hoje só se ainda há janela. */
function sendingDays(settings) {
  if (!settings) return 0;
  const days = new Set(settings.weekdays || []);
  const end = new Date(`${settings.deadline}T23:59:59-03:00`);
  const lastWindow = String(settings.windows || '').split(',').map((w) => w.trim().split('-')[1]).filter(Boolean).sort().at(-1) || '18:00';
  const now = new Date();
  let count = 0;
  for (let d = new Date(now); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = ((d.getDay() + 6) % 7) + 1;
    if (!days.has(iso)) continue;
    if (d.toDateString() === now.toDateString()) {
      const [h, m] = lastWindow.split(':').map(Number);
      if (now.getHours() * 60 + now.getMinutes() >= h * 60 + m) continue;
    }
    count += 1;
  }
  return count;
}

/** Data em que acaba o 1º contato no ritmo atual. */
function finishDate(settings, left) {
  if (!settings || !left) return null;
  const days = new Set(settings.weekdays || []);
  let remaining = left;
  const d = new Date();
  d.setDate(d.getDate() + 1);
  for (let guard = 0; guard < 120; guard += 1, d.setDate(d.getDate() + 1)) {
    if (!days.has(((d.getDay() + 6) % 7) + 1)) continue;
    remaining -= settings.daily_cap;
    if (remaining <= 0) return new Date(d);
  }
  return null;
}

function toForm(settings) {
  return {
    daily_cap: settings.daily_cap,
    hourly_cap: settings.hourly_cap,
    min_gap_minutes: Math.round(settings.min_gap_seconds / 60),
    max_gap_minutes: Math.round(settings.max_gap_seconds / 60),
    windows: settings.windows,
    weekdays: settings.weekdays || [],
    max_touches: settings.max_touches,
    touch_gap_days: settings.touch_gap_days,
    deadline: settings.deadline
  };
}

function fromForm(form, enabled) {
  return {
    enabled,
    daily_cap: Number(form.daily_cap),
    hourly_cap: Number(form.hourly_cap),
    min_gap_seconds: Math.round(Number(form.min_gap_minutes) * 60),
    max_gap_seconds: Math.round(Number(form.max_gap_minutes) * 60),
    windows: form.windows,
    weekdays: form.weekdays,
    max_touches: Number(form.max_touches),
    touch_gap_days: Number(form.touch_gap_days),
    deadline: form.deadline
  };
}

function Status({ data, wa, onToggle, busy }) {
  const s = data.settings;
  const tick = s.last_tick_result || {};
  const reason = tick.action === 'send' ? `Última mensagem saiu para ${proper(tick.guardian || '')}.` : TICK[tick.reason] || '';
  return (
    <section className={`card au-status${s.enabled ? ' is-on' : ''}`}>
      <div className="au-status-main">
        <span className="au-pill">{s.enabled ? 'Ligada' : 'Desligada'}</span>
        <h2>{s.enabled ? 'A automação está enviando' : 'A automação está parada'}</h2>
        <p>
          {s.enabled
            ? data.in_window
              ? `${reason} ${s.next_send_after && new Date(s.next_send_after) > new Date() ? `Próxima a partir de ${fmt(s.next_send_after, { hour: '2-digit', minute: '2-digit' })}.` : ''}`
              : 'Fora do horário de envio agora. Ela continua sozinha no próximo horário.'
            : 'Nada é enviado enquanto estiver desligada. Revise os textos e a fila antes de ligar.'}
        </p>
        {s.paused_reason ? <div className="notice"><span><strong>Parou sozinha.</strong> {s.paused_reason}</span></div> : null}
        {wa && !wa.loading && (!wa.configured || !wa.connected) ? (
          <div className="notice"><span>{!wa.configured ? 'O envio não está configurado: faltam UAZAPI_BASE_URL e UAZAPI_TOKEN nos segredos do Supabase.' : 'O WhatsApp da escola está desconectado na UAZAPI. Nada sai até reconectar.'}</span></div>
        ) : null}
      </div>
      <div className="au-status-side">
        <div className="au-num"><strong>{data.counts.today}</strong><span>de {s.daily_cap} hoje</span></div>
        <div className="au-num"><strong>{data.counts.last_hour}</strong><span>na última hora (máx. {s.hourly_cap})</span></div>
        <div className="au-num"><strong>{data.totals.replied}</strong><span>de {data.totals.families} famílias responderam</span></div>
        <button type="button" className={`btn ${s.enabled ? 'btn--danger' : 'btn--primary'} au-toggle`} disabled={busy} onClick={onToggle}>
          {s.enabled ? 'Desligar agora' : 'Ligar a automação'}
        </button>
        <span className="meta">WhatsApp: {wa?.loading ? 'verificando…' : wa?.connected ? 'conectado' : wa?.configured ? 'desconectado' : 'sem configuração'}</span>
      </div>
    </section>
  );
}

function Plan({ data }) {
  const s = data.settings;
  const days = sendingDays(s);
  const capacity = days * s.daily_cap;
  const first = data.first_contact_left;
  const done = finishDate(s, first);
  const deadline = new Date(`${s.deadline}T12:00:00-03:00`);
  const late = done && done > deadline;
  return (
    <section className="card">
      <div className="card-head"><div><div className="card-title">Ritmo até {fmt(deadline, { day: '2-digit', month: '2-digit' })}</div><div className="card-sub">Com {s.daily_cap} mensagens por dia, nos dias marcados</div></div></div>
      <div className="au-plan">
        <div><strong>{first}</strong><span>famílias ainda sem o 1º contato</span></div>
        <div><strong>{days}</strong><span>dias de envio até o prazo</span></div>
        <div><strong>{capacity}</strong><span>mensagens cabem nesse tempo</span></div>
        <div><strong>{data.remaining_touches}</strong><span>contatos que ainda podem sair (até {s.max_touches} por família)</span></div>
      </div>
      <p className={`au-plan-note${late ? ' is-late' : ''}`}>
        {first ? (done
          ? `No ritmo atual, o 1º contato com todas termina em ${fmt(done, { weekday: 'short', day: '2-digit', month: '2-digit' })}${late ? ', depois do prazo. Aumente o limite por dia ou inclua o sábado.' : '. Os lembretes saem em seguida, para quem não respondeu.'}`
          : 'No ritmo atual, o 1º contato não termina antes do prazo.') : 'Todas as famílias já receberam o 1º contato.'}
        {capacity < data.remaining_touches ? ' Não cabem todos os lembretes até o prazo: a prioridade é sempre o 1º contato, depois quem parou no meio, depois os lembretes.' : ''}
      </p>
    </section>
  );
}

function Settings({ data, onSaved }) {
  const [form, setForm] = useState(() => toForm(data.settings));
  const [state, setState] = useState({ busy: false, error: '', ok: '' });
  useEffect(() => { setForm(toForm(data.settings)); }, [data.settings]);
  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));
  const toggleDay = (n) => setForm((f) => ({ ...f, weekdays: f.weekdays.includes(n) ? f.weekdays.filter((d) => d !== n) : [...f.weekdays, n].sort() }));
  async function save() {
    setState({ busy: true, error: '', ok: '' });
    try {
      await onSaved({ settings: fromForm(form, data.settings.enabled) });
      setState({ busy: false, error: '', ok: 'Salvo.' });
    } catch (err) {
      setState({ busy: false, error: err.message || 'Não foi possível salvar.', ok: '' });
    }
  }
  const risky = Number(form.daily_cap) > 60 || Number(form.hourly_cap) > 12 || Number(form.min_gap_minutes) < 2;
  return (
    <section className="card">
      <div className="card-head"><div><div className="card-title">Limites e horários</div><div className="card-sub">Valem para todas as mensagens automáticas</div></div></div>
      <div className="au-form">
        <label>Mensagens por dia<input className="control" type="number" min="1" max="200" value={form.daily_cap} onChange={set('daily_cap')} /></label>
        <label>Máximo por hora<input className="control" type="number" min="1" max="30" value={form.hourly_cap} onChange={set('hourly_cap')} /></label>
        <label>Intervalo entre mensagens (min)
          <span className="au-range"><input className="control" type="number" min="1" value={form.min_gap_minutes} onChange={set('min_gap_minutes')} /><em>a</em><input className="control" type="number" min="1" value={form.max_gap_minutes} onChange={set('max_gap_minutes')} /></span>
        </label>
        <label>Horários de envio<input className="control" value={form.windows} onChange={set('windows')} placeholder="08:30-11:30, 13:30-18:00" /></label>
        <label>Contatos por família<input className="control" type="number" min="1" max="5" value={form.max_touches} onChange={set('max_touches')} /></label>
        <label>Dias entre um contato e outro<input className="control" type="number" min="1" max="14" value={form.touch_gap_days} onChange={set('touch_gap_days')} /></label>
        <label>Prazo da condição de outubro<input className="control" type="date" value={form.deadline} onChange={set('deadline')} /></label>
        <div className="au-days"><span>Dias de envio</span><div className="chip-row">{DAYS.map((d) => <button key={d.n} type="button" className={`chip${form.weekdays.includes(d.n) ? ' is-active' : ''}`} onClick={() => toggleDay(d.n)}>{d.label}</button>)}</div></div>
      </div>
      {risky ? <div className="notice au-gap"><span>Acima de 60 por dia, 12 por hora ou com menos de 2 minutos entre as mensagens, o risco de o WhatsApp restringir o número cresce bastante.</span></div> : null}
      <div className="au-actions">
        {state.error ? <span className="au-error">{state.error}</span> : null}
        {state.ok ? <span className="au-ok">{state.ok}</span> : null}
        <button type="button" className="btn btn--primary" disabled={state.busy} onClick={save}>{state.busy ? 'Salvando…' : 'Salvar limites'}</button>
      </div>
      <details className="au-why">
        <summary>Por que esses números</summary>
        <ul>
          <li>O WhatsApp restringe números que mandam muitas mensagens para quem não responde. O que mais pesa é bloqueio e denúncia, e isso cresce com volume e texto repetido.</li>
          <li>30 por dia, no máximo 8 por hora, com 4 a 9 minutos sorteados entre uma e outra, parece uma secretaria mandando mensagens ao longo do dia. Cada mensagem mostra o "digitando…" antes de sair.</li>
          <li>Cada texto tem variações e o nome do responsável e dos alunos, então duas famílias quase nunca recebem a mesma mensagem.</li>
          <li>O 1º contato não leva link e termina com uma pergunta. Resposta da família melhora a reputação do número, e link para quem nunca conversou é o que mais parece spam.</li>
          <li>Se os primeiros dias correrem bem (sem falhas e com respostas), dá para subir aos poucos: 40 e depois 50 por dia. Três falhas seguidas desligam a automação sozinha.</li>
        </ul>
      </details>
    </section>
  );
}

function Templates({ data, onSaved, hints = TEMPLATE_HINT, sub }) {
  const [bodies, setBodies] = useState(() => Object.fromEntries(data.templates.map((t) => [t.key, t.body])));
  const [state, setState] = useState({ busy: false, error: '', ok: '' });
  useEffect(() => { setBodies(Object.fromEntries(data.templates.map((t) => [t.key, t.body]))); }, [data.templates]);
  const dirty = data.templates.some((t) => bodies[t.key] !== t.body);
  async function save() {
    setState({ busy: true, error: '', ok: '' });
    try {
      await onSaved({ templates: data.templates.map((t) => ({ key: t.key, body: bodies[t.key] })) });
      setState({ busy: false, error: '', ok: 'Textos salvos.' });
    } catch (err) {
      setState({ busy: false, error: err.message || 'Não foi possível salvar.', ok: '' });
    }
  }
  return (
    <section className="card">
      <div className="card-head"><div><div className="card-title">Textos</div><div className="card-sub">{sub || <>Use {'{{responsavel}}'}, {'{{alunos}}'}, {'{{prazo}}'}, {'{{etapa}}'} e {'{{link}}'}. Uma linha com --- separa variações: cada família recebe uma delas.</>}</div></div></div>
      <div className="au-templates">
        {data.templates.map((t) => (
          <label key={t.key}>
            <span>{t.label} <small>· {data.by_template?.[t.key] || 0} na fila agora</small></span>
            <small className="au-hint">{hints[t.key]}</small>
            <textarea className="control" rows={Math.min(16, (bodies[t.key] || '').split('\n').length + 2)} value={bodies[t.key] || ''} onChange={(e) => setBodies((b) => ({ ...b, [t.key]: e.target.value }))} />
          </label>
        ))}
      </div>
      <div className="au-actions">
        {state.error ? <span className="au-error">{state.error}</span> : null}
        {state.ok ? <span className="au-ok">{state.ok}</span> : null}
        <button type="button" className="btn btn--primary" disabled={state.busy || !dirty} onClick={save}>{state.busy ? 'Salvando…' : 'Salvar textos'}</button>
      </div>
    </section>
  );
}

function Queue({ data, onSkip, onTest }) {
  const [open, setOpen] = useState(null);
  if (!data.next.length) return <section className="card"><div className="card-title">Próximas da fila</div><p className="au-empty">Ninguém para contatar agora.</p></section>;
  return (
    <section className="card card--flush">
      <div className="au-list-head"><div className="card-title">Próximas da fila</div><div className="card-sub">{data.eligible} famílias podem receber agora. Saem nesta ordem: primeiro quem nunca foi contatado, depois quem parou no meio, depois os lembretes.</div></div>
      {data.next.map((n) => (
        <div key={n.guardian_id} className="au-row">
          <button type="button" className="au-row-main" onClick={() => setOpen(open === n.guardian_id ? null : n.guardian_id)}>
            <strong>{proper(n.name)}</strong>
            <span>{n.students} · {phoneFmt(n.phone)}</span>
            <span className="au-tag">{STAGE[n.stage] || n.stage} · {n.touch}º contato</span>
          </button>
          {open === n.guardian_id ? (
            <div className="au-preview">
              <blockquote className="cmodal-quote">{n.body}</blockquote>
              <div className="au-row-actions">
                <button type="button" className="btn" onClick={() => onTest(n)}>Testar no meu WhatsApp</button>
                <button type="button" className="btn btn--danger" onClick={() => onSkip(n)}>Não enviar para esta família</button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function Recent({ data }) {
  const navigate = useNavigate();
  if (!data.recent.length) return null;
  return (
    <section className="card card--flush">
      <div className="au-list-head"><div className="card-title">Enviadas</div><div className="card-sub">{data.totals.sent} mensagens para {data.totals.families} famílias · {data.totals.replied} responderam{data.totals.failed ? ` · ${data.totals.failed} falharam` : ''}</div></div>
      <div className="au-table-wrap">
        <table className="au-table">
          <thead><tr><th>Quando</th><th>Família</th><th>Contato</th><th>Situação</th></tr></thead>
          <tbody>
            {data.recent.map((r) => (
              <tr key={r.queue_id} title={r.body || ''}>
                <td>{fmt(r.at)}</td>
                <td><button type="button" className="au-link" onClick={() => navigate(`/familias/${r.guardian_id}`)}>{proper(r.name)}</button><small>{phoneFmt(r.phone)}</small></td>
                <td>{r.touch}º</td>
                <td>{r.status === 'enviada' ? (r.replied ? <span className="au-ok">Respondeu</span> : 'Enviada') : r.status === 'falhou' ? <span className="au-error">Falhou{r.error ? `: ${r.error}` : ''}</span> : r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Blocked({ data }) {
  const [open, setOpen] = useState('');
  const entries = Object.entries(data.by_block || {}).filter(([k]) => k !== 'pode_receber').sort((a, b) => b[1] - a[1]);
  return (
    <section className="card">
      <div className="card-head"><div><div className="card-title">Quem fica de fora agora</div><div className="card-sub">A automação nunca escreve para essas famílias enquanto o motivo valer</div></div></div>
      <div className="au-blocks">
        {entries.map(([k, n]) => (
          <div key={k}>
            <button type="button" className="au-block" onClick={() => setOpen(open === k ? '' : k)}><span>{BLOCK[k] || k}</span><strong>{n}</strong></button>
            {open === k ? (
              <ul className="au-block-list">
                {data.blocked_sample.filter((b) => b.block === k).map((b) => <li key={b.guardian_id}>{proper(b.name)} <small>{b.students || ''} · {phoneFmt(b.phone)}</small></li>)}
                {!data.blocked_sample.some((b) => b.block === k) ? <li><small>Lista não exibida para este motivo.</small></li> : null}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Modo Cobrança ──────────────────────────────────────────────────────
   Uma linha por cobrança do Asaas (irmãos já somam numa cobrança só) que
   vence nos próximos dias. Boleto sai com o PDF anexo; Pix, com o copia e
   cola. Quem decide a ordem é `billing_candidates()` no banco. */

const BILLING_BLOCK = {
  pode_receber: 'Vão receber',
  ja_avisado: 'Já receberam esta cobrança',
  tirada_pela_equipe: 'Tiradas pela equipe',
  sem_telefone: 'Sem telefone no cadastro',
  pediu_para_sair: 'Pediram para não receber mensagens',
  sem_boleto: 'Boleto sem PDF ou linha digitável',
  sem_pix: 'Pix sem código'
};

const BILLING_HINT = {
  cobranca_boleto: 'Vai com o PDF do boleto anexo. Use {{responsavel}}, {{alunos}}, {{parcela}}, {{valor}}, {{vencimento}} (vira "amanhã, 10/11" ou "hoje, 10/11"), {{linha}} e {{ajuste}}.',
  cobranca_pix: 'Pagamento à vista no Pix. Use {{pix}} para o copia e cola, além das mesmas variáveis do boleto.',
  cobranca_ajuste_boleto: 'Entra no lugar de {{ajuste}} só para quem não escolheu a forma no site (a escola deixou no boleto).',
  cobranca_ajuste_pix: 'Entra no lugar de {{ajuste}} só para quem não escolheu a forma no site (a escola deixou no Pix).'
};

const money = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dayMonth = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '—');

function ModeSwitch({ mode, busy, onChange }) {
  return (
    <div className="chip-row au-mode">
      <button type="button" className={`chip${mode === 'contato' ? ' is-active' : ''}`} disabled={busy} onClick={() => onChange('contato')}>Contato de rematrícula</button>
      <button type="button" className={`chip${mode === 'cobranca' ? ' is-active' : ''}`} disabled={busy} onClick={() => onChange('cobranca')}>Cobrança (boleto e Pix)</button>
    </div>
  );
}

function BillingStatus({ data, wa, onToggle, busy }) {
  const s = data.settings;
  const tick = s.last_tick_result || {};
  const reason = tick.action === 'send' ? `Última cobrança saiu para ${proper(tick.guardian || '')}.` : tick.reason === 'ninguem_para_cobrar' ? 'Todas as cobranças da lista já saíram.' : TICK[tick.reason] || '';
  const sent = data.recent.filter((r) => r.status === 'enviada');
  const replied = sent.filter((r) => r.replied).length;
  const left = data.eligible;
  const perHour = Math.min(s.hourly_cap, Math.floor(3600 / ((s.min_gap_seconds + s.max_gap_seconds) / 2)));
  return (
    <section className={`card au-status${s.enabled ? ' is-on' : ''}`}>
      <div className="au-status-main">
        <span className="au-pill">{s.enabled ? 'Ligada · cobrança' : 'Desligada · cobrança'}</span>
        <h2>{s.enabled ? 'Enviando as cobranças' : 'As cobranças estão paradas'}</h2>
        <p>
          {s.enabled
            ? data.in_window
              ? `${reason} ${s.next_send_after && new Date(s.next_send_after) > new Date() ? `Próxima a partir de ${fmt(s.next_send_after, { hour: '2-digit', minute: '2-digit' })}.` : ''}`
              : 'Fora do horário de envio agora. Ela continua sozinha no próximo horário.'
            : `Nada é enviado enquanto estiver desligada. ${left} cobranças estão prontas para sair.`}
          {left ? ` No ritmo atual (cerca de ${perHour} por hora), faltam umas ${Math.ceil(left / Math.max(perHour, 1))} h de envio.` : ''}
        </p>
        {s.paused_reason ? <div className="notice"><span><strong>Parou sozinha.</strong> {s.paused_reason}</span></div> : null}
        {wa && !wa.loading && (!wa.configured || !wa.connected) ? (
          <div className="notice"><span>{!wa.configured ? 'O envio não está configurado: faltam UAZAPI_BASE_URL e UAZAPI_TOKEN nos segredos do Supabase.' : 'O WhatsApp da escola está desconectado na UAZAPI. Nada sai até reconectar.'}</span></div>
        ) : null}
      </div>
      <div className="au-status-side">
        <div className="au-num"><strong>{left}</strong><span>cobranças para enviar</span></div>
        <div className="au-num"><strong>{data.counts.today}</strong><span>de {s.daily_cap} hoje · {data.counts.last_hour} na última hora</span></div>
        <div className="au-num"><strong>{replied}</strong><span>de {sent.length} famílias responderam</span></div>
        <button type="button" className={`btn ${s.enabled ? 'btn--danger' : 'btn--primary'} au-toggle`} disabled={busy} onClick={onToggle}>
          {s.enabled ? 'Desligar agora' : 'Ligar as cobranças'}
        </button>
        <span className="meta">WhatsApp: {wa?.loading ? 'verificando…' : wa?.connected ? 'conectado' : wa?.configured ? 'desconectado' : 'sem configuração'}</span>
      </div>
    </section>
  );
}

function BillingWindow({ data, onLeadDays, busy }) {
  const [days, setDays] = useState(data.settings.billing_lead_days);
  useEffect(() => { setDays(data.settings.billing_lead_days); }, [data.settings.billing_lead_days]);
  const groups = useMemo(() => {
    const map = new Map();
    for (const c of data.candidates.filter((x) => !x.block)) {
      const key = `${c.due_date}|${c.method}`;
      const g = map.get(key) || { due: c.due_date, method: c.method, n: 0, cents: 0, escola: 0 };
      g.n += 1; g.cents += Number(c.amount_cents || 0); if (c.school_chose) g.escola += 1;
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => a.due.localeCompare(b.due));
  }, [data.candidates]);
  const until = new Date(`${data.today}T12:00:00-03:00`);
  until.setDate(until.getDate() + Number(data.settings.billing_lead_days));
  return (
    <section className="card">
      <div className="card-head"><div><div className="card-title">Quais vencimentos entram</div><div className="card-sub">Cobranças que vencem de hoje até {fmt(until, { day: '2-digit', month: '2-digit' })}. Cartão não entra: o Asaas debita sozinho.</div></div></div>
      <div className="au-form">
        <label>Mandar quantos dias antes do vencimento
          <span className="au-range"><input className="control" type="number" min="0" max="45" value={days} onChange={(e) => setDays(e.target.value)} />
            <button type="button" className="btn" disabled={busy || Number(days) === data.settings.billing_lead_days} onClick={() => onLeadDays(Number(days))}>Aplicar</button></span>
        </label>
      </div>
      <div className="au-plan">
        {groups.length ? groups.map((g) => (
          <div key={`${g.due}${g.method}`}><strong>{g.n}</strong><span>{g.method === 'pix' ? 'Pix' : 'boletos'} de {dayMonth(g.due)} · {money(g.cents)}{g.escola ? ` · ${g.escola} com forma definida pela escola` : ''}</span></div>
        )) : <div><strong>0</strong><span>cobranças nesse período</span></div>}
      </div>
    </section>
  );
}

function BillingList({ data, onSkip, onTest }) {
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('pode_receber');
  const rows = data.candidates.filter((c) => (c.block || 'pode_receber') === filter);
  const entries = Object.entries(data.by_block || {}).sort((a, b) => (a[0] === 'pode_receber' ? -1 : b[0] === 'pode_receber' ? 1 : b[1] - a[1]));
  return (
    <section className="card card--flush">
      <div className="au-list-head">
        <div className="card-title">Quem vai ser avisado</div>
        <div className="card-sub">Saem nesta ordem, do vencimento mais próximo para o mais distante. Clique na família para ver a mensagem.</div>
        <div className="chip-row au-gap">{entries.map(([k, n]) => <button key={k} type="button" className={`chip${filter === k ? ' is-active' : ''}`} onClick={() => setFilter(k)}>{BILLING_BLOCK[k] || k} · {n}</button>)}</div>
      </div>
      {!rows.length ? <p className="au-empty">Ninguém aqui.</p> : rows.map((c, i) => (
        <div key={c.charge_id} className="au-row">
          <button type="button" className="au-row-main" onClick={() => setOpen(open === c.charge_id ? null : c.charge_id)}>
            <strong>{filter === 'pode_receber' ? `${i + 1}. ` : ''}{proper(c.name)}</strong>
            <span>{c.students} · {phoneFmt(c.phone)}</span>
            <span className="au-tag">{c.method === 'pix' ? 'Pix' : 'Boleto'} · {c.parcela} · {money(c.amount_cents)} · vence {dayMonth(c.due_date)}{c.school_chose ? ' · forma definida pela escola' : ''}</span>
          </button>
          {open === c.charge_id ? (
            <div className="au-preview">
              <blockquote className="cmodal-quote">{c.body}</blockquote>
              {c.has_pdf ? <p className="meta">📎 Vai com o PDF do boleto anexo. <a href={c.media_url} target="_blank" rel="noreferrer">Abrir o boleto</a></p> : null}
              <div className="au-row-actions">
                <button type="button" className="btn" onClick={() => onTest(c)}>Testar no meu WhatsApp</button>
                {c.block === 'tirada_pela_equipe'
                  ? <button type="button" className="btn" onClick={() => onSkip(c, false)}>Voltar para a lista</button>
                  : !c.block ? <button type="button" className="btn btn--danger" onClick={() => onSkip(c, true)}>Não enviar esta cobrança</button> : null}
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function BillingRecent({ data }) {
  const navigate = useNavigate();
  const rows = data.recent.filter((r) => r.status !== 'cancelada');
  if (!rows.length) return null;
  return (
    <section className="card card--flush">
      <div className="au-list-head"><div className="card-title">Cobranças enviadas</div><div className="card-sub">{rows.filter((r) => r.status === 'enviada').length} enviadas{rows.some((r) => r.status === 'falhou') ? ` · ${rows.filter((r) => r.status === 'falhou').length} falharam` : ''}</div></div>
      <div className="au-table-wrap">
        <table className="au-table">
          <thead><tr><th>Quando</th><th>Família</th><th>Situação</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.queue_id} title={r.body || ''}>
                <td>{fmt(r.at)}</td>
                <td><button type="button" className="au-link" onClick={() => navigate(`/familias/${r.guardian_id}`)}>{proper(r.name)}</button><small>{phoneFmt(r.phone)}</small></td>
                <td>{r.status === 'enviada' ? (r.replied ? <span className="au-ok">Respondeu</span> : 'Enviada') : r.status === 'falhou' ? <span className="au-error">Falhou{r.error ? `: ${r.error}` : ''}</span> : r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Cobranca({ wa, onMode, modeBusy }) {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [testPhone, setTestPhone] = useState(() => { try { return localStorage.getItem('cec_automation_test_phone') || ''; } catch { return ''; } });

  const load = useCallback(() => getBilling()
    .then((data) => setState({ loading: false, error: '', data }))
    .catch((error) => setState((s) => ({ ...s, loading: false, error: error.message || String(error) }))), []);
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);
  const data = state.data;

  const saveShared = useCallback(async (payload) => { await saveAutomation(payload); await load(); }, [load]);
  const templatesData = useMemo(() => (data ? {
    templates: data.templates.map((t) => ({ ...t })),
    by_template: data.candidates.filter((c) => !c.block).reduce((acc, c) => {
      const k = c.method === 'pix' ? 'cobranca_pix' : 'cobranca_boleto';
      acc[k] = (acc[k] || 0) + 1;
      if (c.school_chose) acc[`cobranca_ajuste_${c.method === 'pix' ? 'pix' : 'boleto'}`] = (acc[`cobranca_ajuste_${c.method === 'pix' ? 'pix' : 'boleto'}`] || 0) + 1;
      return acc;
    }, {})
  } : null), [data]);

  async function run(fn, ok) {
    setBusy(true);
    try { const fresh = await fn(); if (fresh?.settings) setState({ loading: false, error: '', data: fresh }); else await load(); setModal(null); if (ok) setNote(ok); }
    catch (err) { setNote(err.message || 'Não foi possível.'); }
    finally { setBusy(false); }
  }

  if (state.loading && !data) return <div className="kcol-empty">Carregando…</div>;
  if (state.error && !data) return <div className="notice"><span>{state.error}</span></div>;
  const first = data.candidates.filter((c) => !c.block).slice(0, 3);

  return (
    <div className="au-page">
      <ModeSwitch mode="cobranca" busy={modeBusy || busy} onChange={onMode} />
      <BillingStatus data={data} wa={wa} busy={busy} onToggle={() => setModal({ kind: 'toggle' })} />
      {note ? <div className="notice notice--soft au-note"><p>{note}</p><button type="button" className="btn btn--ghost" onClick={() => setNote('')}>Fechar</button></div> : null}
      <BillingWindow data={data} busy={busy} onLeadDays={(d) => run(() => setAutomationMode('cobranca', d))} />
      <BillingList data={data} onSkip={(row, skip) => setModal({ kind: 'skip', row, skip })} onTest={(row) => setModal({ kind: 'test', row })} />
      <BillingRecent data={data} />
      <Settings data={data} onSaved={saveShared} />
      <Templates data={templatesData} onSaved={saveShared} hints={BILLING_HINT}
        sub="Uma linha com --- separa variações: cada família recebe uma delas." />

      {modal?.kind === 'toggle' ? (
        <ConfirmModal
          title={data.settings.enabled ? 'Desligar as cobranças?' : 'Ligar as cobranças?'}
          confirmLabel={data.settings.enabled ? 'Desligar' : 'Ligar e começar a enviar'}
          danger={data.settings.enabled}
          busy={busy}
          onConfirm={() => run(async () => { await saveAutomation({ settings: fromForm(toForm(data.settings), !data.settings.enabled) }); return null; })}
          onClose={() => setModal(null)}
        >
          {data.settings.enabled ? (
            <p className="cmodal-text">Nenhuma cobrança nova sai depois disso. A IA segue respondendo quem escrever.</p>
          ) : (
            <>
              <p className="cmodal-text">As cobranças vão sair do WhatsApp da escola, uma família por vez: até <strong>{data.settings.hourly_cap} por hora</strong> e <strong>{data.settings.daily_cap} por dia</strong>, com {Math.round(data.settings.min_gap_seconds / 60)} a {Math.round(data.settings.max_gap_seconds / 60)} minutos entre uma e outra, só em {data.settings.windows}. São <strong>{data.eligible} cobranças</strong>. As primeiras:</p>
              <ul className="cmodal-list">{first.map((c) => <li key={c.charge_id}><strong>{proper(c.name)}</strong> <span>{c.students} · {money(c.amount_cents)} · {dayMonth(c.due_date)}</span></li>)}</ul>
              {first[0] ? <blockquote className="cmodal-quote">{first[0].body}</blockquote> : null}
              {wa && !wa.loading && !wa.connected ? <div className="notice"><span>O WhatsApp aparece desconectado agora. Nada sai até reconectar.</span></div> : null}
            </>
          )}
        </ConfirmModal>
      ) : null}
      {modal?.kind === 'skip' ? (
        <ConfirmModal title={modal.skip ? 'Não enviar esta cobrança?' : 'Voltar para a lista?'} confirmLabel={modal.skip ? 'Tirar da lista' : 'Voltar'} danger={modal.skip} busy={busy}
          onConfirm={() => run(() => skipBillingCharge(modal.row.charge_id, modal.skip))} onClose={() => setModal(null)}>
          <p className="cmodal-text">{modal.skip
            ? <>A cobrança de <strong>{proper(modal.row.name)}</strong> com vencimento em {dayMonth(modal.row.due_date)} não vai ser enviada pela automação. As próximas parcelas da família continuam entrando normalmente.</>
            : <>A cobrança de <strong>{proper(modal.row.name)}</strong> volta para a lista de envio.</>}</p>
        </ConfirmModal>
      ) : null}
      {modal?.kind === 'test' ? (
        <ConfirmModal title="Testar no seu WhatsApp" confirmLabel="Enviar teste" busy={busy}
          onConfirm={() => run(async () => {
            try { localStorage.setItem('cec_automation_test_phone', testPhone); } catch { /* sem armazenamento */ }
            await automationAction('test', { phone: testPhone, text: modal.row.body, media_url: modal.row.media_url || undefined, doc_name: 'Boleto CEC (teste).pdf' });
            return null;
          }, `Teste enviado para ${phoneFmt(testPhone)}.`)}
          onClose={() => setModal(null)}>
          <p className="cmodal-text">A cobrança que {proper(modal.row.name)} receberia vai para o número abaixo, marcada como teste{modal.row.has_pdf ? ', com o PDF do boleto' : ''}. A família não recebe nada.</p>
          <div className="cmodal-fields"><label>Seu WhatsApp<input className="control" value={testPhone} placeholder="(33) 99999-9999" onChange={(e) => setTestPhone(e.target.value)} /></label></div>
          <blockquote className="cmodal-quote">{modal.row.body}</blockquote>
        </ConfirmModal>
      ) : null}
    </div>
  );
}

export default function Automacao() {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [wa, setWa] = useState({ loading: true });
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testPhone, setTestPhone] = useState(() => { try { return localStorage.getItem('cec_automation_test_phone') || ''; } catch { return ''; } });
  const [note, setNote] = useState('');

  const load = useCallback(() => getAutomation()
    .then((data) => setState({ loading: false, error: '', data }))
    .catch((error) => setState((s) => ({ ...s, loading: false, error: error.message || String(error) }))), []);
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);
  useEffect(() => { automationAction('status').then((r) => setWa({ loading: false, ...r })).catch(() => setWa({ loading: false, configured: false, connected: false })); }, []);

  const data = state.data;
  const save = useCallback(async (payload) => { const fresh = await saveAutomation(payload); setState({ loading: false, error: '', data: fresh }); return fresh; }, []);

  async function confirmToggle() {
    setBusy(true);
    try {
      await save({ settings: fromForm(toForm(data.settings), !data.settings.enabled) });
      setModal(null);
    } catch (err) {
      setNote(err.message || 'Não foi possível mudar.');
    } finally { setBusy(false); }
  }
  async function confirmSkip() {
    setBusy(true);
    try {
      await setFollowupStatus([modal.row.phone], true, { aiOff: false, reason: 'Família: não seguir agora', note: 'Tirada da automação' });
      setModal(null);
      await load();
    } catch (err) { setNote(err.message || 'Não foi possível tirar.'); } finally { setBusy(false); }
  }
  async function confirmTest() {
    setBusy(true);
    try {
      try { localStorage.setItem('cec_automation_test_phone', testPhone); } catch { /* sem armazenamento */ }
      await automationAction('test', { phone: testPhone, text: modal.row.body });
      setNote(`Teste enviado para ${phoneFmt(testPhone)}.`);
      setModal(null);
    } catch (err) { setNote(err.message || 'O teste não saiu.'); } finally { setBusy(false); }
  }

  const sample = useMemo(() => data?.next?.slice(0, 3) || [], [data]);
  const [modeBusy, setModeBusy] = useState(false);
  async function changeMode(mode) {
    if (mode === (data?.settings?.mode || 'contato')) return;
    setModeBusy(true);
    try { await setAutomationMode(mode); await load(); }
    catch (err) { setNote(err.message || 'Não foi possível trocar o modo.'); }
    finally { setModeBusy(false); }
  }

  if (state.loading && !data) return <div className="kcol-empty">Carregando…</div>;
  if (state.error && !data) return <div className="notice"><span>{state.error}</span></div>;
  if (data.settings.mode === 'cobranca') return <Cobranca wa={wa} onMode={changeMode} modeBusy={modeBusy} />;

  return (
    <div className="au-page">
      <ModeSwitch mode="contato" busy={modeBusy} onChange={changeMode} />
      <Status data={data} wa={wa} busy={busy} onToggle={() => setModal({ kind: 'toggle' })} />
      {note ? <div className="notice notice--soft au-note"><p>{note}</p><button type="button" className="btn btn--ghost" onClick={() => setNote('')}>Fechar</button></div> : null}
      <Plan data={data} />
      <div className="au-grid">
        <Queue data={data} onSkip={(row) => setModal({ kind: 'skip', row })} onTest={(row) => setModal({ kind: 'test', row })} />
        <Blocked data={data} />
      </div>
      <Recent data={data} />
      <Settings data={data} onSaved={save} />
      <Templates data={data} onSaved={save} />

      {modal?.kind === 'toggle' ? (
        <ConfirmModal
          title={data.settings.enabled ? 'Desligar a automação?' : 'Ligar a automação?'}
          confirmLabel={data.settings.enabled ? 'Desligar' : 'Ligar e começar a enviar'}
          danger={data.settings.enabled}
          busy={busy}
          onConfirm={confirmToggle}
          onClose={() => setModal(null)}
        >
          {data.settings.enabled ? (
            <p className="cmodal-text">Nenhuma mensagem nova sai depois disso. O que já foi enviado continua nas conversas, e a IA segue respondendo quem escrever.</p>
          ) : (
            <>
              <p className="cmodal-text">As mensagens vão sair do WhatsApp da escola, uma família por vez: até <strong>{data.settings.daily_cap} por dia</strong> e <strong>{data.settings.hourly_cap} por hora</strong>, com {Math.round(data.settings.min_gap_seconds / 60)} a {Math.round(data.settings.max_gap_seconds / 60)} minutos entre uma e outra, só em {data.settings.windows}. Hoje <strong>{data.eligible} famílias</strong> podem receber. As primeiras serão:</p>
              <ul className="cmodal-list">{sample.map((s) => <li key={s.guardian_id}><strong>{proper(s.name)}</strong> <span>{s.students}</span></li>)}</ul>
              {sample[0] ? <blockquote className="cmodal-quote">{sample[0].body}</blockquote> : null}
              {wa && !wa.loading && !wa.connected ? <div className="notice"><span>O WhatsApp aparece desconectado agora. Nada sai até reconectar.</span></div> : null}
            </>
          )}
        </ConfirmModal>
      ) : null}
      {modal?.kind === 'skip' ? (
        <ConfirmModal title="Não enviar para esta família?" confirmLabel="Tirar da automação" danger busy={busy} onConfirm={confirmSkip} onClose={() => setModal(null)}>
          <p className="cmodal-text"><strong>{proper(modal.row.name)}</strong> sai da automação e fica em "Desativados" no follow-up, com o motivo "Família: não seguir agora". A IA continua respondendo se a família escrever. Para voltar, reative no follow-up.</p>
        </ConfirmModal>
      ) : null}
      {modal?.kind === 'test' ? (
        <ConfirmModal title="Testar no seu WhatsApp" confirmLabel="Enviar teste" busy={busy} onConfirm={confirmTest} onClose={() => setModal(null)}>
          <p className="cmodal-text">O texto que {proper(modal.row.name)} receberia vai para o número abaixo, marcado como teste. A família não recebe nada.</p>
          <div className="cmodal-fields"><label>Seu WhatsApp<input className="control" value={testPhone} placeholder="(33) 99999-9999" onChange={(e) => setTestPhone(e.target.value)} /></label></div>
          <blockquote className="cmodal-quote">{modal.row.body}</blockquote>
        </ConfirmModal>
      ) : null}
    </div>
  );
}
