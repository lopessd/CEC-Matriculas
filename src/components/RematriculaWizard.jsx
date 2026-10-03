import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Field } from './ui';
import {
  addRematriculaChild, chooseOnboardingPlan, getActiveCampaign, getPaymentPlans, getPublicOfferings,
  searchRematriculaFamilies, selectRematriculaChildren, setFamilyBilling, startStaffRematricula
} from '../services/data';
import { money } from '../lib/format';
import { formatCpfView, formatPhoneView, journeyUrl, stageInfo, todayIso, whatsappUrl } from '../lib/journey';

/* Rematrícula feita pela secretaria: busca a família, marca os filhos (e
   adiciona irmão novo, que paga a tabela cheia), escolhe plano e forma. Tudo
   vai para a jornada da própria família, então o link que o pai recebe abre
   no ponto certo — direto na assinatura quando o plano já foi escolhido. */

const STEPS = ['Família', 'Alunos', 'Pagamento', 'Enviar'];
const BILLING = [
  ['boleto', 'Boleto', 'Com Pix no mesmo boleto'],
  ['pix', 'Pix', 'Copia e cola por parcela'],
  ['cartao', 'Cartão', 'Até 3x, taxa paga pela família'],
  ['dinheiro', 'Dinheiro', 'Pago na secretaria']
];
const emptySibling = () => ({ name: '', gradeId: '', birthDate: '' });

export default function RematriculaWizard({ onClose, onCreated, onSwitchToNew }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [family, setFamily] = useState(null);
  const [selected, setSelected] = useState([]);
  const [siblings, setSiblings] = useState([]);
  const [offerings, setOfferings] = useState([]);
  const [plans, setPlans] = useState([]);
  const [installments, setInstallments] = useState(0);
  const [method, setMethod] = useState('boleto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getPublicOfferings().then((result) => setOfferings(result.offerings || [])).catch(() => setOfferings([]));
    getActiveCampaign('rematricula')
      .then((campaign) => getPaymentPlans(campaign?.id))
      .then((rows) => setPlans((rows || []).filter((plan) => !plan.available_until || plan.available_until >= todayIso())))
      .catch(() => setPlans([]));
  }, []);

  // Busca enquanto digita (espera a pessoa parar um instante).
  useEffect(() => {
    const value = term.trim();
    if (value.length < 3) { setResults(null); return undefined; }
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchRematriculaFamilies(value)
        .then((rows) => setResults(rows || []))
        .catch((cause) => { setResults([]); setError(cause.message); })
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const children = family?.children || [];
  const signedIds = children.filter((child) => child.signed_at).map((child) => child.student_id);
  const priceOf = (child) => child.enrollment_amount_cents ?? child.amount_cents ?? 0;
  const siblingPrice = (gradeId) => offerings.find((item) => item.grade_id === gradeId)?.amount_cents || 0;
  const chosen = children.filter((child) => selected.includes(child.student_id) && !child.signed_at);
  const validSiblings = siblings.filter((sibling) => sibling.name.trim().length >= 3 && sibling.gradeId);
  const total = chosen.reduce((sum, child) => sum + priceOf(child), 0) + validSiblings.reduce((sum, sibling) => sum + siblingPrice(sibling.gradeId), 0);
  const plan = plans.find((item) => item.installments === installments);
  const gradeOptions = offerings.map((item) => ({ value: item.grade_id, label: `${item.grades?.name} · ${money(item.amount_cents)}` }));

  function pick(item) {
    setFamily(item);
    setSelected((item.children || []).filter((child) => !child.signed_at && (child.next_grade_id || child.enrollment_id)).map((child) => child.student_id));
    setSiblings([]);
    setError('');
    setStep(1);
  }

  const canRematricular = (child) => Boolean(child.next_grade_id || child.enrollment_id);

  function next() {
    setError('');
    if (step === 1) {
      if (siblings.some((sibling) => sibling.name.trim() && !sibling.gradeId)) { setError('Escolha a série do irmão novo.'); return; }
      if (!chosen.length && !validSiblings.length) { setError('Marque pelo menos um aluno para rematricular (ou adicione um irmão).'); return; }
    }
    if (step === 2) { submit(); return; }
    setStep((value) => value + 1);
  }

  async function submit() {
    setBusy(true); setError('');
    try {
      const session = await startStaffRematricula(family.guardian_id);
      const added = [];
      for (const sibling of validSiblings) {
        const result = await addRematriculaChild(session.token, { name: sibling.name, gradeId: sibling.gradeId, birthDate: sibling.birthDate });
        if (result?.added_student_id) added.push(result.added_student_id);
      }
      // Os que já assinaram continuam na jornada (senão sairiam dela).
      await selectRematriculaChildren(session.token, [...new Set([...signedIds, ...chosen.map((child) => child.student_id), ...added])]);
      if (installments) await chooseOnboardingPlan(session.token, installments);
      if (method) await setFamilyBilling(family.guardian_id, method);
      setDone({ token: session.token, link: journeyUrl({ token: session.token, flow: 'rematricula' }) });
      setStep(3);
      onCreated?.();
    } catch (cause) {
      setError(cause.message || 'Não foi possível montar a rematrícula.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard?.writeText(done.link);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const first = String(family?.full_name || '').split(' ')[0];
  const names = [...chosen.map((child) => child.name.split(' ')[0]), ...validSiblings.map((sibling) => sibling.name.trim().split(' ')[0])].join(' e ');
  const message = done ? `Olá, ${first}! Aqui é a secretaria do CEC 😊\nA rematrícula de ${names} para 2027 está pronta${plan ? ` (${plan.installments}x)` : ''}. ${plan ? 'Falta só a sua assinatura do contrato' : 'Escolha o plano e assine o contrato'} por este link:\n${done.link}` : '';

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="modal-card wizard" role="dialog" aria-modal="true" aria-labelledby="remat-title">
        <div className="modal-head">
          <div>
            <h2 id="remat-title">Rematrícula pela secretaria</h2>
            <p>Busque a família da base, marque os filhos e envie o link para o pai assinar.</p>
          </div>
          <button className="modal-close" type="button" aria-label="Fechar" onClick={onClose} disabled={busy}>×</button>
        </div>
        <ol className="wizard-steps">
          {STEPS.map((label, index) => <li key={label} className={index === step ? 'is-current' : index < step ? 'is-done' : ''}><span>{index < step ? '✓' : index + 1}</span>{label}</li>)}
        </ol>

        <div className="modal-form">
          {step === 0 ? (
            <div className="remat-search">
              <input className="control remat-search-input" autoFocus placeholder="Nome do pai ou da mãe, CPF, telefone ou nome do aluno" value={term} onChange={(event) => setTerm(event.target.value)} />
              {searching ? <div className="meta">Buscando…</div> : null}
              {results && !results.length && !searching ? (
                <div className="remat-empty">
                  <span>Nenhuma família encontrada com “{term}”.</span>
                  <button type="button" className="btn" onClick={onSwitchToNew}>Fazer matrícula nova</button>
                </div>
              ) : null}
              <div className="remat-results">
                {(results || []).map((item) => {
                  const stage = item.session ? stageInfo(item.session.stage, 'rematricula') : null;
                  return (
                    <button key={item.guardian_id} type="button" className="remat-result" onClick={() => pick(item)}>
                      <div className="remat-result-top">
                        <strong>{item.full_name}</strong>
                        {stage ? <span className="stage-pill" style={{ '--accent': stage.color }}><i />{stage.label}</span> : null}
                      </div>
                      <span className="meta">{formatPhoneView(item.phone)} · CPF {formatCpfView(item.cpf)}</span>
                      <span className="remat-result-kids">{(item.children || []).map((child) => `${child.name}${child.class_name ? ` (${child.class_name})` : ''}`).join(' · ') || 'Sem alunos vinculados'}</span>
                    </button>
                  );
                })}
              </div>
              {!results ? <p className="meta">Digite pelo menos 3 letras. A busca acha a família pelo responsável ou por qualquer filho.</p> : null}
            </div>
          ) : null}

          {step === 1 && family ? (
            <div className="wizard-children">
              <div className="remat-family">
                <div><strong>{family.full_name}</strong><span>{formatPhoneView(family.phone)} · CPF {formatCpfView(family.cpf)}</span></div>
                <button type="button" className="btn btn--ghost" onClick={() => { setFamily(null); setStep(0); }}>Trocar família</button>
              </div>
              {children.map((child) => {
                const blocked = !canRematricular(child);
                const signed = Boolean(child.signed_at);
                return (
                  <label key={child.student_id} className={`contract-box-student${selected.includes(child.student_id) || signed ? ' is-on' : ''}${blocked ? ' is-blocked' : ''}`}>
                    <input type="checkbox" disabled={blocked || signed} checked={signed || selected.includes(child.student_id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, child.student_id] : current.filter((id) => id !== child.student_id))} />
                    <span>
                      <strong>{child.name}</strong>
                      <small>
                        {signed ? `Já assinou · ${child.target_grade || child.next_grade}` : blocked ? `${child.class_name || 'Sem turma'} · sem série seguinte configurada` : `${child.class_name || child.current_grade || '—'} → ${child.target_grade || child.next_grade}`}
                        {child.is_new_student ? ' · irmão novo' : ''}
                      </small>
                    </span>
                    <b>{blocked ? '—' : money(priceOf(child))}</b>
                  </label>
                );
              })}
              {siblings.map((sibling, index) => (
                <div className="wizard-child" key={index}>
                  <div className="wizard-child-head">
                    <strong>Irmão novo {siblings.length > 1 ? index + 1 : ''}</strong>
                    {sibling.gradeId ? <span>{money(siblingPrice(sibling.gradeId))} (tabela cheia)</span> : null}
                    <button type="button" className="btn btn--ghost" onClick={() => setSiblings((current) => current.filter((_, i) => i !== index))}>Remover</button>
                  </div>
                  <div className="grid grid--3">
                    <Field label="Nome completo" value={sibling.name} onChange={(value) => setSiblings((current) => current.map((item, i) => (i === index ? { ...item, name: value } : item)))} />
                    <Field label="Série em 2027" type="select" ph="Selecionar série" value={sibling.gradeId} options={gradeOptions} onChange={(value) => setSiblings((current) => current.map((item, i) => (i === index ? { ...item, gradeId: value } : item)))} />
                    <Field label="Nascimento" type="date" value={sibling.birthDate} onChange={(value) => setSiblings((current) => current.map((item, i) => (i === index ? { ...item, birthDate: value } : item)))} />
                  </div>
                </div>
              ))}
              <button type="button" className="btn wizard-add" onClick={() => setSiblings((current) => [...current, emptySibling()])}>+ Adicionar irmão que ainda não estuda no CEC</button>
              <div className="wizard-total"><span>{chosen.length + validSiblings.length} aluno{chosen.length + validSiblings.length === 1 ? '' : 's'} nesta rematrícula{chosen.length + validSiblings.length > 1 ? ' · um contrato para todos' : ''}</span><strong>{money(total)}</strong></div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="wizard-pay">
              <div>
                <h3>Plano</h3>
                <p className="meta">Com o plano escolhido aqui, o link do pai abre direto na assinatura.</p>
                <div className="wizard-options">
                  <button type="button" className={`wizard-option${!installments ? ' is-active' : ''}`} onClick={() => setInstallments(0)}><strong>A família escolhe</strong><span>no link, antes de assinar</span></button>
                  {plans.map((item) => (
                    <button type="button" key={item.id} className={`wizard-option${installments === item.installments ? ' is-active' : ''}`} onClick={() => setInstallments(item.installments)}>
                      <strong>{item.installments}x · {item.name.split(' — ')[1] || item.name}</strong>
                      <span>{(item.due_dates || []).map((due) => `${due.slice(8, 10)}/${due.slice(5, 7)}`).join(', ')}{total ? ` · ${money(Math.round(total / item.installments))} por vez` : ''}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <h3>Forma de pagamento</h3>
                <div className="wizard-options wizard-options--4">
                  {BILLING.map(([value, label, hint]) => <button type="button" key={value} className={`wizard-option${method === value ? ' is-active' : ''}`} onClick={() => setMethod(value)}><strong>{label}</strong><span>{hint}</span></button>)}
                </div>
              </div>
              <div className="wizard-summary">
                <div><span>Responsável</span><strong>{family?.full_name}</strong></div>
                <div><span>Alunos</span><strong>{[...chosen.map((child) => child.name), ...validSiblings.map((sibling) => sibling.name)].join(', ')}</strong></div>
                <div><span>Total</span><strong>{money(total)}{plan ? ` em ${plan.installments}x` : ''}</strong></div>
              </div>
            </div>
          ) : null}

          {step === 3 && done ? (
            <div className="wizard-done">
              <div className="wizard-done-head">
                <span className="wizard-check">✓</span>
                <div><strong>Rematrícula montada</strong><span>{names} · {money(total)}{plan ? ` · ${plan.installments}x` : ' · plano a escolher'} · {BILLING.find(([value]) => value === method)?.[1]}</span></div>
              </div>
              <div className="wizard-send-card">
                <strong>{plan ? 'Link para assinar' : 'Link da rematrícula'}</strong>
                <p>{plan ? 'O pai abre, confere os alunos e assina (com o código que chega no e-mail). É um contrato para todos os filhos.' : 'O pai abre, escolhe o plano e assina.'} As parcelas nascem na assinatura.</p>
                <code>{done.link}</code>
                <div className="wizard-send-actions">
                  <button type="button" className="btn btn--primary" onClick={copy}>{copied ? 'Copiado' : 'Copiar link'}</button>
                  <a className="btn" href={whatsappUrl(family.phone, message)} target="_blank" rel="noreferrer">Mandar no WhatsApp</a>
                </div>
              </div>
            </div>
          ) : null}

          {error ? <div className="notice" style={{ marginTop: 16 }}><span>{error}</span></div> : null}

          <div className="modal-actions">
            {step === 3 ? (
              <>
                <button type="button" className="btn" onClick={onClose}>Fechar</button>
                <button type="button" className="btn btn--primary" onClick={() => navigate(`/familias/${family.guardian_id}`)}>Abrir ficha da família</button>
              </>
            ) : (
              <>
                {step > 0 ? <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setError(''); setStep((value) => value - 1); }}>← Voltar</button> : <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>}
                {step > 0 ? <button type="button" className="btn btn--primary" disabled={busy} onClick={next}>{busy ? 'Montando…' : step === 2 ? 'Montar rematrícula' : 'Continuar →'}</button> : null}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
