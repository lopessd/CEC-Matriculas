import { useEffect, useState } from 'react';
import { getPaymentPlans, startContract, startFamilyContract } from '../services/data';
import { money } from '../lib/format';
import { contractUrl, todayIso, whatsappUrl } from '../lib/journey';

/* Preparar o link de assinatura pela secretaria: escolhe os alunos (irmãos
   assinam juntos), confirma o e-mail do código e copia/manda o link. As
   condições de pagamento vêm dos planos da campanha, com a data-limite de
   cada um, no lugar do aviso de texto corrido. */

const shortDate = (value) => (value ? `${value.slice(8, 10)}/${value.slice(5, 7)}` : '');
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthOf = (value) => MONTHS[Number(value.slice(5, 7)) - 1];

export function PaymentConditions({ campaignId, total }) {
  const [plans, setPlans] = useState(null);
  useEffect(() => {
    let alive = true;
    getPaymentPlans(campaignId).then((rows) => { if (alive) setPlans(rows || []); }).catch(() => { if (alive) setPlans([]); });
    return () => { alive = false; };
  }, [campaignId]);
  if (!plans?.length) return null;
  const today = todayIso();
  const deadlines = [...new Set(plans.map((plan) => plan.available_until).filter(Boolean))].sort();
  return (
    <div className="conditions">
      <div className="conditions-head">
        <strong>Condições de pagamento</strong>
        <span>O plano vale pela data em que o contrato é assinado.</span>
      </div>
      <div className="conditions-list">
        {plans.map((plan) => {
          const open = !plan.available_until || plan.available_until >= today;
          return (
            <div key={plan.id} className={`conditions-plan${open ? '' : ' is-closed'}`}>
              <div className="conditions-plan-main">
                <b>{plan.installments}x</b>
                <div>
                  <strong>{plan.name.split(' — ')[1] || plan.name}</strong>
                  <span>{(plan.due_dates || []).map(monthOf).join(', ')} · dia 10{total ? ` · ${money(Math.round(total / plan.installments))} cada` : ''}</span>
                </div>
              </div>
              <span className={`conditions-until${open ? '' : ' is-closed'}`}>{plan.available_until ? (open ? `assinando até ${shortDate(plan.available_until)}` : `encerrado em ${shortDate(plan.available_until)}`) : 'sempre'}</span>
            </div>
          );
        })}
      </div>
      {deadlines.length > 1 ? <div className="conditions-foot">Depois de {shortDate(deadlines[0])}, sobram só os planos com prazo maior; o valor segue a tabela da data da assinatura.</div> : null}
    </div>
  );
}

export default function ContractSetup({ enrollments, guardian, campaignId, onCreated }) {
  const [included, setIncluded] = useState(() => enrollments.map((item) => item.id));
  const [email, setEmail] = useState(guardian.email || '');
  const [link, setLink] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const chosen = enrollments.filter((item) => included.includes(item.id));
  const total = chosen.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);

  async function create() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setMessage('Informe um e-mail válido: é para ele que vai o código de confirmação.'); return; }
    if (!chosen.length) { setMessage('Marque pelo menos um aluno.'); return; }
    setBusy(true); setMessage('');
    try {
      const result = chosen.length > 1 ? await startFamilyContract(chosen.map((item) => item.id), email.trim()) : await startContract(chosen[0].id, email.trim());
      setLink(contractUrl(result.token));
      onCreated?.();
    } catch (error) { setMessage(error.message || 'Não foi possível preparar o contrato.'); } finally { setBusy(false); }
  }

  async function copy() {
    await navigator.clipboard?.writeText(link);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const first = String(guardian.full_name || '').split(' ')[0];
  const names = chosen.map((item) => item.student_name.split(' ')[0]).join(' e ');
  const text = `Olá, ${first}! Aqui é a secretaria do CEC 😊\nO contrato de ${names} para 2027 está pronto. É só abrir, confirmar o código que chega no seu e-mail e assinar:\n${link}`;

  return (
    <section className="card contract-box">
      <div className="card-head">
        <div>
          <div className="card-title">Link só para assinar</div>
          <div className="card-sub">Para quando a família já decidiu. Ela confirma o código do e-mail e assina; as parcelas nascem na assinatura.</div>
        </div>
      </div>
      <div className="contract-box-grid">
        <div className="contract-box-students">
          <span className="contract-box-label">Quem entra no contrato</span>
          {enrollments.map((item) => (
            <label key={item.id} className={`contract-box-student${included.includes(item.id) ? ' is-on' : ''}`}>
              <input type="checkbox" checked={included.includes(item.id)} onChange={(event) => setIncluded((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
              <span><strong>{item.student_name}</strong><small>{item.grade_name || '—'}{item.payment_plan_name ? ` · ${item.payment_plan_name.split(' — ')[0]}` : ''}</small></span>
              <b>{money(item.amount_cents)}</b>
            </label>
          ))}
          {chosen.length > 1 ? <div className="contract-box-total"><span>Contrato conjunto · {chosen.length} alunos</span><b>{money(total)}</b></div> : null}
          <label className="field contract-box-email">
            <span className="contract-box-label">E-mail do código de confirmação</span>
            <input className="control" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
        </div>
        <PaymentConditions campaignId={campaignId} total={total} />
      </div>
      {message ? <div className="notice" style={{ marginTop: 14 }}><span>{message}</span></div> : null}
      {link ? (
        <div className="contract-box-link">
          <code>{link}</code>
          <button type="button" className="btn btn--primary" onClick={copy}>{copied ? 'Copiado' : 'Copiar link'}</button>
          <a className="btn" href={whatsappUrl(guardian.phone, text)} target="_blank" rel="noreferrer">Mandar no WhatsApp</a>
        </div>
      ) : (
        <div className="contract-box-action">
          <span>{chosen.length ? `${chosen.length > 1 ? 'Um link para os ' + chosen.length + ' alunos' : 'Link individual de ' + chosen[0].student_name.split(' ')[0]} · ${money(total)}` : 'Nenhum aluno marcado'}</span>
          <button type="button" className="btn btn--primary" onClick={create} disabled={busy || !chosen.length}>{busy ? 'Preparando…' : 'Gerar link de assinatura'}</button>
        </div>
      )}
    </section>
  );
}
