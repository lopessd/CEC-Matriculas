import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DataState from '../components/DataState';
import { useAsyncData } from '../hooks/useAsyncData';
import { getEnrollments, getSignatureRecords, getSignedContractFile } from '../services/data';
import { dateTime } from '../lib/format';
import { KIND_LABEL, downloadCsv, fold, useSort } from '../lib/journey';

/* Contratos assinados: um por aluno (o mais recente). Versões substituídas
   (ex.: contratos refeitos e reassinados) ficam escondidas como "legado" e
   aparecem com o filtro. Tabela ordenável, com ver/baixar o PDF. */

const fileName = (name, legacy) => `contrato-assinado-${String(name || 'aluno').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}${legacy ? '-legado' : ''}.pdf`;

export default function Assinaturas() {
  const source = useAsyncData(async () => {
    const [enrollments, signatures] = await Promise.all([getEnrollments(), getSignatureRecords()]);
    const byId = new Map(enrollments.map((item) => [item.id, item]));
    return signatures.map((signature) => ({ ...signature, enrollment: byId.get(signature.enrollment_id) }));
  }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const [showLegacy, setShowLegacy] = useState(false);
  const [type, setType] = useState('');

  // O contrato que vale é o último gerado de cada aluno; os outros são legado.
  const rows = useMemo(() => {
    const all = (source.data || []).map((item) => ({ ...item, legacy: Boolean(item.generation_data?.legado) }));
    const latest = new Map();
    for (const item of all) {
      if (item.legacy) continue;
      const current = latest.get(item.enrollment_id);
      if (!current || String(item.generated_at || item.signed_pdf_at) > String(current.generated_at || current.signed_pdf_at)) latest.set(item.enrollment_id, item);
    }
    return all.map((item) => ({ ...item, legacy: item.legacy || latest.get(item.enrollment_id)?.id !== item.id }));
  }, [source.data]);
  const legacyCount = rows.filter((item) => item.legacy).length;
  const term = fold(search.trim());
  const filtered = rows.filter((item) =>
    (showLegacy || !item.legacy) &&
    (!type || item.enrollment?.campaign_kind === type) &&
    (!term || fold([item.enrollment?.guardian_name, item.enrollment?.student_name, item.signer_full_name, item.signer_email].join(' ')).includes(term))
  );
  const { sorted, sort, toggle } = useSort(filtered, {
    guardian: (item) => item.enrollment?.guardian_name || item.signer_full_name,
    student: (item) => item.enrollment?.student_name,
    version: (item) => item.document_versions?.version,
    signed: (item) => item.completed_at || item.signed_pdf_at,
    signer: (item) => item.signer_full_name
  }, { key: 'signed', dir: 'desc' });
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '');

  async function accessFile(item, download) {
    setBusy(item.id); setError('');
    const preview = download ? null : window.open('', '_blank');
    try {
      const blob = await getSignedContractFile(item.signed_storage_path);
      const objectUrl = URL.createObjectURL(blob);
      if (download) {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = fileName(item.enrollment?.student_name, item.legacy);
        document.body.appendChild(link);
        link.click();
        link.remove();
      } else if (preview) {
        preview.location.href = objectUrl;
      } else {
        window.location.href = objectUrl;
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (cause) {
      preview?.close();
      setError(cause.message || 'Não foi possível abrir o contrato.');
    } finally { setBusy(''); }
  }

  const current = rows.filter((item) => !item.legacy);
  return (
    <DataState loading={source.loading && !source.data} error={source.error} empty={false}>
      <div className="ops">
        <div className="dz-stats">
          <div className="dz-stat tone-ok"><span className="dz-stat-label">Contratos assinados</span><span className="dz-stat-value">{current.length}</span><span className="dz-stat-sub">um por aluno, versão que vale</span></div>
          <div className="dz-stat"><span className="dz-stat-label">Famílias</span><span className="dz-stat-value">{new Set(current.map((item) => item.enrollment?.guardian_id).filter(Boolean)).size}</span><span className="dz-stat-sub">irmãos assinam juntos</span></div>
          <div className="dz-stat"><span className="dz-stat-label">Últimos 7 dias</span><span className="dz-stat-value">{current.filter((item) => Date.now() - new Date(item.completed_at || item.signed_pdf_at).getTime() < 7 * 86400000).length}</span><span className="dz-stat-sub">contratos assinados na semana</span></div>
          <div className="dz-stat"><span className="dz-stat-label">Versões antigas</span><span className="dz-stat-value">{legacyCount}</span><span className="dz-stat-sub">guardadas como legado</span></div>
        </div>

        <div className="ops-filters">
          <input className="control ops-search" type="search" placeholder="Responsável, aluno ou e-mail" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select className="control ops-select" value={type} onChange={(event) => setType(event.target.value)}><option value="">Rematrícula e nova</option><option value="rematricula">Rematrícula</option><option value="matricula_nova">Matrícula nova</option></select>
          {legacyCount ? <label className="fp-check"><input type="checkbox" checked={showLegacy} onChange={(event) => setShowLegacy(event.target.checked)} />Mostrar versões antigas ({legacyCount})</label> : null}
          <span className="ops-count">{sorted.length} contrato{sorted.length === 1 ? '' : 's'}</span>
          <button type="button" className="btn" disabled={!sorted.length} onClick={() => downloadCsv('assinaturas.csv', ['Responsável', 'Aluno', 'Tipo', 'Modelo', 'Assinado em', 'Assinado por', 'E-mail', 'Legado'], sorted.map((item) => [item.enrollment?.guardian_name || '', item.enrollment?.student_name || '', KIND_LABEL[item.enrollment?.campaign_kind] || '', item.document_versions?.version || '', dateTime(item.completed_at || item.signed_pdf_at), item.signer_full_name || '', item.signer_email || '', item.legacy ? 'sim' : '']))}>Exportar CSV</button>
        </div>

        {error ? <div className="notice" role="alert"><span>{error}</span></div> : null}

        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th><button type="button" onClick={() => toggle('guardian')}>Responsável{arrow('guardian')}</button></th>
                <th><button type="button" onClick={() => toggle('student')}>Aluno{arrow('student')}</button></th>
                <th><button type="button" onClick={() => toggle('version')}>Modelo{arrow('version')}</button></th>
                <th><button type="button" onClick={() => toggle('signed')}>Assinado em{arrow('signed')}</button></th>
                <th><button type="button" onClick={() => toggle('signer')}>Assinado por{arrow('signer')}</button></th>
                <th className="ops-actions-head">Ações</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((item) => (
                <tr key={item.id} className={item.legacy ? 'is-legacy' : ''}>
                  <td><div className="cell-stack"><strong className="cell-strong">{item.enrollment?.guardian_name || item.signer_full_name || 'Responsável'}</strong><span>{KIND_LABEL[item.enrollment?.campaign_kind] || ''}</span></div></td>
                  <td className="cell">{item.enrollment?.student_name || 'Aluno'}</td>
                  <td className="cell is-dim">{item.document_versions?.version || '—'}{item.legacy ? <span className="fp-flag">legado</span> : null}</td>
                  <td className="cell">{dateTime(item.completed_at || item.signed_pdf_at)}</td>
                  <td><div className="cell-stack"><span className="cell">{item.signer_full_name || '—'}</span><span>{item.signer_email || ''}</span></div></td>
                  <td className="ops-actions">
                    <button className="btn btn--ghost" type="button" onClick={() => accessFile(item, false)} disabled={busy === item.id}>Ver</button>
                    <button className="btn btn--primary" type="button" onClick={() => accessFile(item, true)} disabled={busy === item.id}>{busy === item.id ? 'Abrindo…' : 'Baixar PDF'}</button>
                    {item.enrollment ? <Link className="btn" to={`/familias/${item.enrollment.guardian_id || item.enrollment_id}?aba=contrato`}>Família</Link> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sorted.length ? <div className="ops-empty">{rows.length ? 'Nenhuma assinatura com esses filtros.' : 'Ainda não há contratos assinados.'}</div> : null}
        </div>
      </div>
    </DataState>
  );
}
