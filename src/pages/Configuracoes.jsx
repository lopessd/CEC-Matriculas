import { Badge, Tile } from '../components/ui';
import DataState from '../components/DataState';
import { useAsyncData } from '../hooks/useAsyncData';
import { getSettings } from '../services/data';
import { date, money } from '../lib/format';

const shiftNames = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite', integral: 'Integral' };
function formatShifts(shifts) {
  const values = Array.isArray(shifts) ? shifts : String(shifts || '').replace(/[{}]/g, '').split(',');
  return values.filter(Boolean).map((value) => shiftNames[value] || value).join(' · ') || '—';
}

export default function Configuracoes() {
  const { loading, data, error } = useAsyncData(getSettings, []);
  const closingRule = [
    ['Até 31/10/2026', 'Valor da rematrícula da turma', 'O valor promocional é aplicado quando o contrato é fechado até esta data.'],
    ['A partir de 01/11/2026', 'Tabela da rematrícula 2027', 'O valor de 2027 é aplicado e fica registrado no contrato assinado.']
  ];
  const paymentRules = [
    ['Parcelamento', 'Até janeiro', 'Até 31/10: 3 parcelas em novembro, dezembro e janeiro. Depois: pagamento único em janeiro.'],
    ['Formas aceitas', 'Boleto · Cartão · Pix', 'A cobrança será enviada no meio escolhido pelo responsável.']
  ];

  return <DataState loading={loading} error={error} empty={!loading && !error && !data?.campaign}>
    <div className="notice"><Badge tone="ok">Regra de vigência</Badge><span>O valor da matrícula é definido no fechamento do contrato, não na abertura do formulário.</span></div>
    <div className="grid grid--2">{closingRule.map(([label, value, sub]) => <Tile key={label} label={label} value={value} sub={sub} />)}</div>
    <div className="table">
      <div className="table-title"><div className="card-title">Valores de rematrícula {data?.campaign?.academic_year}</div><div className="card-sub">A tabela abaixo é aplicada automaticamente conforme a data de fechamento.</div></div>
      <div className="table-head cols-pricing"><div>Série</div><div>Turno</div><div>Até 31/10 · valor 2026</div><div>A partir de 01/11 · valor 2027</div><div>Valor vigente hoje</div></div>
      {(data?.offerings || []).map((item) => <div className="table-row cols-pricing" style={{ cursor: 'default' }} key={item.offering_id}><div className="cell-strong">{item.grade_name}</div><div className="cell">{formatShifts(item.shifts)}</div><div className="cell">{money(item.early_amount_cents)}</div><div className="cell">{money(item.amount_cents)}</div><div className="cell-strong" style={{ color: 'var(--navy)' }}>{money(item.current_amount_cents)}</div></div>)}
    </div>
    <div className="card"><div className="card-title">Condições de pagamento</div><div className="grid grid--2" style={{ marginTop: 16 }}>{paymentRules.map(([label, value, sub]) => <Tile key={label} label={label} value={value} sub={sub} />)}</div></div>
    <div className="grid grid--main">
      <div className="card"><div className="card-title">Parâmetros da campanha</div><div className="grid grid--3" style={{ marginTop: 16 }}>{[
        ['Campanha ativa', data?.campaign?.name], ['Período', `${date(data?.campaign?.starts_on)} – ${date(data?.campaign?.ends_on)}`], ['Janela de envio', `${data?.campaign?.send_window_start?.slice(0, 5)} – ${data?.campaign?.send_window_end?.slice(0, 5)}`], ['Teto por hora', `${data?.campaign?.hourly_cap} mensagens`], ['Teto diário', `${data?.campaign?.daily_cap} mensagens`], ['Tentativas da régua', `${data?.campaign?.max_attempts} contatos`]
      ].map(([label, value]) => <Tile key={label} label={label} value={value || '—'} />)}</div></div>
      <div className="card"><div className="card-title">Documentos cadastrados</div><div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>{(data?.documents || []).map((item) => <div className="row-item" style={{ background: 'var(--surface)' }} key={item.id}><div className="who"><strong>{item.documents?.title}</strong><span>{item.documents?.requirement?.replaceAll('_', ' ')}</span></div><strong style={{ fontSize: 12.5, color: 'var(--navy)' }}>{item.version} · {item.pages || '—'} páginas</strong></div>)}</div></div>
    </div>
  </DataState>;
}
