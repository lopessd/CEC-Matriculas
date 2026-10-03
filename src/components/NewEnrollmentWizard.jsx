import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Field } from './ui';
import AddressFields from './AddressFields';
import {
  createStaffEnrollment, getActiveCampaign, getFamilyDetail, getPaymentPlans, getPublicOfferings,
  setEnrollmentPaymentPlan, setFamilyBilling, startFamilyContract
} from '../services/data';
import { formatCpf, formatPhoneBr, isValidCpf, isValidEmail, isValidPhoneBr, money } from '../lib/format';
import { contractUrl, todayIso, whatsappUrl } from '../lib/journey';

/* Matrícula nova feita pela secretaria, em quatro passos: responsável, alunos,
   pagamento e próximo passo. No fim a equipe escolhe o que mandar ao pai: o
   link da jornada completa (ele confere tudo) ou só o link da assinatura
   (quando a família já decidiu tudo no balcão ou no WhatsApp). */

const STEPS = ['Responsável', 'Alunos', 'Pagamento', 'Enviar'];
const emptyChild = () => ({ name: '', gradeId: '', birthDate: '', currentSchool: '' });
const emptyGuardian = { cpf: '', name: '', phone: '', email: '', address: '', relationship: '', source: 'visita_presencial', notes: '' };

const SOURCES = [
  { value: 'visita_presencial', label: 'Visita presencial' }, { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'indicacao', label: 'Indicação' }, { value: 'instagram', label: 'Instagram' },
  { value: 'telefone', label: 'Telefone' }, { value: 'outro', label: 'Outra' }
];

const BILLING = [
  ['boleto', 'Boleto', 'Com Pix no mesmo boleto'],
  ['pix', 'Pix', 'Copia e cola por parcela'],
  ['cartao', 'Cartão', 'Até 3x, taxa paga pela família'],
  ['dinheiro', 'Dinheiro', 'Pago na secretaria']
];

export default function NewEnrollmentWizard({ onClose, onCreated }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [guardian, setGuardian] = useState(emptyGuardian);
  const [children, setChildren] = useState([emptyChild()]);
  const [planId, setPlanId] = useState('');
  const [method, setMethod] = useState('boleto');
  const [offerings, setOfferings] = useState([]);
  const [plans, setPlans] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [signLink, setSignLink] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    getPublicOfferings().then((result) => setOfferings(result.offerings || [])).catch(() => setOfferings([]));
    getActiveCampaign('matricula_nova')
      .then((campaign) => getPaymentPlans(campaign?.id))
      .then((rows) => setPlans((rows || []).filter((plan) => !plan.available_until || plan.available_until >= todayIso())))
      .catch(() => setPlans([]));
  }, []);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const gradeOptions = offerings.map((item) => ({ value: item.grade_id, label: `${item.grades?.name} · ${money(item.amount_cents)}` }));
  const priceOf = (gradeId) => offerings.find((item) => item.grade_id === gradeId)?.amount_cents || 0;
  const total = children.reduce((sum, child) => sum + priceOf(child.gradeId), 0);
  const plan = plans.find((item) => item.id === planId);
  const set = (patch) => setGuardian((current) => ({ ...current, ...patch }));
  const setChild = (index, patch) => setChildren((current) => current.map((child, i) => (i === index ? { ...child, ...patch } : child)));

  const guardianErrors = useMemo(() => {
    const list = [];
    if (!isValidCpf(guardian.cpf)) list.push('CPF');
    if (guardian.name.trim().length < 3) list.push('nome');
    if (!isValidPhoneBr(guardian.phone)) list.push('WhatsApp');
    if (!isValidEmail(guardian.email)) list.push('e-mail');
    if (!guardian.address.trim()) list.push('endereço');
    return list;
  }, [guardian]);
  const childrenOk = children.every((child) => child.name.trim().length >= 3 && child.gradeId);

  function next() {
    setError('');
    if (step === 0 && guardianErrors.length) { setError(`Confira: ${guardianErrors.join(', ')}.`); return; }
    if (step === 1 && !childrenOk) { setError('Cada aluno precisa de nome completo e série.'); return; }
    if (step === 2) { submit(); return; }
    setStep((value) => value + 1);
  }

  async function submit() {
    setBusy(true); setError('');
    const results = [];
    try {
      for (const child of children) {
        const result = await createStaffEnrollment({
          guardianCpf: guardian.cpf, guardianName: guardian.name, phone: guardian.phone, email: guardian.email,
          address: guardian.address, studentName: child.name, gradeId: child.gradeId, birthDate: child.birthDate,
          currentSchool: child.currentSchool, source: guardian.source, relationship: guardian.relationship, notes: guardian.notes
        });
        results.push({ ...result, student: child.name });
      }
      const ids = results.map((item) => item.id);
      if (planId) for (const id of ids) await setEnrollmentPaymentPlan(id, planId);
      const detail = await getFamilyDetail(ids[0]);
      const guardianId = detail?.guardian?.id;
      if (guardianId && method) await setFamilyBilling(guardianId, method);
      const link = results.find((item) => item.link_token)?.link_token;
      setCreated({ ids, guardianId, journeyLink: link ? `${window.location.origin}/matricula/${link}` : '' });
      setStep(3);
      onCreated?.();
    } catch (cause) {
      const done = results.length ? ` (${results.map((item) => item.student).join(', ')} já ${results.length > 1 ? 'foram cadastrados' : 'foi cadastrado'})` : '';
      setError(`${cause.message || 'Não foi possível cadastrar.'}${done}`);
    } finally {
      setBusy(false);
    }
  }

  async function makeSignLink() {
    setBusy(true); setError('');
    try {
      const result = await startFamilyContract(created.ids, guardian.email);
      setSignLink(contractUrl(result.token));
    } catch (cause) {
      setError(cause.message || 'Não foi possível preparar o contrato.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(label, value) {
    await navigator.clipboard?.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(''), 1800);
  }

  const firstName = guardian.name.trim().split(' ')[0] || '';
  const names = children.map((child) => child.name.trim().split(' ')[0]).join(' e ');
  const message = (url, signOnly) => `Olá, ${firstName}! Aqui é a secretaria do CEC 😊\n${signOnly
    ? `A matrícula de ${names} para 2027 já está pronta. Falta só a sua assinatura do contrato, por este link:`
    : `Para seguir com a matrícula de ${names} em 2027, confira os dados por este link:`}\n${url}`;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="modal-card wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
        <div className="modal-head">
          <div>
            <h2 id="wizard-title">Nova matrícula</h2>
            <p>Cadastro feito pela secretaria. No fim, você escolhe o que mandar para a família.</p>
          </div>
          <button className="modal-close" type="button" aria-label="Fechar" onClick={onClose} disabled={busy}>×</button>
        </div>
        <ol className="wizard-steps">
          {STEPS.map((label, index) => <li key={label} className={index === step ? 'is-current' : index < step ? 'is-done' : ''}><span>{index < step ? '✓' : index + 1}</span>{label}</li>)}
        </ol>

        <div className="modal-form">
          {step === 0 ? (
            <div className="grid grid--2">
              <div>
                <Field label="CPF do responsável" ph="000.000.000-00" value={guardian.cpf} onChange={(value) => set({ cpf: formatCpf(value) })} inputMode="numeric" maxLength={14} required />
                {guardian.cpf.length === 14 && !isValidCpf(guardian.cpf) ? <small className="field-error">CPF inválido.</small> : null}
                <small className="wizard-hint">Se o CPF já existe (ex.: família da rematrícula), o cadastro é atualizado e os alunos entram no mesmo responsável.</small>
              </div>
              <Field label="Nome completo" ph="Nome do responsável financeiro" value={guardian.name} onChange={(value) => set({ name: value })} required />
              <Field label="WhatsApp" ph="(33) 9 0000-0000" value={guardian.phone} onChange={(value) => set({ phone: formatPhoneBr(value) })} inputMode="tel" required />
              <Field label="E-mail" ph="nome@email.com" type="email" value={guardian.email} onChange={(value) => set({ email: value })} required />
              <div style={{ gridColumn: '1 / -1' }}><AddressFields value={guardian.address} onChange={(value) => set({ address: value })} /></div>
              <Field label="Parentesco" ph="Mãe, pai, avó…" value={guardian.relationship} onChange={(value) => set({ relationship: value })} />
              <Field label="Como conheceu" type="select" value={guardian.source} onChange={(value) => set({ source: value })} options={SOURCES} />
            </div>
          ) : null}

          {step === 1 ? (
            <div className="wizard-children">
              {children.map((child, index) => (
                <div className="wizard-child" key={index}>
                  <div className="wizard-child-head">
                    <strong>Aluno {index + 1}</strong>
                    {child.gradeId ? <span>{money(priceOf(child.gradeId))}</span> : null}
                    {children.length > 1 ? <button type="button" className="btn btn--ghost" onClick={() => setChildren((current) => current.filter((_, i) => i !== index))}>Remover</button> : null}
                  </div>
                  <div className="grid grid--2">
                    <Field label="Nome completo do aluno" value={child.name} onChange={(value) => setChild(index, { name: value })} required />
                    <Field label="Série em 2027" type="select" ph="Selecionar série" value={child.gradeId} onChange={(value) => setChild(index, { gradeId: value })} options={gradeOptions} required />
                    <Field label="Nascimento" type="date" value={child.birthDate} onChange={(value) => setChild(index, { birthDate: value })} />
                    <Field label="Escola atual" ph="Opcional" value={child.currentSchool} onChange={(value) => setChild(index, { currentSchool: value })} />
                  </div>
                </div>
              ))}
              <button type="button" className="btn wizard-add" onClick={() => setChildren((current) => [...current, emptyChild()])}>+ Adicionar irmão</button>
              {total ? <div className="wizard-total"><span>Matrícula ({children.length} aluno{children.length > 1 ? 's' : ''})</span><strong>{money(total)}</strong></div> : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="wizard-pay">
              <div>
                <h3>Plano</h3>
                <p className="meta">Define em quantas vezes e quando paga. Pode deixar para a família escolher no link.</p>
                <div className="wizard-options">
                  <button type="button" className={`wizard-option${!planId ? ' is-active' : ''}`} onClick={() => setPlanId('')}><strong>A família escolhe</strong><span>no link da jornada</span></button>
                  {plans.map((item) => (
                    <button type="button" key={item.id} className={`wizard-option${planId === item.id ? ' is-active' : ''}`} onClick={() => setPlanId(item.id)}>
                      <strong>{item.installments}x · {item.name}</strong>
                      <span>{(item.due_dates || []).map((due) => due.slice(8, 10) + '/' + due.slice(5, 7)).join(', ')}{total ? ` · ${money(Math.round(total / item.installments))} por vez` : ''}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <h3>Forma de pagamento</h3>
                <div className="wizard-options wizard-options--4">
                  {BILLING.map(([value, label, hint]) => (
                    <button type="button" key={value} className={`wizard-option${method === value ? ' is-active' : ''}`} onClick={() => setMethod(value)}><strong>{label}</strong><span>{hint}</span></button>
                  ))}
                </div>
              </div>
              <div className="wizard-summary">
                <div><span>Responsável</span><strong>{guardian.name}</strong></div>
                <div><span>Alunos</span><strong>{children.map((child) => child.name).join(', ')}</strong></div>
                <div><span>Total</span><strong>{money(total)}{plan ? ` em ${plan.installments}x` : ''}</strong></div>
              </div>
            </div>
          ) : null}

          {step === 3 && created ? (
            <div className="wizard-done">
              <div className="wizard-done-head">
                <span className="wizard-check">✓</span>
                <div><strong>Matrícula cadastrada</strong><span>{children.length} aluno{children.length > 1 ? 's' : ''} · {money(total)}{plan ? ` · ${plan.installments}x` : ''} · {BILLING.find(([value]) => value === method)?.[1]}</span></div>
              </div>
              <div className="wizard-send">
                <div className="wizard-send-card">
                  <strong>Só assinatura</strong>
                  <p>Para quando a família já decidiu tudo. O pai recebe o contrato, confirma o código do e-mail e assina. As parcelas nascem na assinatura.</p>
                  {signLink ? (
                    <>
                      <code>{signLink}</code>
                      <div className="wizard-send-actions">
                        <button type="button" className="btn btn--primary" onClick={() => copy('sign', signLink)}>{copied === 'sign' ? 'Copiado' : 'Copiar link'}</button>
                        <a className="btn" href={whatsappUrl(guardian.phone, message(signLink, true))} target="_blank" rel="noreferrer">Mandar no WhatsApp</a>
                      </div>
                    </>
                  ) : <button type="button" className="btn btn--primary" disabled={busy} onClick={makeSignLink}>{busy ? 'Preparando…' : 'Gerar link de assinatura'}</button>}
                </div>
                <div className="wizard-send-card">
                  <strong>Jornada completa</strong>
                  <p>O pai confere os dados, escolhe o plano (se você não escolheu) e segue para a assinatura.</p>
                  {created.journeyLink ? (
                    <>
                      <code>{created.journeyLink}</code>
                      <div className="wizard-send-actions">
                        <button type="button" className="btn" onClick={() => copy('journey', created.journeyLink)}>{copied === 'journey' ? 'Copiado' : 'Copiar link'}</button>
                        <a className="btn" href={whatsappUrl(guardian.phone, message(created.journeyLink, false))} target="_blank" rel="noreferrer">Mandar no WhatsApp</a>
                      </div>
                    </>
                  ) : <span className="meta">Link indisponível para esta matrícula.</span>}
                </div>
              </div>
              <p className="meta">Depois da assinatura, a ficha da família mostra as parcelas: dá para gerar as cobranças no Asaas ou marcar como recebido na secretaria.</p>
            </div>
          ) : null}

          {error ? <div className="notice" style={{ marginTop: 16 }}><span>{error}</span></div> : null}

          <div className="modal-actions">
            {step === 3 ? (
              <>
                <button type="button" className="btn" onClick={onClose}>Fechar</button>
                <button type="button" className="btn btn--primary" onClick={() => navigate(`/familias/${created?.guardianId || created?.ids?.[0]}`)}>Abrir ficha da família</button>
              </>
            ) : (
              <>
                {step > 0 ? <button type="button" className="btn btn--ghost" onClick={() => { setError(''); setStep((value) => value - 1); }} disabled={busy}>← Voltar</button> : <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>}
                <button type="button" className="btn btn--primary" onClick={next} disabled={busy}>{busy ? 'Cadastrando…' : step === 2 ? 'Cadastrar matrícula' : 'Continuar →'}</button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
