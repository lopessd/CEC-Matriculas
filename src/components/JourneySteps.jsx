import { useEffect, useState } from 'react';
import { contractPdfUrl, downloadFiles, onboardingCardQuote } from '../services/data';
import { date, money } from '../lib/format';

const methodInfo = {
  boleto: { label: 'Boleto', hint: 'Um boleto para cada vencimento.' },
  cartao: { label: 'Cartão de crédito', hint: 'Em até 3x no cartão, com a taxa do cartão.' },
  pix: { label: 'Pix', hint: 'Um Pix para cada vencimento, com QR Code.' },
};

// Mesma divisão de public.generate_installments(): a primeira parcela leva o
// resto dos centavos. Calculada por aluno e somada por vencimento.
function splitInstallments(totalCents, count) {
  const base = Math.floor(totalCents / count);
  return Array.from({ length: count }, (_, index) => base + (index === 0 ? totalCents - base * count : 0));
}

export function familySchedule(children, plan) {
  if (!plan) return [];
  const count = Number(plan.installments) || 1;
  const sums = Array(count).fill(0);
  children.forEach((child) => splitInstallments(Number(child.amount_cents) || 0, count).forEach((value, index) => { sums[index] += value; }));
  return sums.map((amount, index) => ({ amount, due: plan.due_dates?.[index] }));
}

function planLabel(plan) {
  const count = Number(plan.installments);
  return count === 1 ? 'À vista' : `${count}x`;
}

function planDates(plan) {
  const dates = (plan.due_dates || []).map((item) => date(item).slice(0, 5));
  return dates.length > 1 ? `${dates.slice(0, -1).join(', ')} e ${dates[dates.length - 1]}` : dates[0] || '';
}

export function PlanSummary({ data, onChange }) {
  const plan = data.plan_choice;
  if (!plan) return null;
  const children = (data.children || []).filter((child) => child.selected);
  const schedule = familySchedule(children, plan);
  const same = schedule.every((item) => item.amount === schedule[schedule.length - 1]?.amount);
  return <div className="values-choice-bar">
    <div><small>Condição escolhida</small><strong>{schedule.length === 1 ? `À vista · ${money(schedule[0].amount)} em ${date(schedule[0].due)}` : `${schedule.length}x ${same ? `de ${money(schedule[0].amount)}` : `(${schedule.map((item) => money(item.amount)).join(' + ')})`} · ${planDates(plan)}`}</strong></div>
    {onChange ? <button type="button" className="text-link" onClick={onChange}>Alterar</button> : null}
  </div>;
}

export function ChildrenPrices({ children, early }) {
  return <div className="values-children">
    {children.map((child) => <article key={child.student_id}>
      <div><strong>{child.name}</strong><span>{child.target_grade} · 2027{child.is_new ? ' · novo aluno' : ''}</span></div>
      <div className="values-children__price">{early && child.full_amount_cents > child.amount_cents ? <s>{money(child.full_amount_cents)}</s> : null}<b>{money(child.amount_cents)}</b></div>
    </article>)}
  </div>;
}

export function ConditionsStep({ data, busy, onConfirm, onEditChildren }) {
  const children = (data.children || []).filter((child) => child.selected);
  const choices = data.plan_choices || [];
  const early = Boolean(data.pricing?.early_active);
  const earlyUntil = data.pricing?.early_until;
  const [installments, setInstallments] = useState(Number(data.plan_choice?.installments) || Number(choices[0]?.installments) || 1);
  const current = choices.find((item) => Number(item.installments) === installments) || choices[0];
  const schedule = familySchedule(children, current);
  const total = children.reduce((sum, child) => sum + (Number(child.amount_cents) || 0), 0);
  const fullTotal = children.reduce((sum, child) => sum + (Number(child.full_amount_cents) || Number(child.amount_cents) || 0), 0);
  const savings = early ? Math.max(0, fullTotal - total) : 0;

  if (!choices.length) return <div className="notice"><span>O prazo de pagamento de 2027 terminou. Fale com a secretaria para concluir.</span></div>;

  return <section className="onboarding-form values-step">
    {savings > 0 ? <div className="values-hero">
      <span className="values-hero__tag">Valor especial até {date(earlyUntil)}</span>
      <div className="values-hero__numbers">
        <div><small>Tabela 2027</small><s>{money(fullTotal)}</s></div>
        <div className="values-hero__main"><small>Fechando em outubro você paga</small><strong>{money(total)}</strong></div>
      </div>
      <p>Você economiza <b>{money(savings)}</b> e escolhe quando pagar.</p>
    </div> : <div className="values-hero values-hero--plain">
      <span className="values-hero__tag">{children.length > 1 ? 'Total da família' : 'Valor da matrícula'}</span>
      <div className="values-hero__numbers"><div className="values-hero__main"><small>{children.length > 1 ? `${children.length} alunos` : 'Valor 2027'}</small><strong>{money(total)}</strong></div></div>
    </div>}

    <ChildrenPrices children={children} early={early} />
    {onEditChildren ? <button type="button" className="text-link" onClick={onEditChildren}>Alterar alunos</button> : null}

    <div className="values-config">
      <h3>Em quantas vezes e quando você quer pagar?</h3>
      <div className="values-segment" role="radiogroup" aria-label="Condição de pagamento">
        {choices.map((plan) => <button type="button" role="radio" aria-checked={installments === Number(plan.installments)} key={plan.installments} className={installments === Number(plan.installments) ? 'is-active' : ''} onClick={() => setInstallments(Number(plan.installments))}>
          <strong>{planLabel(plan)}</strong>
          <small>{Number(plan.installments) === 1 ? `só em ${planDates(plan)}` : planDates(plan)}</small>
        </button>)}
      </div>
      <div className="values-schedule">
        {schedule.map((item, index) => <div key={item.due || index}><span>{schedule.length > 1 ? `${index + 1}ª parcela` : 'Parcela única'} · vence {date(item.due)}</span><b>{money(item.amount)}</b></div>)}
        <div className="values-schedule__total"><span>Total</span><b>{money(total)}</b></div>
      </div>
      <p className="meta">Boleto, cartão ou Pix: você escolhe depois de assinar.</p>
    </div>

    {early ? <div className="notice"><span>O valor fica garantido quando você assinar. Assinando a partir de 01/11, vale a tabela 2027 com pagamento em janeiro.</span></div> : null}
    <button className="cta" disabled={busy || !current} onClick={() => onConfirm(Number(current.installments))}>{busy ? 'Salvando…' : 'Confirmar e seguir para o contrato →'}</button>
  </section>;
}

export function SignStep({ data, busy, email, onEmail, onSign, onEditPlan, field: FieldComponent }) {
  const selected = (data.children || []).filter((child) => child.selected);
  const pending = selected.filter((child) => !child.signed_at && child.contract_status !== 'assinada');
  const tokens = [...new Set(pending.map((child) => child.contract_token).filter(Boolean))];
  const sharedToken = pending.length && tokens.length === 1 && pending.every((child) => child.contract_token) ? tokens[0] : null;
  const total = pending.reduce((sum, child) => sum + (Number(child.amount_cents) || 0), 0);
  const multiple = pending.length > 1;
  return <section className="onboarding-form">
    <PlanSummary data={data} onChange={selected.some((child) => child.signed_at) ? null : onEditPlan} />
    <FieldComponent label="E-mail para receber o código de assinatura" type="email" value={email} onChange={onEmail} required />
    <div className="family-sign">
      <div className="family-sign__head"><strong>{multiple ? `Assine os ${pending.length} contratos de uma vez` : 'Assine o contrato'}</strong><span>{multiple ? 'Um código por e-mail e uma assinatura só, aplicada em cada contrato. Cada aluno fica com o seu PDF.' : 'Confira os dados, leia o contrato, confirme o código do e-mail e assine.'}</span></div>
      <ul>{pending.map((child) => <li key={child.enrollment_id}><span>{child.name}<small>{child.target_grade}</small></span><b>{money(child.amount_cents)}</b></li>)}{multiple ? <li className="family-sign__total"><span>Total</span><b>{money(total)}</b></li> : null}</ul>
      <button className="cta" onClick={() => onSign(sharedToken)} disabled={busy}>{busy ? 'Preparando…' : sharedToken ? 'Continuar assinatura →' : multiple ? `Assinar os ${pending.length} contratos →` : 'Assinar contrato →'}</button>
    </div>
  </section>;
}

function contractUrls(data) {
  return (data.children || [])
    .filter((child) => child.selected && child.contract_token && child.enrollment_id)
    .map((child) => contractPdfUrl(child.contract_token, child.enrollment_id, { download: true }));
}

export function DownloadContracts({ data }) {
  const urls = contractUrls(data);
  if (!urls.length) return null;
  return <button type="button" className="btn" onClick={() => downloadFiles(urls)}>⬇ Baixar {urls.length > 1 ? `os ${urls.length} contratos assinados` : 'contrato assinado'}</button>;
}

export function BillingStep({ data, busy, onConfirm }) {
  const [method, setMethod] = useState(data.billing_method || 'boleto');
  const children = (data.children || []).filter((child) => child.selected);
  const plan = data.plan_choice || { installments: (data.charges || []).length || 1, due_dates: (data.charges || []).map((item) => item.due_date) };
  const schedule = (data.charges || []).length
    ? data.charges.map((item) => ({ amount: Number(item.amount_cents), due: item.due_date }))
    : familySchedule(children, plan);
  const [cardQuote, setCardQuote] = useState(null);
  useEffect(() => {
    if (method !== 'cartao' || cardQuote || !data.token) return;
    onboardingCardQuote(data.token).then(setCardQuote).catch(() => setCardQuote(null));
  }, [method, cardQuote, data.token]);
  return <section className="onboarding-form">
    <div className="values-done"><strong>Contrato{children.length > 1 ? 's' : ''} assinado{children.length > 1 ? 's' : ''} ✓</strong><span>Falta só escolher como pagar. A cobrança é gerada na hora.</span></div>
    <DownloadContracts data={data} />
    <div className="values-config">
      <h3>Como você quer pagar?</h3>
      <div className="values-segment billing-methods" role="radiogroup" aria-label="Forma de pagamento">
        {Object.entries(methodInfo).map(([key, info]) => <button type="button" role="radio" aria-checked={method === key} key={key} className={method === key ? 'is-active' : ''} onClick={() => setMethod(key)}>
          <strong>{info.label}</strong><small>{info.hint}</small>
        </button>)}
      </div>
      {method === 'cartao' ? <div className="values-schedule">
        {cardQuote ? <>
          <div><span>Valor dos contratos</span><b>{money(cardQuote.net_cents)}</b></div>
          <div><span>Taxa do cartão{cardQuote.installments > 1 ? ` em ${cardQuote.installments}x` : ''}</span><b>{money(cardQuote.fee_cents)}</b></div>
          <div className="values-schedule__total"><span>{cardQuote.installments > 1 ? `${cardQuote.installments}x de ${money(cardQuote.installment_cents)}` : 'Total no cartão'}</span><b>{money(cardQuote.total_cents)}</b></div>
        </> : <div><span>Calculando o valor no cartão…</span></div>}
      </div> : <div className="values-schedule">
        {schedule.map((item, index) => <div key={item.due || index}><span>{schedule.length > 1 ? `${index + 1}ª parcela` : 'Parcela única'} · vence {date(item.due)}</span><b>{money(item.amount)}</b></div>)}
      </div>}
      {method === 'cartao' ? <p className="meta">O cartão é cobrado na hora, nas parcelas escolhidas no plano. A taxa do parcelamento é paga por quem usa o cartão.</p> : null}
    </div>
    <button className="cta" disabled={busy || (method === 'cartao' && !cardQuote)} onClick={() => onConfirm(method)}>{busy ? 'Gerando cobrança…' : 'Gerar pagamento →'}</button>
  </section>;
}

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); } catch { window.prompt(label, value); return; }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }
  return <button type="button" className="text-link" onClick={copy}>{copied ? 'Copiado ✓' : label}</button>;
}

const chargeStatus = { pago: ['Pago', 'badge--green'], vencido: ['Vencido', 'badge--red'], pendente: ['A pagar', ''] };

export function PaymentStep({ data, busy, onRetry, onChangeMethod }) {
  const charges = data.charges || [];
  const generated = charges.some((item) => item.payment_url);
  const method = methodInfo[data.billing_method]?.label || '';
  const done = data.flow === 'rematricula' ? 'Rematrícula concluída ✅' : 'Matrícula concluída ✅';
  return <section className="onboarding-form">
    {generated
      ? <div className="onboarding-guardian"><strong>Pagamento{method ? ` · ${method}` : ''}</strong><span>Toque em Pagar em cada vencimento. A confirmação chega aqui sozinha.</span></div>
      : <div className="values-done"><strong>{done}</strong><span>Falta só o pagamento{method ? ` (${method.toLowerCase()})` : ''}.{data.billing_method === 'dinheiro' ? '' : ' Toque abaixo para gerar a cobrança.'}</span></div>}
    <div className="payment-list">
      {charges.map((item, index) => {
        const [label, tone] = chargeStatus[item.status] || chargeStatus.pendente;
        return <article key={`${item.due_date}-${index}`}>
          <div><strong>{charges.length > 1 ? `${index + 1}ª parcela` : 'Parcela única'}</strong><span>vence {date(item.due_date)}</span></div>
          <b>{money(item.amount_cents)}</b>
          {item.status === 'pago' || item.status === 'vencido' ? <span className={`badge ${tone}`}>{label}</span>
            : item.payment_url ? <a className="btn btn--primary" href={item.payment_url} target="_blank" rel="noreferrer">Pagar</a>
              : <span className={`badge ${tone}`}>{label}</span>}
          {item.status === 'pendente' && (item.bank_slip_url || item.boleto_line || item.pix_code) ? <div className="payment-shortcuts">
            {item.bank_slip_url ? <a className="text-link" href={item.bank_slip_url} target="_blank" rel="noreferrer">Baixar boleto</a> : null}
            {item.boleto_line ? <CopyButton value={item.boleto_line} label="Copiar linha digitável" /> : null}
            {item.pix_code ? <CopyButton value={item.pix_code} label="Copiar Pix" /> : null}
          </div> : null}
        </article>;
      })}
    </div>
    {!generated && data.billing_method === 'dinheiro' ? <div className="notice"><span>Pagamento em dinheiro: é só acertar na secretaria do CEC. A confirmação aparece aqui quando a escola registrar.</span></div> : null}
    {!generated && onRetry && data.billing_method !== 'dinheiro' ? <button type="button" className="cta" onClick={onRetry} disabled={busy}>{busy ? 'Gerando cobrança…' : 'Gerar pagamento →'}</button> : null}
    {!generated && onChangeMethod ? <button type="button" className="text-link" onClick={onChangeMethod}>Trocar forma de pagamento</button> : null}
    <DownloadContracts data={data} />
  </section>;
}

export function DoneStep({ data }) {
  return <section className="onboarding-form">
    <div className="values-done"><strong>{data.flow === 'rematricula' ? 'Rematrícula concluída 🎉' : 'Matrícula concluída 🎉'}</strong><span>Pagamento confirmado. Seja bem-vindo(a) ao CEC em 2027!</span></div>
    <DownloadContracts data={data} />
  </section>;
}
