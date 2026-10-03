import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Field, LogoBlocks } from '../components/ui';
import DataState from '../components/DataState';
import cecLogo from '../assets/cec-logo.png';
import AddressFields from '../components/AddressFields';
import { BillingStep, ConditionsStep, DoneStep, PaymentStep, SignStep } from '../components/JourneySteps';
import { formatCpf, formatPhoneBr, isValidCpf, isValidEmail, isValidPhoneBr, money } from '../lib/format';
import {
  addRematriculaChild, chooseOnboardingBilling, chooseOnboardingPlan, createAsaasCheckout, createMatriculaOnboarding,
  getPublicOfferings, identifyRematriculaOnboarding, lookupExistingFamilyForNewEnrollment, openEnrollmentOnboarding,
  prepareFamilyContract, removeAddedChild, selectRematriculaChildren, setGuardianRg, startEnrollmentOnboarding,
  startRematriculaFromNewEnrollment
} from '../services/data';

const emptyChild = { name: '', birthDate: '', birthParts: { day: '', month: '', year: '' }, gradeId: '', previousSchool: '' };
const newFamily = { cpf: '', fullName: '', rg: '', phone: '', email: '', address: '', children: [{ ...emptyChild }] };

// Erros do formulário de matrícula nova. Só aparecem depois que a pessoa sai
// do campo (touched) ou tenta enviar, para não acusar erro no meio da digitação.
function newFamilyErrors(family) {
  const today = new Date();
  const oldest = new Date(today.getFullYear() - 25, today.getMonth(), today.getDate());
  return {
    cpf: !isValidCpf(family.cpf) ? (family.cpf ? 'Esse CPF não existe. Confira os 11 dígitos.' : 'Informe o CPF do responsável.') : '',
    rg: family.rg.trim().length < 4 ? 'Informe o RG do responsável.' : '',
    phone: !isValidPhoneBr(family.phone) ? 'Informe o WhatsApp com DDD, ex.: (33) 9 9999-9999.' : '',
    email: !isValidEmail(family.email) ? 'Informe um e-mail válido, ex.: nome@gmail.com.' : '',
    address: !family.address ? 'Complete o endereço: CEP, cidade, rua, número e bairro.' : '',
    children: family.children.map((child) => {
      const { day, month, year } = child.birthParts || {};
      const filled = [day, month, year].filter(Boolean).length;
      if (filled === 0) return '';
      if (filled < 3) return 'Complete dia, mês e ano.';
      const value = new Date(Number(year), Number(month) - 1, Number(day));
      if (value > today) return 'A data de nascimento não pode ser no futuro.';
      if (value < oldest) return 'Confira o ano de nascimento.';
      return '';
    }),
  };
}

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Data de nascimento em três listas: o ano começa pelo mais recente (crianças)
// e nada depois de hoje aparece como opção.
function BirthDateSelect({ parts, onChange }) {
  const today = new Date();
  const { day = '', month = '', year = '' } = parts || {};
  const years = Array.from({ length: 21 }, (_, index) => String(today.getFullYear() - index));
  const isCurrentYear = Number(year) === today.getFullYear();
  const maxMonth = isCurrentYear ? today.getMonth() + 1 : 12;
  const daysInMonth = month ? new Date(Number(year) || 2000, Number(month), 0).getDate() : 31;
  const maxDay = isCurrentYear && Number(month) === today.getMonth() + 1 ? today.getDate() : daysInMonth;
  function update(next) {
    const merged = { day, month, year, ...next };
    // Ajusta o que ficou impossível depois de trocar ano ou mês (ex.: 31 → fevereiro).
    const mergedCurrentYear = Number(merged.year) === today.getFullYear();
    if (mergedCurrentYear && Number(merged.month) > today.getMonth() + 1) merged.month = '';
    const limit = merged.month
      ? (mergedCurrentYear && Number(merged.month) === today.getMonth() + 1 ? today.getDate() : new Date(Number(merged.year) || 2000, Number(merged.month), 0).getDate())
      : 31;
    if (Number(merged.day) > limit) merged.day = '';
    const iso = merged.day && merged.month && merged.year ? `${merged.year}-${merged.month.padStart(2, '0')}-${merged.day.padStart(2, '0')}` : '';
    onChange(merged, iso);
  }
  return <div className="field"><label>Data de nascimento</label><div className="birth-select">
    <select className="control" aria-label="Dia" value={day} onChange={(event) => update({ day: event.target.value })}><option value="">Dia</option>{Array.from({ length: maxDay }, (_, index) => String(index + 1)).map((item) => <option key={item} value={item}>{item}</option>)}</select>
    <select className="control" aria-label="Mês" value={month} onChange={(event) => update({ month: event.target.value })}><option value="">Mês</option>{MONTHS.slice(0, maxMonth).map((label, index) => <option key={label} value={String(index + 1)}>{label}</option>)}</select>
    <select className="control" aria-label="Ano" value={year} onChange={(event) => update({ year: event.target.value })}><option value="">Ano</option>{years.map((item) => <option key={item} value={item}>{item}</option>)}</select>
  </div></div>;
}

function FieldError({ show, message }) {
  return show && message ? <small className="field-error">{message}</small> : null;
}

const STAGES = {
  rematricula: [['alunos', 'Alunos'], ['condicoes', 'Condições'], ['assinatura', 'Assinatura'], ['cobranca', 'Cobrança'], ['pagamento', 'Pagamento']],
  matricula_nova: [['dados', 'Dados'], ['condicoes', 'Condições'], ['assinatura', 'Assinatura'], ['cobranca', 'Cobrança'], ['pagamento', 'Pagamento']],
};

function Stepper({ flow, stage }) {
  const stages = STAGES[flow] || STAGES.matricula_nova;
  const position = stage === 'concluida' ? stages.length : stages.findIndex(([key]) => key === stage) + 1;
  return <div className="steps onboarding-steps">{stages.map(([key, label], index) => <div className={`step${index + 1 <= position ? ' is-done' : ''}`} key={key}><i /><span>{label}</span></div>)}</div>;
}

function Title({ flow, stage, multi }) {
  const remat = flow === 'rematricula';
  const heading = {
    identificacao: 'Vamos encontrar sua família',
    alunos: 'Quem vai estudar no CEC em 2027?',
    dados: 'Comece a matrícula da sua família',
    condicoes: 'Escolha como e quando pagar',
    assinatura: multi ? 'Assine os contratos' : 'Assine o contrato',
    cobranca: 'Como você quer pagar?',
    pagamento: 'Pagamento',
    concluida: remat ? 'Rematrícula concluída' : 'Matrícula concluída',
  }[stage] || 'Matrícula 2027';
  return <div className="public-head--navy onboarding-head"><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><LogoBlocks /><span className="public-kicker">{remat ? 'Rematrícula 2027' : 'Matrícula 2027'}</span></div><h2>{heading}</h2><p>Você pode fechar esta página e continuar depois pelo mesmo link: ela abre na etapa em que você parou.</p></div>;
}

function ExistingFamilyMatch({ match, busy, onStartRematricula, onContinueNewEnrollment }) {
  if (!match?.found) return null;
  const children = match.children || [];
  return <div className="onboarding-existing-family-modal" role="dialog" aria-modal="true" aria-labelledby="existing-family-title">
    <div className="onboarding-existing-family-modal__backdrop" />
    <section className="onboarding-existing-family">
      <span className="onboarding-existing-family__eyebrow">Cadastro localizado</span>
      <h3 id="existing-family-title">{match.guardian?.name}, este é o seu nome?</h3>
      <p>Encontramos este responsável usando o CPF ou WhatsApp informado.</p>
      {children.length ? <div className="onboarding-existing-family__children"><strong>Estes alunos estão vinculados a este cadastro:</strong>{children.map((child) => <div key={`${child.name}-${child.current_grade || ''}`}><span>{child.name}</span><small>{child.current_grade ? `${child.current_grade} → ${child.target_grade || 'série a confirmar'}` : 'Série a confirmar'}</small></div>)}</div> : null}
      <p className="onboarding-existing-family__question">{children.length ? 'Você deseja fazer a rematrícula de algum deles?' : 'Quer usar este cadastro para uma rematrícula?'}</p>
      <div className="onboarding-existing-family__actions">
        <button type="button" className="btn btn--primary" onClick={onStartRematricula} disabled={busy}>{busy ? 'Abrindo rematrícula…' : 'Sim, quero fazer rematrícula'}</button>
        <button type="button" className="btn" onClick={onContinueNewEnrollment} disabled={busy}>Não, quero matricular outro filho</button>
      </div>
    </section>
  </div>;
}

export default function EnrollmentOnboarding({ initialFlow = null }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // Com só ?j= na URL (ex.: depois de um F5), a própria jornada diz se é
  // matrícula nova ou rematrícula.
  const [flow, setFlow] = useState(initialFlow || params.get('f') || (params.get('j') ? 'auto' : null));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(Boolean(initialFlow));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [lookup, setLookup] = useState({ cpf: '', fullName: '', phone: '' });
  const [family, setFamily] = useState(newFamily);
  const [touched, setTouched] = useState({});
  const [triedSubmit, setTriedSubmit] = useState(false);
  const [existingFamily, setExistingFamily] = useState(null);
  const [existingFamilyLoading, setExistingFamilyLoading] = useState(false);
  const [selected, setSelected] = useState([]);
  const [email, setEmail] = useState('');
  const [offerings, setOfferings] = useState([]);
  const [view, setView] = useState(null); // volta a uma etapa já feita: 'alunos' | 'condicoes' | 'cobranca'
  const [newChild, setNewChild] = useState(null);
  const token = params.get('j');

  const gradeOptions = useMemo(() => offerings.map((item) => ({ value: item.grade_id, label: `${item.grades?.name || 'Série'} · ${money(item.amount_cents)}` })), [offerings]);

  useEffect(() => { getPublicOfferings().then((result) => setOfferings(result.offerings || [])).catch(() => {}); }, []);
  useEffect(() => {
    if (!flow) return undefined;
    let current = true;
    setLoading(true); setError('');
    const request = token ? openEnrollmentOnboarding(token) : startEnrollmentOnboarding(flow);
    request.then((result) => {
      if (!current) return;
      if (flow === 'auto' && result?.flow) setFlow(result.flow);
      if (!token && result?.token) setParams({ j: result.token, f: flow }, { replace: true });
      apply(result);
    }).catch((reason) => current && setError(reason.message || 'Não foi possível abrir esta jornada.')).finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [flow, token, setParams]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const cpf = family.cpf.replace(/\D/g, '');
    const phone = family.phone.replace(/\D/g, '');
    if (flow !== 'matricula_nova' || !token || (cpf.length !== 11 && phone.length < 10)) {
      setExistingFamily(null);
      setExistingFamilyLoading(false);
      return undefined;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      setExistingFamilyLoading(true);
      lookupExistingFamilyForNewEnrollment(token, family)
        .then((result) => current && setExistingFamily(result?.found ? result : null))
        .catch(() => current && setExistingFamily(null))
        .finally(() => current && setExistingFamilyLoading(false));
    }, 500);
    return () => { current = false; window.clearTimeout(timer); };
  }, [flow, token, family.cpf, family.phone]);

  function apply(next) {
    setData(next); setError(''); setView(null);
    if (next?.guardian?.email) setEmail((current) => current || next.guardian.email);
    if (next?.children) setSelected(next.children.filter((item) => item.selected && item.eligible !== false).map((item) => item.student_id));
  }
  async function run(action, fallbackMessage) {
    setBusy(true); setNotice('');
    try { await action(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    catch (reason) { setNotice(reason.message || fallbackMessage); }
    finally { setBusy(false); }
  }
  function chooseFlow(nextFlow) {
    setFlow(nextFlow);
    setParams({}, { replace: true });
  }
  const identify = (event) => { event.preventDefault(); run(async () => apply(await identifyRematriculaOnboarding(token, lookup)), 'Não foi possível localizar a família.'); };
  const confirmChildren = (event) => { event.preventDefault(); run(async () => apply(await selectRematriculaChildren(token, selected)), 'Não foi possível salvar os alunos selecionados.'); };
  const confirmPlan = (installments) => run(async () => apply(await chooseOnboardingPlan(token, installments)), 'Não foi possível salvar a condição de pagamento.');
  async function saveNewFamily(event) {
    event.preventDefault();
    setTriedSubmit(true);
    const errors = newFamilyErrors(family);
    if (errors.cpf || errors.rg || errors.phone || errors.email || errors.address || errors.children.some(Boolean)) {
      setNotice('Confira os campos destacados antes de continuar.');
      return;
    }
    run(async () => {
      await createMatriculaOnboarding(token, family);
      await setGuardianRg(token, family.rg);
      apply(await openEnrollmentOnboarding(token));
    }, 'Não foi possível salvar a matrícula.');
  }
  async function startMatchedRematricula() {
    run(async () => {
      const result = await startRematriculaFromNewEnrollment(token, family);
      navigate(`/rematricula?j=${encodeURIComponent(result.token)}&f=rematricula`);
    }, 'Não foi possível abrir a rematrícula desta família.');
  }
  function continueWithNewChild() {
    setFamily((current) => ({
      ...current,
      cpf: formatCpf(existingFamily?.guardian?.cpf || current.cpf),
      fullName: existingFamily?.guardian?.name || current.fullName,
      phone: formatPhoneBr(existingFamily?.guardian?.phone || current.phone),
      email: existingFamily?.guardian?.email || current.email,
      address: existingFamily?.guardian?.address || current.address
    }));
    setExistingFamily(null);
  }
  function updateNewFamily(field, value) {
    setFamily((current) => ({ ...current, [field]: value }));
    if (field === 'cpf' || field === 'phone') setExistingFamily(null);
  }
  function sign(sharedToken) {
    if (sharedToken) { navigate(`/contrato/${sharedToken}?j=${encodeURIComponent(token)}&f=${flow}`); return; }
    run(async () => {
      const result = await prepareFamilyContract(token, email || data.guardian?.email);
      navigate(`${result.url}?j=${encodeURIComponent(token)}&f=${encodeURIComponent(flow)}`);
    }, 'Não foi possível preparar o contrato.');
  }
  // Escolhida a forma, a cobrança sai na hora no Asaas (asaas-checkout) e os
  // botões de pagar aparecem na etapa Pagamento.
  async function generateCheckout() {
    try { await createAsaasCheckout(token); }
    catch (reason) { setNotice(reason.message || 'Não foi possível gerar a cobrança agora. Tente de novo em instantes.'); }
    apply(await openEnrollmentOnboarding(token));
  }
  const confirmBilling = (method) => run(async () => { await chooseOnboardingBilling(token, method); await generateCheckout(); }, 'Não foi possível gerar o pagamento.');
  const retryCheckout = () => run(generateCheckout, 'Não foi possível gerar o pagamento.');
  async function addChild(event) {
    event.preventDefault();
    if (!newChild?.name?.trim() || !newChild?.gradeId) { setNotice('Informe o nome completo e a série do novo aluno.'); return; }
    run(async () => {
      const result = await addRematriculaChild(token, newChild);
      const keep = selected;
      apply(result);
      setSelected([...keep, result.added_student_id]);
      setView('alunos');
      setNewChild(null);
    }, 'Não foi possível adicionar o aluno.');
  }
  const removeChild = (studentId) => run(async () => {
    const keep = selected.filter((id) => id !== studentId);
    apply(await removeAddedChild(token, studentId));
    setSelected(keep);
    setView('alunos');
  }, 'Não foi possível remover o aluno.');
  function updateChild(index, key, value) {
    setFamily((current) => ({ ...current, children: current.children.map((child, childIndex) => childIndex === index ? { ...child, [key]: value } : child) }));
  }
  function updateBirthDate(index, parts, iso) {
    setFamily((current) => ({ ...current, children: current.children.map((child, childIndex) => childIndex === index ? { ...child, birthParts: parts, birthDate: iso } : child) }));
  }
  function removeFamilyChild(index) { setFamily((current) => ({ ...current, children: current.children.filter((_, childIndex) => childIndex !== index) })); }

  if (!flow) return <main className="onboarding-page"><section className="onboarding-shell"><div className="onboarding-choice"><img className="onboarding-choice-logo" src={cecLogo} alt="Centro Educacional Cristão" /><span>CEC · 2027</span><h1>Como podemos ajudar?</h1><p>Escolha a jornada para começar. Você receberá um link seguro para continuar de onde parou.</p><div className="onboarding-choice-actions"><button type="button" className="cta" onClick={() => chooseFlow('matricula_nova')}>Quero fazer uma matrícula nova</button><button type="button" className="btn" onClick={() => chooseFlow('rematricula')}>Quero fazer uma rematrícula</button></div></div></section></main>;

  const remat = flow === 'rematricula';
  const stage = view || data?.stage || (remat ? 'identificacao' : 'dados');
  const selectedChildren = (data?.children || []).filter((child) => child.selected);
  const eligibleChildren = (data?.children || []).filter((child) => child.eligible !== false);
  const selectedEligible = selected.filter((studentId) => eligibleChildren.some((child) => child.student_id === studentId));
  const pendingCount = selectedChildren.filter((child) => !child.signed_at).length;
  const anySigned = selectedChildren.some((child) => child.signed_at);
  const chargesGenerated = (data?.charges || []).some((item) => item.payment_url);

  return <DataState loading={loading} error={error} empty={false}>{data ? <main className="onboarding-page"><section className="public onboarding-shell"><Title flow={flow} stage={stage} multi={pendingCount > 1} />{stage !== 'identificacao' ? <Stepper flow={flow} stage={stage} /> : null}<div className="public-body onboarding-body">
    {stage === 'identificacao' ? <form onSubmit={identify} className="onboarding-form"><p className="meta">Para proteger os dados da família, confirmamos CPF e WhatsApp antes de apresentar os alunos vinculados.</p><div className="grid grid--2"><Field label="CPF do responsável" ph="000.000.000-00" value={lookup.cpf} onChange={(value) => setLookup((v) => ({ ...v, cpf: formatCpf(value) }))} inputMode="numeric" maxLength={14} required /><Field label="WhatsApp" ph="(33) 9 9999-9999" value={lookup.phone} onChange={(value) => setLookup((v) => ({ ...v, phone: formatPhoneBr(value) }))} inputMode="tel" maxLength={16} required /><Field label="Nome completo" ph="Opcional, para confirmar" value={lookup.fullName} onChange={(value) => setLookup((v) => ({ ...v, fullName: value }))} /></div><button className="cta" disabled={busy}>{busy ? 'Localizando…' : 'Continuar →'}</button></form> : null}

    {stage === 'dados' ? (() => {
      const errors = newFamilyErrors(family);
      const show = (field) => triedSubmit || touched[field];
      const touch = (field) => () => setTouched((current) => ({ ...current, [field]: true }));
      return <form onSubmit={saveNewFamily} className="onboarding-form" noValidate><div className="grid grid--2">
        <div onBlur={touch('cpf')}><Field label="CPF do responsável" ph="000.000.000-00" value={family.cpf} onChange={(value) => updateNewFamily('cpf', formatCpf(value))} inputMode="numeric" maxLength={14} required /><FieldError show={show('cpf') || family.cpf.length === 14} message={errors.cpf} /></div>
        <Field label="Nome completo do responsável" value={family.fullName} onChange={(value) => updateNewFamily('fullName', value)} required />
        <div onBlur={touch('rg')}><Field label="RG do responsável" ph="Ex.: MG-12.345.678" value={family.rg} onChange={(value) => updateNewFamily('rg', value)} required /><FieldError show={show('rg')} message={errors.rg} /></div>
        <div onBlur={touch('phone')}><Field label="WhatsApp" ph="(33) 9 9999-9999" value={family.phone} onChange={(value) => updateNewFamily('phone', formatPhoneBr(value))} inputMode="tel" maxLength={16} required /><FieldError show={show('phone')} message={errors.phone} /></div>
        <div onBlur={touch('email')}><Field label="E-mail" type="email" ph="nome@gmail.com" value={family.email} onChange={(value) => updateNewFamily('email', value.trim())} inputMode="email" required /><FieldError show={show('email')} message={errors.email} /></div>
      </div>
      <div className="onboarding-address" onBlur={touch('address')}><h3>Endereço do responsável</h3><AddressFields key={existingFamily ? 'existente' : 'novo'} value={family.address} onChange={(value) => updateNewFamily('address', value)} /><FieldError show={show('address')} message={errors.address} /></div>{existingFamilyLoading ? <span className="meta">Verificando se já existe um cadastro com estes dados…</span> : null}<ExistingFamilyMatch match={existingFamily} busy={busy} onStartRematricula={startMatchedRematricula} onContinueNewEnrollment={continueWithNewChild} /><div className="onboarding-child-editor"><div><h3>Alunos</h3><p>Inclua todos os filhos que deseja matricular agora.</p></div>{family.children.map((child, index) => <div className="onboarding-child-fields" key={index}>
        <Field label="Nome completo do aluno" value={child.name} onChange={(value) => updateChild(index, 'name', value)} required />
        <Field label="Série pretendida" type="select" options={gradeOptions} value={child.gradeId} onChange={(value) => updateChild(index, 'gradeId', value)} required />
        <div onBlur={touch(`birth${index}`)}><BirthDateSelect parts={child.birthParts} onChange={(parts, iso) => updateBirthDate(index, parts, iso)} /><FieldError show={show(`birth${index}`)} message={errors.children[index]} /></div>
        <Field label="Escola anterior (opcional)" ph="Se o aluno já estudou em outra escola" value={child.previousSchool} onChange={(value) => updateChild(index, 'previousSchool', value)} />
        {family.children.length > 1 ? <button type="button" className="text-link" onClick={() => removeFamilyChild(index)}>Remover aluno</button> : null}</div>)}<button type="button" className="btn" onClick={() => setFamily((v) => ({ ...v, children: [...v.children, { ...emptyChild }] }))}>+ Adicionar outro filho</button></div><button className="cta" disabled={busy}>{busy ? 'Salvando…' : 'Continuar →'}</button></form>;
    })() : null}

    {stage === 'alunos' ? <form onSubmit={confirmChildren} className="onboarding-form"><div className="onboarding-guardian"><strong>{data.guardian?.name}</strong><span>Marque quem vai continuar no CEC em 2027. Você também pode incluir um filho que ainda não estuda aqui.</span></div>
      <div className="onboarding-children">{data.children?.map((child) => <div className={`onboarding-child-card${selected.includes(child.student_id) ? ' is-selected' : ''}${child.eligible === false ? ' is-unavailable' : ''}`} key={child.student_id}><label className="onboarding-child-card__check"><input type="checkbox" disabled={child.eligible === false || Boolean(child.signed_at)} checked={selected.includes(child.student_id)} onChange={(event) => setSelected((items) => event.target.checked ? [...items, child.student_id] : items.filter((id) => id !== child.student_id))} /><span><strong>{child.name}{child.is_new ? <em className="badge">Novo</em> : null}</strong><small>{child.current_grade ? `${child.current_grade} → ` : ''}{child.target_grade || 'Série a confirmar'}{child.amount_cents ? ` · ${money(child.amount_cents)}` : ''}</small>{child.eligible === false ? <small>{child.eligibility_reason}</small> : null}</span></label>{child.is_new && !child.signed_at ? <button type="button" className="text-link" onClick={() => removeChild(child.student_id)} disabled={busy}>Remover</button> : null}</div>)}</div>
      {newChild ? <div className="onboarding-child-fields onboarding-new-child">
        <Field label="Nome completo do aluno" value={newChild.name} onChange={(value) => setNewChild((v) => ({ ...v, name: value }))} required />
        <Field label="Série pretendida" type="select" options={gradeOptions} value={newChild.gradeId} onChange={(value) => setNewChild((v) => ({ ...v, gradeId: value }))} required />
        <BirthDateSelect parts={newChild.birthParts} onChange={(parts, iso) => setNewChild((v) => ({ ...v, birthParts: parts, birthDate: iso }))} />
        <Field label="Escola anterior (opcional)" value={newChild.previousSchool} onChange={(value) => setNewChild((v) => ({ ...v, previousSchool: value }))} />
        <div className="onboarding-new-child__actions"><button type="button" className="btn btn--primary" onClick={addChild} disabled={busy}>Adicionar</button><button type="button" className="text-link" onClick={() => setNewChild(null)}>Cancelar</button></div>
      </div> : <button type="button" className="btn" onClick={() => setNewChild({ ...emptyChild })}>+ Adicionar outro filho</button>}
      <button className="cta" disabled={busy || !selectedEligible.length}>{busy ? 'Salvando…' : 'Confirmar alunos →'}</button></form> : null}

    {stage === 'condicoes' ? <ConditionsStep key={data.plan_choice?.installments || 'novo'} data={data} busy={busy} onConfirm={confirmPlan} onEditChildren={remat && !anySigned ? () => setView('alunos') : null} /> : null}
    {stage === 'assinatura' ? <SignStep data={data} busy={busy} email={email} onEmail={setEmail} onSign={sign} onEditPlan={() => setView('condicoes')} field={Field} /> : null}
    {stage === 'cobranca' ? <BillingStep data={data} busy={busy} onConfirm={confirmBilling} /> : null}
    {stage === 'pagamento' ? <PaymentStep data={data} busy={busy} onRetry={retryCheckout} onChangeMethod={chargesGenerated ? null : () => setView('cobranca')} /> : null}
    {stage === 'concluida' ? <DoneStep data={data} /> : null}
    {notice ? <div className="notice"><span>{notice}</span></div> : null}
  </div></section></main> : null}</DataState>;
}
