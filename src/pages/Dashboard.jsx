import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDashboardStats } from '../services/data';
import { money } from '../lib/format';

/* Dashboard da campanha. Todos os números vêm de staff_dashboard(), que usa
   as mesmas etapas do quadro de Jornadas — os dois sempre batem.
   Cores: azul/laranja validados para daltonismo; rampa de azuis para etapas. */
const C = {
  series1: '#3A5FBF',
  series2: '#E4581C',
  ramp: ['#233A7A', '#4A7BD8', '#9DB6EA'],
  track: '#EFE7DB',
  ok: '#25794A',
  bad: '#C0392B'
};

const pct = (value, total) => (total ? Math.round((Number(value || 0) / total) * 100) : 0);
const int = (value) => new Intl.NumberFormat('pt-BR').format(Number(value || 0));
const shortMoney = (cents) => {
  const value = Number(cents || 0) / 100;
  if (value >= 1000) return `R$ ${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value / 1000)} mil`;
  return money(cents);
};
const dayLabel = (iso) => { const [, m, d] = String(iso).split('-'); return `${d}/${m}`; };
const weekday = (iso) => new Intl.DateTimeFormat('pt-BR', { weekday: 'short' }).format(new Date(`${iso}T12:00:00`)).replace('.', '');

/* --- Tooltip compartilhado ------------------------------------------------ */
function useTooltip() {
  const [tip, setTip] = useState(null);
  const show = useCallback((event, content) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ x: rect.left + rect.width / 2, y: rect.top, content });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const node = tip ? (
    <div className="dz-tip" style={{ left: Math.min(Math.max(tip.x, 110), window.innerWidth - 110), top: tip.y }} role="status">
      {tip.content}
    </div>
  ) : null;
  return { show, hide, node };
}

const hoverProps = (tt, content) => ({
  onMouseEnter: (e) => tt.show(e, content),
  onMouseLeave: tt.hide,
  onFocus: (e) => tt.show(e, content),
  onBlur: tt.hide,
  tabIndex: 0
});

/* --- Peças ---------------------------------------------------------------- */
function Panel({ title, sub, right, children, className = '' }) {
  return (
    <section className={`card dz-panel ${className}`}>
      <header className="dz-panel-head">
        <div><h2 className="card-title">{title}</h2>{sub ? <p className="card-sub">{sub}</p> : null}</div>
        {right}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`dz-stat${onClick ? ' is-link' : ''}${tone ? ` tone-${tone}` : ''}`} onClick={onClick}>
      <span className="dz-stat-label">{label}</span>
      <span className="dz-stat-value">{value}</span>
      {sub ? <span className="dz-stat-sub">{sub}</span> : null}
    </Tag>
  );
}

function Legend({ items }) {
  return (
    <div className="dz-legend">
      {items.map(([label, color, value]) => (
        <span key={label}><i style={{ background: color }} />{label}{value != null ? <b>{value}</b> : null}</span>
      ))}
    </div>
  );
}

/** Barra empilhada de parte-do-todo, com 2px de respiro entre os segmentos. */
function StackBar({ segments, total, tt, height = 14 }) {
  return (
    <div className="dz-stack" style={{ height }}>
      {segments.filter(([, value]) => value > 0).map(([label, value, color]) => (
        <span
          key={label}
          className="dz-stack-seg"
          style={{ flexGrow: value, background: color }}
          {...hoverProps(tt, <><strong>{label}</strong><span>{int(value)} · {pct(value, total)}%</span></>)}
          aria-label={`${label}: ${value}`}
        />
      ))}
    </div>
  );
}

/** Funil acumulado: cada etapa conta quem chegou nela ou além. */
function Funnel({ steps, tt }) {
  const top = steps[0]?.[1] || 0;
  return (
    <div className="dz-funnel">
      {steps.map(([label, value, hint], index) => {
        const prev = index ? steps[index - 1][1] : null;
        return (
          <div className="dz-funnel-row" key={label} {...hoverProps(tt, <><strong>{label}</strong><span>{int(value)} famílias · {pct(value, top)}% da base</span>{prev != null ? <span>{pct(value, prev)}% da etapa anterior</span> : null}<em>{hint}</em></>)}>
            <div className="dz-funnel-label"><strong>{label}</strong><span>{hint}</span></div>
            <div className="dz-funnel-track"><i style={{ width: `${Math.max(pct(value, top), value ? 1.2 : 0)}%`, background: index === 0 ? C.ramp[2] : C.series1 }} /></div>
            <div className="dz-funnel-num"><strong>{int(value)}</strong><span>{index ? `${pct(value, top)}%` : 'base'}</span></div>
            {prev != null ? <div className="dz-funnel-conv">{prev ? `${pct(value, prev)}% →` : '—'}</div> : <div className="dz-funnel-conv" />}
          </div>
        );
      })}
    </div>
  );
}

/** Colunas agrupadas por dia (duas séries, um eixo só). */
function DailyColumns({ days: allDays, series, tt }) {
  // Começa no primeiro dia com movimento (com 2 dias de folga), mostrando no mínimo 7 dias.
  const firstActive = allDays.findIndex((d) => series.some(([key]) => Number(d[key] || 0) > 0));
  const start = firstActive < 0 ? allDays.length - 7 : Math.min(Math.max(firstActive - 2, 0), allDays.length - 7);
  const days = allDays.slice(Math.max(start, 0));
  const totals = series.map(([key, label, color]) => [label, color, days.reduce((sum, d) => sum + Number(d[key] || 0), 0)]);
  const max = Math.max(1, ...days.flatMap((d) => series.map(([key]) => Number(d[key] || 0))));
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const W = 640; const H = 190; const padL = 28; const padB = 26; const padT = 8;
  const plotW = W - padL - 4; const plotH = H - padB - padT;
  const band = plotW / days.length;
  const barW = Math.min(16, (band - 10) / series.length);
  const y = (v) => padT + plotH - (v / top) * plotH;
  return (
    <div className="dz-cols">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Atividade por dia">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - 4} y1={y(t)} y2={y(t)} stroke="#EFE7DB" strokeWidth="1" />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" className="dz-axis">{t}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x0 = padL + i * band + (band - barW * series.length - 2 * (series.length - 1)) / 2;
          const every = days.length > 14 ? 3 : days.length > 9 ? 2 : 1;
          const showLabel = i % every === (days.length - 1) % every;
          return (
            <g key={d.day}>
              {series.map(([key, , color], s) => {
                const v = Number(d[key] || 0);
                const h = (v / top) * plotH;
                const x = x0 + s * (barW + 2);
                return v > 0 ? <path key={key} d={`M${x},${y(0)} v${-Math.max(h - 3, 0)} q0,-3 3,-3 h${barW - 6} q3,0 3,3 v${Math.max(h - 3, 0)} z`} fill={color} /> : null;
              })}
              <rect
                x={padL + i * band} y={padT} width={band} height={plotH} fill="transparent" className="dz-hit"
                {...hoverProps(tt, <><strong>{weekday(d.day)}, {dayLabel(d.day)}</strong>{series.map(([key, label]) => <span key={key}>{label}: {int(d[key])}</span>)}</>)}
              />
              {showLabel ? <text x={padL + i * band + band / 2} y={H - 8} textAnchor="middle" className="dz-axis">{dayLabel(d.day)}</text> : null}
            </g>
          );
        })}
        <line x1={padL} x2={W - 4} y1={y(0)} y2={y(0)} stroke="#DCCBB5" strokeWidth="1" />
      </svg>
      <div className="dz-cols-total">
        {totals.map(([label, color, total]) => <span key={label}><i style={{ background: color }} /><b>{int(total)}</b> {label.toLowerCase()} no período</span>)}
      </div>
    </div>
  );
}

/** Adesão por série: assinados (escuro) + em andamento (claro) sobre o total elegível. */
function GradeBars({ grades, tt }) {
  return (
    <div className="dz-grades">
      {grades.map((g) => {
        const eligible = Number(g.elegiveis || 0);
        const signed = Number(g.assinados || 0);
        const going = Math.max(Number(g.em_jornada || 0) - signed, 0);
        const closed = !eligible;
        return (
          <div
            className={`dz-grade${closed ? ' is-closed' : ''}`}
            key={g.grade_name}
            {...hoverProps(tt, closed
              ? <><strong>{g.grade_name}</strong><span>{g.alunos} alunos concluem o ciclo em 2026</span></>
              : <><strong>{g.grade_name} → {g.next_grade_name}</strong><span>{signed} de {eligible} assinaram ({pct(signed, eligible)}%)</span>{going ? <span>{going} em andamento</span> : null}</>)}
          >
            <div className="dz-grade-name"><strong>{g.grade_name}</strong><span>{closed ? 'conclui o ciclo' : `→ ${g.next_grade_name}`}</span></div>
            <div className="dz-grade-track">
              {closed ? null : <>
                {signed ? <i style={{ width: `${pct(signed, eligible)}%`, background: C.ramp[0] }} /> : null}
                {going ? <i style={{ width: `${pct(going, eligible)}%`, background: C.ramp[2] }} /> : null}
              </>}
            </div>
            <div className="dz-grade-num">{closed ? `${g.alunos} alunos` : <><strong>{signed}</strong> de {eligible}<span>{pct(signed, eligible)}%</span></>}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Lista de barras simples (uma série, uma cor). */
function BarList({ rows, tt, format = int, color = C.series1 }) {
  const max = Math.max(1, ...rows.map(([, v]) => Number(v || 0)));
  const total = rows.reduce((sum, [, v]) => sum + Number(v || 0), 0);
  return (
    <div className="dz-barlist">
      {rows.map(([label, value, sub, rowColor]) => (
        <div className="dz-barlist-row" key={label} {...hoverProps(tt, <><strong>{label}</strong><span>{format(value)}{total ? ` · ${pct(value, total)}%` : ''}</span>{sub ? <em>{sub}</em> : null}</>)}>
          <span className="dz-barlist-label">{label}{sub ? <small>{sub}</small> : null}</span>
          <span className="dz-barlist-track"><i style={{ width: `${value ? Math.max((value / max) * 100, 3) : 0}%`, background: rowColor || color }} /></span>
          <span className="dz-barlist-num">{format(value)}</span>
        </div>
      ))}
    </div>
  );
}

/* --- Página --------------------------------------------------------------- */
export default function Dashboard() {
  const navigate = useNavigate();
  const tt = useTooltip();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setState({ loading: false, error: null, data: await getDashboardStats() });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message || 'Não foi possível carregar o dashboard.' }));
    }
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 120000);
    return () => window.clearInterval(timer);
  }, [load]);

  const d = state.data;
  const view = useMemo(() => {
    if (!d) return null;
    const st = d.remat_board?.stages || {};
    const n = (...keys) => keys.reduce((sum, k) => sum + Number(st[k] || 0), 0);
    const families = Number(d.remat_board?.families || 0);
    const signedFamilies = n('cobranca', 'pagamento', 'concluida');
    const inJourney = n('identificacao', 'alunos', 'condicoes', 'assinatura');
    const talking = n('conversa');
    const toContact = n('a_contatar');
    const lost = n('perdida');
    const contacted = families - toContact;
    const baseSigned = (d.by_grade || []).reduce((sum, g) => sum + Number(g.assinados || 0), 0);
    const eligible = Number(d.students?.elegiveis || 0);
    const daysLeft = d.early_until ? Math.round((new Date(`${d.early_until}T12:00:00`) - new Date(`${d.today}T12:00:00`)) / 86400000) : null;
    const nova = d.nova_board?.stages || {};
    const nn = (...keys) => keys.reduce((sum, k) => sum + Number(nova[k] || 0), 0);
    return {
      families, signedFamilies, inJourney, talking, toContact, lost, contacted, baseSigned, eligible, daysLeft,
      funnel: [
        ['Base 2026', families, 'famílias com filhos no CEC'],
        ['Contatadas', contacted, 'já conversaram no WhatsApp'],
        ['Abriram a jornada', n('identificacao', 'alunos', 'condicoes', 'assinatura', 'cobranca', 'pagamento', 'concluida'), 'acessaram o link'],
        ['Escolheram o plano', n('assinatura', 'cobranca', 'pagamento', 'concluida'), 'definiram as parcelas'],
        ['Assinaram', signedFamilies, 'contrato assinado'],
        ['Pagaram', n('concluida'), 'pagamento confirmado']
      ],
      nova: {
        conversa: nn('conversa', 'a_contatar'), cadastro: nn('dados', 'identificacao', 'alunos'),
        decidindo: nn('condicoes', 'assinatura'), assinaram: nn('cobranca', 'pagamento', 'concluida'),
        anonymous: Number(d.nova_board?.anonymous || 0), families: Number(d.nova_board?.families || 0)
      },
      human: Number(d.remat_board?.needs_human || 0) + Number(d.nova_board?.needs_human || 0)
    };
  }, [d]);

  if (state.error && !d) return <div className="notice"><strong>Não foi possível carregar.</strong><span>{state.error}</span></div>;
  if (!d || !view) return <div className="notice">Carregando o dashboard…</div>;

  const f = d.finance || {};
  const w = d.whatsapp || {};
  const plans = d.plans || {};
  const billing = d.billing || {};
  const signedTotal = Object.values(plans).reduce((s, v) => s + Number(v || 0), 0);
  const billingChosen = Object.values(billing).reduce((s, v) => s + Number(v || 0), 0);
  const publicUrl = `${window.location.origin}/matricula`;
  const replies = Number(w.total_ia || 0) + Number(w.total_equipe || 0);

  return (
    <div className="dz">
      {/* Prazo e atalhos */}
      <div className="dz-strip">
        {view.daysLeft != null && view.daysLeft >= 0 ? (
          <div className="dz-deadline">
            <strong>{view.daysLeft === 0 ? 'Hoje' : `${view.daysLeft} dias`}</strong>
            <span>{view.daysLeft === 0 ? 'é o último dia' : 'para o fim'} do valor de outubro · até {dayLabel(d.early_until)}</span>
          </div>
        ) : <div className="dz-deadline"><span>Valor de outubro encerrado; vale a tabela 2027</span></div>}
        <div className="dz-strip-actions">
          {view.human ? <button type="button" className="btn btn--orange" onClick={() => navigate('/jornadas')}>{view.human} famílias precisam de humano →</button> : null}
          <button type="button" className="btn" onClick={async () => { await navigator.clipboard?.writeText(publicUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }}>{copied ? 'Link copiado' : 'Copiar link de matrícula nova'}</button>
        </div>
      </div>

      {/* Destaque: alunos rematriculados + composição das famílias */}
      <section className="card dz-hero">
        <div className="dz-hero-main">
          <span className="dz-stat-label">Alunos rematriculados para {d.campaign?.academic_year}</span>
          <div className="dz-hero-figure"><strong>{int(view.baseSigned)}</strong><span>de {int(view.eligible)} alunos elegíveis</span></div>
          <div className="dz-meter"><i style={{ width: `${Math.max(pct(view.baseSigned, view.eligible), view.baseSigned ? 1 : 0)}%` }} /></div>
          <span className="dz-hero-sub">
            {pct(view.baseSigned, view.eligible)}% da base · {d.students?.concluem_ciclo || 0} alunos do 9º ano concluem o ciclo
            {d.students?.novos_assinados ? ` · +${d.students.novos_assinados} alunos novos assinados` : ''}
          </span>
        </div>
        <div className="dz-hero-side">
          <span className="dz-stat-label">Onde estão as {int(view.families)} famílias da base</span>
          <StackBar
            tt={tt}
            total={view.families}
            height={18}
            segments={[
              ['Assinaram', view.signedFamilies, C.ramp[0]],
              ['Na jornada', view.inJourney, C.ramp[1]],
              ['Em conversa', view.talking, C.ramp[2]],
              ['A contatar', view.toContact, C.track],
              ['Sem interesse', view.lost, '#6B6A63']
            ]}
          />
          <Legend items={[
            ['Assinaram', C.ramp[0], view.signedFamilies],
            ['Na jornada', C.ramp[1], view.inJourney],
            ['Em conversa', C.ramp[2], view.talking],
            ['A contatar', C.track, view.toContact],
            ...(view.lost ? [['Sem interesse', '#6B6A63', view.lost]] : [])
          ]} />
        </div>
      </section>

      {/* Indicadores */}
      <div className="dz-stats">
        <Stat label="Famílias contatadas" value={int(view.contacted)} sub={`${pct(view.contacted, view.families)}% da base · ${int(view.toContact)} ainda não`} />
        <Stat label="Contratos assinados" value={int(signedTotal)} sub={`alunos · ${shortMoney(f.contratado_cents)} em matrículas`} />
        <Stat label="Precisam de humano" value={int(view.human)} sub="abrir no quadro de jornadas" tone={view.human ? 'warn' : undefined} onClick={() => navigate('/jornadas')} />
        <Stat label="Matrículas novas" value={int(view.nova.families)} sub={`${view.nova.conversa} em conversa · ${view.nova.decidindo + view.nova.assinaram} no contrato`} />
      </div>

      <div className="dz-grid">
        <Panel title="Funil da rematrícula" sub="Quantas famílias chegaram a cada etapa (ou além)">
          <Funnel steps={view.funnel} tt={tt} />
        </Panel>
        <Panel
          title="Atividade por dia"
          sub="Jornadas iniciadas e contratos assinados, desde o início do movimento"
          right={<Legend items={[['Jornadas iniciadas', C.series1], ['Alunos assinados', C.series2]]} />}
        >
          <DailyColumns days={d.daily || []} series={[['jornadas', 'Jornadas iniciadas', C.series1], ['assinados', 'Alunos assinados', C.series2]]} tt={tt} />
        </Panel>
      </div>

      <Panel
        title="Adesão por série"
        sub="Alunos de 2026 que já assinaram a rematrícula, pela série que cursam hoje"
        right={<Legend items={[['Assinaram', C.ramp[0]], ['Em andamento', C.ramp[2]]]} />}
      >
        <GradeBars grades={d.by_grade || []} tt={tt} />
      </Panel>

      <div className="dz-grid dz-grid--even">
        <Panel title="Financeiro das matrículas" sub="Valor de matrícula/rematrícula 2027, no preço vigente">
          <div className="dz-money">
            <Stat label="Contratado" value={shortMoney(f.contratado_cents)} sub={`${pct(f.contratado_cents, f.potencial_cents)}% do potencial`} />
            <Stat label="Recebido" value={shortMoney(f.recebido_cents)} sub={f.recebido_cents ? 'pagamentos confirmados' : 'nenhum pagamento ainda'} tone={f.recebido_cents ? 'ok' : undefined} />
            <Stat label="Em aberto" value={shortMoney(f.em_aberto_cents)} sub="parcelas a vencer" />
            <Stat label="Vencido" value={shortMoney(f.vencido_cents)} sub={f.vencido_cents ? 'cobrar a família' : 'nada vencido'} tone={f.vencido_cents ? 'bad' : undefined} />
          </div>
          <div className="dz-sub-block">
            <div className="dz-sub-head"><strong>Contratado × potencial da base</strong><span>{shortMoney(f.contratado_cents)} de {shortMoney(f.potencial_cents)}</span></div>
            <StackBar tt={tt} total={Number(f.potencial_cents || 0)} segments={[
              ['Recebido', Number(f.recebido_cents || 0), C.ok],
              ['Contratado, a receber', Number(f.contratado_cents || 0) - Number(f.recebido_cents || 0), C.ramp[0]],
              ['Em negociação', Number(f.em_jornada_cents || 0), C.ramp[2]],
              ['Ainda não contratado', Math.max(Number(f.potencial_cents || 0) - Number(f.contratado_cents || 0) - Number(f.em_jornada_cents || 0), 0), C.track]
            ]} />
          </div>
          {(f.next_due || []).length ? (
            <div className="dz-sub-block">
              <div className="dz-sub-head"><strong>Próximos vencimentos</strong><span>parcelas em aberto por data</span></div>
              <BarList tt={tt} format={(v) => money(v)} rows={(f.next_due || []).map((x) => [dayLabel(x.due_date), Number(x.amount_cents), `${x.parcelas} parcela${x.parcelas > 1 ? 's' : ''}`])} color={C.ramp[1]} />
            </div>
          ) : null}
        </Panel>

        <Panel title="Escolhas de pagamento" sub={`${signedTotal} alunos assinados · ${billingChosen} famílias já escolheram a forma`}>
          <div className="dz-sub-block is-first">
            <div className="dz-sub-head"><strong>Plano</strong><span>parcelas da matrícula</span></div>
            <BarList tt={tt} rows={[['À vista', Number(plans['1'] || 0)], ['2 parcelas', Number(plans['2'] || 0)], ['3 parcelas', Number(plans['3'] || 0)]]} />
          </div>
          <div className="dz-sub-block">
            <div className="dz-sub-head"><strong>Forma de pagamento</strong><span>por família</span></div>
            <BarList tt={tt} rows={[
              ['Boleto', Number(billing.boleto || 0)],
              ['Pix', Number(billing.pix || 0)],
              ['Cartão', Number(billing.cartao || 0) + Number(billing.credit_card || 0)],
              ['Ainda não escolheu', Math.max(view.signedFamilies - billingChosen, 0), null, '#B9B2A6']
            ]} />
          </div>
        </Panel>
      </div>

      <Panel title="Atendimento no WhatsApp" sub="Conversas da IA e da equipe">
        <div className="dz-wa">
          <div className="dz-money">
            <Stat label="Conversas abertas" value={int(Number(w.com_ia || 0) + Number(w.com_equipe || 0))} sub={`${w.com_ia || 0} com a IA · ${w.com_equipe || 0} com a equipe`} />
            <Stat label="Mensagens recebidas hoje" value={int(w.hoje_entrada)} sub={`${int(w.nao_lidas)} não lidas no total`} />
            <Stat label="Respostas hoje" value={int(Number(w.hoje_ia || 0) + Number(w.hoje_equipe || 0))} sub={`${int(w.hoje_ia)} da IA · ${int(w.hoje_equipe)} da equipe`} />
            <Stat label="Fila de envio" value={int(w.fila)} sub={w.falhas ? `${w.falhas} falharam` : 'sem falhas'} tone={w.falhas ? 'bad' : undefined} />
          </div>
          <div className="dz-sub-block">
            <div className="dz-sub-head"><strong>Quem respondeu as famílias</strong><span>{pct(w.total_ia, replies)}% das respostas foram da IA</span></div>
            <StackBar tt={tt} total={replies} segments={[['IA', Number(w.total_ia || 0), C.series1], ['Equipe', Number(w.total_equipe || 0), C.series2]]} />
            <Legend items={[['IA', C.series1, int(w.total_ia)], ['Equipe', C.series2, int(w.total_equipe)]]} />
          </div>
        </div>
      </Panel>

      {tt.node}
    </div>
  );
}
