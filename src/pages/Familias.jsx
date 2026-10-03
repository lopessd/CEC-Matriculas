import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import NewEnrollmentWizard from '../components/NewEnrollmentWizard';
import { getJourneyBoard } from '../services/data';
import { money } from '../lib/format';
import { COLUMNS, KINDS, KIND_LABEL, METHOD_LABEL, downloadCsv, fold, formatPhoneView, stageInfo, stageRank, timeAgo, useSort } from '../lib/journey';

/* Famílias da campanha (rematrícula e matrícula nova na mesma tela), uma linha
   por responsável com a etapa real da jornada. Filtros por etapa e situação,
   busca, ordenação por coluna e exportação. A matrícula nova pela secretaria
   começa aqui. */

const PAGE = 60;
const FLAGS = [
  ['human', 'Precisa de humano'],
  ['signed', 'Contrato assinado'],
  ['open', 'Pagamento em aberto'],
  ['nojourney', 'Ainda sem jornada']
];

export default function Familias() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = params.get('tipo') || (() => { try { return localStorage.getItem('cec.familias.kind') || 'rematricula'; } catch { return 'rematricula'; } })();
  const [state, setState] = useState({ loading: true, error: null, cards: [], at: null });
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [flags, setFlags] = useState([]);
  const [limit, setLimit] = useState(PAGE);
  const [wizard, setWizard] = useState(params.get('nova') === '1');

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const kinds = kind === 'todas' ? ['rematricula', 'matricula_nova'] : [kind];
      const boards = await Promise.all(kinds.map((value) => getJourneyBoard(value)));
      const cards = boards.flatMap((board, index) => (board?.cards || []).map((card) => ({ ...card, kind: kinds[index] })));
      setState({ loading: false, error: null, cards, at: new Date() });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [kind]);

  useEffect(() => { load(); setStage(''); setLimit(PAGE); }, [load]);
  useEffect(() => { try { localStorage.setItem('cec.familias.kind', kind); } catch { /* sem storage */ } }, [kind]);

  const setKind = (value) => setParams((current) => { const next = new URLSearchParams(current); next.set('tipo', value); return next; }, { replace: true });
  const toggleFlag = (value) => setFlags((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]));

  const enriched = useMemo(() => state.cards.map((card) => {
    const installments = card.installments || [];
    const paid = installments.filter((item) => item.status === 'pago').length;
    return {
      ...card,
      info: stageInfo(card.stage, card.kind),
      installmentsTotal: installments.length,
      installmentsPaid: paid,
      openCents: installments.filter((item) => ['pendente', 'vencido'].includes(item.status)).reduce((sum, item) => sum + Number(item.amount_cents || 0), 0),
      signed: installments.length > 0 || ['cobranca', 'pagamento', 'concluida'].includes(card.stage),
      studentNames: (card.students || []).map((student) => student.name)
    };
  }), [state.cards]);

  const stageOptions = kind === 'todas'
    ? [...new Map([...COLUMNS.rematricula, ...COLUMNS.matricula_nova].map((column) => [column.key, column])).values()]
    : COLUMNS[kind] || [];
  const counts = useMemo(() => Object.fromEntries(stageOptions.map((column) => [column.key, enriched.filter((card) => column.stages.includes(card.stage)).length])), [enriched, stageOptions]);

  const term = fold(search.trim());
  const digits = search.replace(/\D/g, '');
  const filtered = enriched.filter((card) => {
    if (stage && !stageOptions.find((column) => column.key === stage)?.stages.includes(card.stage)) return false;
    if (flags.includes('human') && !card.needs_human) return false;
    if (flags.includes('signed') && !card.signed) return false;
    if (flags.includes('open') && !card.openCents) return false;
    if (flags.includes('nojourney') && card.session_id) return false;
    if (!term) return true;
    if (digits.length >= 4 && String(card.guardian_phone || '').replace(/\D/g, '').includes(digits)) return true;
    return fold([card.guardian_name, ...card.studentNames].join(' ')).includes(term);
  });

  const { sorted, sort, toggle } = useSort(filtered, {
    family: (card) => card.guardian_name,
    stage: (card) => stageRank(card.stage, card.kind) * 10 + (card.kind === 'matricula_nova' ? 1 : 0),
    amount: (card) => Number(card.amount_cents || 0),
    payment: (card) => (card.installmentsTotal ? card.installmentsPaid / card.installmentsTotal : -1),
    activity: (card) => (card.last_activity_at ? -new Date(card.last_activity_at).getTime() : null)
  }, { key: 'activity', dir: 'asc' });
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '');

  const inJourney = enriched.filter((card) => !['a_contatar', 'conversa', 'perdida'].includes(card.stage)).length;
  const signedCount = enriched.filter((card) => card.signed).length;
  const done = enriched.filter((card) => card.stage === 'concluida').length;
  const human = enriched.filter((card) => card.needs_human).length;

  function exportCsv() {
    downloadCsv(`familias-${kind}.csv`, ['Responsável', 'Telefone', 'Tipo', 'Alunos', 'Etapa', 'Plano', 'Forma', 'Valor', 'Parcelas pagas', 'Última atividade'],
      sorted.map((card) => [card.guardian_name, formatPhoneView(card.guardian_phone), KIND_LABEL[card.kind], card.studentNames.join(', '), card.info.label, card.plan_name || '', METHOD_LABEL[card.billing_method] || '', card.amount_cents ? (card.amount_cents / 100).toFixed(2).replace('.', ',') : '', card.installmentsTotal ? `${card.installmentsPaid}/${card.installmentsTotal}` : '', card.last_activity_at ? new Date(card.last_activity_at).toLocaleString('pt-BR') : '']));
  }

  return (
    <div className="ops">
      <div className="ops-toolbar">
        <div className="segmented" role="tablist">
          {[...KINDS, ['todas', 'Todas']].map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={kind === value} className={kind === value ? 'is-active' : ''} onClick={() => setKind(value)}>{label}</button>)}
        </div>
        <div className="ops-toolbar-end">
          <button type="button" className="btn btn--ghost" onClick={load} disabled={state.loading}>{state.loading ? 'Atualizando…' : state.at ? `Atualizado ${timeAgo(state.at)}` : 'Atualizar'}</button>
          <button type="button" className="btn" onClick={exportCsv} disabled={!sorted.length}>Exportar CSV</button>
          <button type="button" className="btn btn--orange" onClick={() => setWizard(true)}>+ Nova matrícula</button>
        </div>
      </div>

      <div className="dz-stats">
        <button type="button" className={`dz-stat is-link${!stage && !flags.length ? ' is-selected' : ''}`} onClick={() => { setStage(''); setFlags([]); }}><span className="dz-stat-label">Famílias</span><span className="dz-stat-value">{enriched.length}</span><span className="dz-stat-sub">{inJourney} já abriram a jornada</span></button>
        <button type="button" className={`dz-stat is-link${flags.includes('signed') ? ' is-selected' : ''}`} onClick={() => toggleFlag('signed')}><span className="dz-stat-label">Contrato assinado</span><span className="dz-stat-value">{signedCount}</span><span className="dz-stat-sub">{enriched.length ? Math.round((signedCount / enriched.length) * 100) : 0}% das famílias</span></button>
        <button type="button" className={`dz-stat is-link tone-ok${stage === 'concluida' ? ' is-selected' : ''}`} onClick={() => setStage(stage === 'concluida' ? '' : 'concluida')}><span className="dz-stat-label">Concluídas</span><span className="dz-stat-value">{done}</span><span className="dz-stat-sub">pagamento confirmado</span></button>
        <button type="button" className={`dz-stat is-link${human ? ' tone-warn' : ''}${flags.includes('human') ? ' is-selected' : ''}`} onClick={() => toggleFlag('human')}><span className="dz-stat-label">Precisam de humano</span><span className="dz-stat-value">{human}</span><span className="dz-stat-sub">saíram da IA ou pediram ajuda</span></button>
      </div>

      <div className="ops-filters">
        <input className="control ops-search" type="search" placeholder="Buscar responsável, aluno ou telefone" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(PAGE); }} />
        <select className="control ops-select" value={stage} onChange={(event) => { setStage(event.target.value); setLimit(PAGE); }}>
          <option value="">Todas as etapas</option>
          {stageOptions.map((column) => <option key={column.key} value={column.key}>{column.label} ({counts[column.key] || 0})</option>)}
        </select>
        <div className="ops-chips">
          {FLAGS.map(([value, label]) => <button key={value} type="button" className={`chip${flags.includes(value) ? ' is-active' : ''}`} onClick={() => toggleFlag(value)}>{label}</button>)}
        </div>
        <span className="ops-count">{sorted.length} de {enriched.length}</span>
      </div>

      <div className="stage-strip">
        {stageOptions.filter((column) => counts[column.key] || !column.optional).map((column) => (
          <button key={column.key} type="button" className={`stage-chip${stage === column.key ? ' is-active' : ''}`} style={{ '--accent': column.color }} onClick={() => setStage(stage === column.key ? '' : column.key)}>
            <i />{column.label}<b>{counts[column.key] || 0}</b>
          </button>
        ))}
      </div>

      {state.error ? <div className="notice"><strong>Não foi possível carregar.</strong><span>{state.error}</span></div> : null}
      {state.loading && !state.cards.length ? <div className="notice">Carregando famílias…</div> : null}

      {state.cards.length ? (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th><button type="button" onClick={() => toggle('family')}>Família{arrow('family')}</button></th>
                <th>Alunos</th>
                <th><button type="button" onClick={() => toggle('stage')}>Etapa{arrow('stage')}</button></th>
                <th>Plano · forma</th>
                <th className="num"><button type="button" onClick={() => toggle('amount')}>Valor{arrow('amount')}</button></th>
                <th><button type="button" onClick={() => toggle('payment')}>Pagamento{arrow('payment')}</button></th>
                <th><button type="button" onClick={() => toggle('activity')}>Atividade{arrow('activity')}</button></th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, limit).map((card) => (
                <tr key={`${card.kind}-${card.guardian_id}`} className={`ops-row${card.needs_human ? ' is-human' : ''}`} onClick={() => navigate(`/familias/${card.guardian_id}`)}>
                  <td>
                    <div className="cell-stack">
                      <strong className="cell-strong">{card.guardian_name || 'Sem nome'}</strong>
                      <span>{formatPhoneView(card.guardian_phone)}{kind === 'todas' ? ` · ${KIND_LABEL[card.kind]}` : ''}</span>
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      {(card.students || []).slice(0, 3).map((student, index) => <span key={`${student.name}-${index}`} className="cell">{student.name}<small className="meta"> · {student.grade || student.from || '—'}</small></span>)}
                      {(card.students || []).length > 3 ? <span>+{card.students.length - 3}</span> : null}
                      {!(card.students || []).length ? <span>—</span> : null}
                    </div>
                  </td>
                  <td>
                    <span className="stage-pill" style={{ '--accent': card.info.color }}><i />{card.info.label}</span>
                    {card.manual ? <span className="fp-flag" title={card.manual_info?.note || 'Movida pela equipe'}>manual</span> : null}
                    {card.needs_human ? <span className="fp-flag fp-flag--warn">humano</span> : null}
                  </td>
                  <td className="cell is-dim">{card.plan_name ? card.plan_name.split(' — ')[0].split(' (')[0] : '—'}{card.billing_method ? ` · ${METHOD_LABEL[card.billing_method] || card.billing_method}` : ''}</td>
                  <td className="num cell-strong">{card.amount_cents ? money(card.amount_cents) : '—'}</td>
                  <td>
                    {card.installmentsTotal ? (
                      <>
                        <div className="ops-progress"><i style={{ width: `${(card.installmentsPaid / card.installmentsTotal) * 100}%` }} /></div>
                        <span className="meta">{card.installmentsPaid}/{card.installmentsTotal} pagas{card.openCents ? ` · ${money(card.openCents)}` : ''}</span>
                      </>
                    ) : <span className="meta">—</span>}
                  </td>
                  <td className="cell is-dim">{timeAgo(card.last_activity_at) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sorted.length ? <div className="ops-empty">Nenhuma família com esses filtros.</div> : null}
          {sorted.length > limit ? <button type="button" className="ops-more" onClick={() => setLimit((value) => value + PAGE * 2)}>Mostrar mais {Math.min(sorted.length - limit, PAGE * 2)} de {sorted.length - limit}</button> : null}
        </div>
      ) : null}

      {wizard ? <NewEnrollmentWizard onClose={() => { setWizard(false); setParams((current) => { const next = new URLSearchParams(current); next.delete('nova'); return next; }, { replace: true }); }} onCreated={load} /> : null}
    </div>
  );
}
