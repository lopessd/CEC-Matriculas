import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DataState from '../components/DataState';
import { useAsyncData } from '../hooks/useAsyncData';
import { getCampaigns, getEnrollments, getInstallmentList } from '../services/data';
import { money } from '../lib/format';
import { KIND_LABEL, METHOD_LABEL, downloadCsv, fold, localDay, todayIso, useSort } from '../lib/journey';

/* Matriculados: um aluno por linha, com contrato assinado. Mostra plano,
   forma, quanto já foi recebido e se há parcela vencida. Filtros por tipo,
   série e situação do pagamento; ordena por qualquer coluna; exporta CSV. */

const PAYMENT_FILTERS = [['', 'Qualquer pagamento'], ['quitado', 'Quitado'], ['em_dia', 'Em dia'], ['vencido', 'Com vencida'], ['sem_parcelas', 'Sem parcelas']];
const PAYMENT_VIEW = { quitado: ['Quitado', 'ok'], em_dia: ['Em dia', 'mute'], vencido: ['Vencida', 'warn'], sem_parcelas: ['Sem parcelas', 'mute'] };

export default function Matriculados() {
  const navigate = useNavigate();
  const [scope, setScope] = useState('atual');
  const [type, setType] = useState('');
  const [grade, setGrade] = useState('');
  const [payment, setPayment] = useState('');
  const [search, setSearch] = useState('');
  const source = useAsyncData(async () => {
    const [enrollments, campaigns, installments] = await Promise.all([getEnrollments(), getCampaigns(), getInstallmentList()]);
    return { enrollments, campaigns, installments };
  }, []);

  const rows = useMemo(() => {
    if (!source.data) return [];
    const active = new Set(source.data.campaigns.filter((campaign) => campaign.status === 'ativa').map((campaign) => campaign.id));
    const byEnrollment = new Map();
    for (const item of source.data.installments) {
      if (item.status === 'cancelado') continue;
      if (!byEnrollment.has(item.enrollment_id)) byEnrollment.set(item.enrollment_id, []);
      byEnrollment.get(item.enrollment_id).push(item);
    }
    const today = todayIso();
    return source.data.enrollments
      .filter((item) => item.signed_at || item.completed_at)
      .filter((item) => scope === 'todas' || (scope === 'atual' ? active.has(item.campaign_id) : !active.has(item.campaign_id)))
      .map((item) => {
        const list = byEnrollment.get(item.id) || [];
        const paid = list.filter((row) => row.status === 'pago');
        const overdue = list.filter((row) => row.status === 'vencido' || (row.status === 'pendente' && row.due_date < today));
        const situation = !list.length ? 'sem_parcelas' : paid.length === list.length ? 'quitado' : overdue.length ? 'vencido' : 'em_dia';
        return {
          ...item,
          installments: list,
          contracted: list.reduce((sum, row) => sum + row.amount_cents, 0) || Number(item.amount_cents || 0),
          received: paid.reduce((sum, row) => sum + Number(row.paid_amount_cents ?? row.amount_cents), 0),
          paidCount: paid.length,
          situation,
          method: list.find((row) => row.method)?.method || null,
          nextDue: list.filter((row) => row.status !== 'pago').map((row) => row.due_date).sort()[0] || null
        };
      });
  }, [source.data, scope]);

  const grades = useMemo(() => [...new Set(rows.map((row) => row.target_grade_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })), [rows]);
  const term = fold(search.trim());
  const filtered = rows.filter((row) =>
    (!type || row.campaign_kind === type) &&
    (!grade || row.target_grade_name === grade) &&
    (!payment || row.situation === payment) &&
    (!term || fold([row.guardian_name, row.student_name, row.guardian_phone].join(' ')).includes(term))
  );
  const { sorted, sort, toggle } = useSort(filtered, {
    student: (row) => row.student_name,
    guardian: (row) => row.guardian_name,
    grade: (row) => row.target_grade_name,
    signed: (row) => row.signed_at || row.completed_at,
    contracted: (row) => row.contracted,
    received: (row) => row.received,
    next: (row) => row.nextDue || '9999'
  }, { key: 'signed', dir: 'desc' });
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '');

  const families = new Set(filtered.map((row) => row.guardian_id)).size;
  const contracted = filtered.reduce((sum, row) => sum + row.contracted, 0);
  const received = filtered.reduce((sum, row) => sum + row.received, 0);
  const overdue = filtered.filter((row) => row.situation === 'vencido').length;

  function exportCsv() {
    downloadCsv('matriculados.csv', ['Aluno', 'Série', 'Responsável', 'Telefone', 'Tipo', 'Plano', 'Forma', 'Assinado em', 'Contratado', 'Recebido', 'Parcelas pagas', 'Situação'],
      sorted.map((row) => [row.student_name, row.target_grade_name, row.guardian_name, row.guardian_phone, KIND_LABEL[row.campaign_kind], row.payment_plan_name || '', METHOD_LABEL[row.method] || '', localDay(row.signed_at || row.completed_at), (row.contracted / 100).toFixed(2).replace('.', ','), (row.received / 100).toFixed(2).replace('.', ','), `${row.paidCount}/${row.installments.length}`, PAYMENT_VIEW[row.situation][0]]));
  }

  return (
    <DataState loading={source.loading && !source.data} error={source.error} empty={false}>
      <div className="ops">
        <div className="ops-toolbar">
          <div className="segmented">
            {[['atual', 'Campanha atual'], ['anteriores', 'Anos anteriores'], ['todas', 'Todas']].map(([value, label]) => <button key={value} type="button" className={scope === value ? 'is-active' : ''} onClick={() => setScope(value)}>{label}</button>)}
          </div>
          <div className="ops-toolbar-end"><button type="button" className="btn" onClick={exportCsv} disabled={!sorted.length}>Exportar CSV</button></div>
        </div>

        <div className="dz-stats">
          <div className="dz-stat"><span className="dz-stat-label">Alunos matriculados</span><span className="dz-stat-value">{filtered.length}</span><span className="dz-stat-sub">{families} famílias · contrato assinado</span></div>
          <div className="dz-stat"><span className="dz-stat-label">Contratado</span><span className="dz-stat-value">{money(contracted)}</span><span className="dz-stat-sub">soma das parcelas</span></div>
          <div className="dz-stat tone-ok"><span className="dz-stat-label">Recebido</span><span className="dz-stat-value">{money(received)}</span><span className="dz-stat-sub">{contracted ? Math.round((received / contracted) * 100) : 0}% do contratado</span></div>
          <button type="button" className={`dz-stat is-link${overdue ? ' tone-warn' : ''}${payment === 'vencido' ? ' is-selected' : ''}`} onClick={() => setPayment(payment === 'vencido' ? '' : 'vencido')}><span className="dz-stat-label">Com parcela vencida</span><span className="dz-stat-value">{overdue}</span><span className="dz-stat-sub">clique para filtrar</span></button>
        </div>

        <div className="ops-filters">
          <input className="control ops-search" type="search" placeholder="Buscar aluno, responsável ou telefone" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select className="control ops-select" value={type} onChange={(event) => setType(event.target.value)}><option value="">Rematrícula e nova</option><option value="rematricula">Rematrícula</option><option value="matricula_nova">Matrícula nova</option></select>
          <select className="control ops-select" value={grade} onChange={(event) => setGrade(event.target.value)}><option value="">Todas as séries</option>{grades.map((value) => <option key={value} value={value}>{value}</option>)}</select>
          <select className="control ops-select" value={payment} onChange={(event) => setPayment(event.target.value)}>{PAYMENT_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <span className="ops-count">{sorted.length} de {rows.length}</span>
        </div>

        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th><button type="button" onClick={() => toggle('student')}>Aluno{arrow('student')}</button></th>
                <th><button type="button" onClick={() => toggle('grade')}>Série{arrow('grade')}</button></th>
                <th><button type="button" onClick={() => toggle('guardian')}>Responsável{arrow('guardian')}</button></th>
                <th>Plano · forma</th>
                <th><button type="button" onClick={() => toggle('signed')}>Assinado{arrow('signed')}</button></th>
                <th className="num"><button type="button" onClick={() => toggle('contracted')}>Contratado{arrow('contracted')}</button></th>
                <th><button type="button" onClick={() => toggle('received')}>Recebido{arrow('received')}</button></th>
                <th><button type="button" onClick={() => toggle('next')}>Situação{arrow('next')}</button></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const [label, tone] = PAYMENT_VIEW[row.situation];
                return (
                  <tr key={row.id} className="ops-row" onClick={() => navigate(`/familias/${row.guardian_id || row.id}?aba=financeiro`)}>
                    <td><div className="cell-stack"><strong className="cell-strong">{row.student_name}</strong><span>{KIND_LABEL[row.campaign_kind]}</span></div></td>
                    <td className="cell">{row.target_grade_name || '—'}</td>
                    <td className="cell">{row.guardian_name}</td>
                    <td className="cell is-dim">{row.payment_plan_name ? row.payment_plan_name.split(' — ')[0] : '—'}{row.method ? ` · ${METHOD_LABEL[row.method]}` : ''}</td>
                    <td className="cell is-dim">{localDay(row.signed_at || row.completed_at)}</td>
                    <td className="num cell-strong">{money(row.contracted)}</td>
                    <td>
                      <div className="ops-progress"><i style={{ width: `${row.contracted ? Math.min(100, (row.received / row.contracted) * 100) : 0}%` }} /></div>
                      <span className="meta">{money(row.received)} · {row.paidCount}/{row.installments.length}</span>
                    </td>
                    <td><span className={`fp-status fp-status--${tone}`}>{label}</span>{row.nextDue && row.situation !== 'quitado' ? <div className="meta">próx. {localDay(`${row.nextDue}T12:00:00`)}</div> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!sorted.length ? <div className="ops-empty">{rows.length ? 'Nenhum aluno com esses filtros.' : 'Ainda não há contratos assinados nesta campanha.'}</div> : null}
        </div>
      </div>
    </DataState>
  );
}
