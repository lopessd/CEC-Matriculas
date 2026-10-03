import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import DataState from '../components/DataState';
import AddressFields from '../components/AddressFields';
import { Field, LogoBlocks } from '../components/ui';
import { useAsyncData } from '../hooks/useAsyncData';
import { formatCpf, formatPhoneBr, maskEmail, money } from '../lib/format';
import { completeContractRequiredData, contractPdfUrl, contractResumeJourney, dispatchPendingContractEmail, generateContractPdf, downloadFiles, openContract, openEnrollmentOnboarding, prepareFamilyContract, sendContractCode, signContract, verifyContractCode } from '../services/data';

function shiftLabel(shift) {
  return ({ manha: 'Matutino', tarde: 'Vespertino', integral: 'Integral' })[shift] || 'Turno da turma';
}

// O Chrome do Android não mostra PDF dentro de iframe (só um botão "Abrir"),
// então as páginas são desenhadas em canvas pelo pdf.js, igual em qualquer aparelho.
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

function PdfPages({ url, title }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !url) return undefined;
    let cancelled = false;
    let task = null;
    setStatus('loading');
    container.replaceChildren();
    (async () => {
      const pdfjs = await loadPdfjs();
      if (cancelled) return;
      task = pdfjs.getDocument({ url });
      const pdf = await task.promise;
      // Renderiza com folga de resolução para continuar nítido no zoom de pinça.
      const cssWidth = container.clientWidth || 600;
      const ratio = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
      for (let number = 1; number <= pdf.numPages; number += 1) {
        if (cancelled) return;
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (cssWidth / base.width) * ratio });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.className = 'contract-pdf__page';
        canvas.setAttribute('aria-label', `${title} — página ${number} de ${pdf.numPages}`);
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        if (number === 1 && !cancelled) setStatus('ready');
      }
    })().catch((error) => {
      if (!cancelled) { console.error(error); setStatus('error'); }
    });
    return () => { cancelled = true; task?.destroy(); };
  }, [url, title]);

  return <div className="contract-pdf" role="document" aria-label={title} aria-busy={status === 'loading'}>
    {status === 'loading' && <div className="contract-pdf__status">Carregando o contrato…</div>}
    {status === 'error' && <div className="contract-pdf__status">Não foi possível mostrar o contrato aqui. Use o botão “Abrir com zoom”.</div>}
    <div ref={containerRef} className="contract-pdf__pages" />
  </div>;
}

function ContractPdfPanel({ token, enrollment }) {
  const pdfUrl = contractPdfUrl(token, enrollment.id);
  return <article className="contract-pdf-panel">
    <header className="contract-pdf-panel__head">
      <div><strong>Contrato de {enrollment.student_name}</strong><span>Deslize para ler todas as páginas e use o gesto de pinça para ampliar.</span></div>
      <a className="btn" href={pdfUrl} target="_blank" rel="noreferrer">Abrir com zoom</a>
    </header>
    <PdfPages url={pdfUrl} title={`Contrato em PDF — ${enrollment.student_name}`} />
  </article>;
}

function SignaturePad({ onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 2.5;
    context.strokeStyle = '#142D4C';
    return undefined;
  }, []);

  function point(event) {
    const canvas = canvasRef.current;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
      y: (event.clientY - bounds.top) * (canvas.height / bounds.height)
    };
  }

  function begin(event) {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    const position = point(event);
    drawing.current = true;
    canvas.setPointerCapture?.(event.pointerId);
    context.beginPath();
    context.moveTo(position.x, position.y);
  }

  function draw(event) {
    if (!drawing.current) return;
    const context = canvasRef.current.getContext('2d');
    const position = point(event);
    context.lineTo(position.x, position.y);
    context.stroke();
    setHasSignature(true);
    onChange(canvasRef.current.toDataURL('image/png'));
  }

  function end(event) {
    drawing.current = false;
    canvasRef.current?.releasePointerCapture?.(event.pointerId);
  }

  function clear() {
    const canvas = canvasRef.current;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
    onChange('');
  }

  return <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', overflow: 'hidden', background: '#fff' }}>
    <canvas ref={canvasRef} width="760" height="210" aria-label="Área para desenhar a assinatura" style={{ display: 'block', width: '100%', height: 180, touchAction: 'none', cursor: 'crosshair' }} onPointerDown={begin} onPointerMove={draw} onPointerUp={end} onPointerCancel={end} />
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}><span className="meta">Desenhe sua assinatura com o dedo, mouse ou caneta.</span><button type="button" className="btn" onClick={clear} disabled={!hasSignature}>Limpar</button></div>
  </div>;
}

function ContractDataModal({ data, onClose, onSubmit, busy, error }) {
  const guardianValues = data?.guardian?.values || {};
  const [guardian, setGuardian] = useState(() => ({
    full_name: guardianValues.full_name || '', phone: formatPhoneBr(guardianValues.phone), rg: guardianValues.rg || '',
    cpf: formatCpf(guardianValues.cpf), address: guardianValues.address || '', email: guardianValues.email || ''
  }));
  const [students, setStudents] = useState(() => Object.fromEntries((data?.students || []).map((student) => [student.enrollment_id, {
    student_name: student.values?.student_name || student.student_name || '',
    target_grade_id: student.values?.target_grade_id || '', target_shift: student.values?.target_shift || ''
  }])));

  function setGuardianField(field, value) {
    setGuardian((current) => ({ ...current, [field]: value }));
  }

  function setStudentField(enrollmentId, field, value) {
    setStudents((current) => ({ ...current, [enrollmentId]: { ...(current[enrollmentId] || {}), [field]: value } }));
  }

  return <div className="contract-data-modal" role="dialog" aria-modal="true" aria-labelledby="contract-data-title">
    <div className="contract-data-modal__backdrop" />
    <form className="contract-data-modal__card" onSubmit={(event) => { event.preventDefault(); onSubmit(guardian, students); }}>
      <div className="contract-data-modal__head">
        <div><span>Antes de gerar o contrato</span><h2 id="contract-data-title">Revise os dados do contrato</h2><p>Se precisar, faça os ajustes nesta etapa. Ao salvar, uma nova versão do PDF será gerada.</p></div>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Agora não</button>
      </div>
      <div className="contract-data-modal__body">
        <section className="contract-data-modal__section"><h3>Responsável financeiro</h3><div className="contract-data-modal__grid">
          <label>Nome completo<input className="control" required value={guardian.full_name} onChange={(event) => setGuardianField('full_name', event.target.value)} /></label>
          <label>Contato / WhatsApp<input className="control" required inputMode="tel" maxLength="16" value={guardian.phone} onChange={(event) => setGuardianField('phone', formatPhoneBr(event.target.value))} placeholder="(33) 9 9126-9004" /></label>
          <label>RG<input className="control" required value={guardian.rg} onChange={(event) => setGuardianField('rg', event.target.value)} /></label>
          <label>CPF<input className="control" required inputMode="numeric" maxLength="14" value={guardian.cpf} onChange={(event) => setGuardianField('cpf', formatCpf(event.target.value))} placeholder="000.000.000-00" /></label>
          <label className="contract-data-modal__full">E-mail para confirmação<input className="control" required type="email" value={guardian.email} onChange={(event) => setGuardianField('email', event.target.value)} placeholder="voce@exemplo.com" /></label>
          <div className="contract-data-modal__full"><AddressFields value={guardian.address} onChange={(value) => setGuardianField('address', value || guardianValues.address || '')} /></div>
        </div></section>
        {(data?.students || []).map((student) => {
          const values = students[student.enrollment_id] || {};
          const grades = student.available_grades || [];
          const selectedGrade = grades.find((grade) => grade.id === values.target_grade_id);
          const automaticShift = selectedGrade?.shifts?.length === 1 ? selectedGrade.shifts[0] : (values.target_shift || '');
          return <section className="contract-data-modal__section" key={student.enrollment_id}><h3>{student.student_name || 'Aluno'}</h3><p>{student.grade || 'Série a confirmar'}</p><div className="contract-data-modal__grid">
            <label className="contract-data-modal__full">Nome completo do aluno<input className="control" required value={values.student_name || ''} onChange={(event) => setStudentField(student.enrollment_id, 'student_name', event.target.value)} /></label>
            <label>Série para 2027<select className="control" required value={values.target_grade_id || ''} onChange={(event) => {
              setStudents((current) => ({ ...current, [student.enrollment_id]: { ...values, target_grade_id: event.target.value } }));
            }}><option value="">Selecione</option>{grades.map((grade) => <option key={grade.id} value={grade.id}>{grade.name}</option>)}</select></label>
            <div className="contract-data-modal__readonly"><span>Turno da turma</span><strong>{automaticShift ? shiftLabel(automaticShift) : 'A escola precisa configurar a turma'}</strong><small>Definido automaticamente pela série.</small></div>
          </div></section>;
        })}
      </div>
      <div className="contract-data-modal__actions"><div><span>O PDF individual será gerado depois que você salvar os dados.</span>{error ? <p className="contract-data-modal__error" role="alert">{error}</p> : null}</div><button className="btn btn--primary" disabled={busy}>{busy ? 'Gerando contrato…' : 'Salvar dados e gerar contrato'}</button></div>
    </form>
  </div>;
}

export default function ContractSignature() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const contract = useAsyncData(() => openContract(token), [token]);
  const generatedFor = useRef('');
  const dispatchedEmailFor = useRef('');
  const [code, setCode] = useState('');
  const [signerName, setSignerName] = useState('');
  const [signatureImage, setSignatureImage] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [verified, setVerified] = useState(false);
  const [resendIn, setResendIn] = useState(60);
  const [codeSent, setCodeSent] = useState(false);
  const [showDataModal, setShowDataModal] = useState(false);
  const [dataSaveError, setDataSaveError] = useState('');
  const [pendingSiblings, setPendingSiblings] = useState([]);
  const journeyToken = searchParams.get('j');

  // Contrato aberto com só uma parte da família: oferece juntar os irmãos que
  // ainda estão pendentes na mesma jornada num contrato conjunto.
  useEffect(() => {
    const ids = (contract.data?.enrollments || []).map((item) => item.id);
    if (!journeyToken || !ids.length || contract.data?.status === 'assinada') { setPendingSiblings([]); return undefined; }
    let current = true;
    openEnrollmentOnboarding(journeyToken)
      .then((journey) => current && setPendingSiblings((journey?.children || []).filter((child) => child.selected && child.enrollment_id && child.contract_status !== 'assinada' && !ids.includes(child.enrollment_id))))
      .catch(() => current && setPendingSiblings([]));
    return () => { current = false; };
  }, [journeyToken, contract.data?.status, contract.data?.enrollments]);

  async function joinSiblings() {
    setBusy('join'); setMessage('');
    try {
      const result = await prepareFamilyContract(journeyToken, contract.data?.required_data?.guardian?.values?.email);
      navigate(`${result.url}?j=${encodeURIComponent(journeyToken)}&f=${searchParams.get('f') || 'rematricula'}`, { replace: true });
    } catch (error) { setMessage(error.message || 'Não foi possível juntar os contratos.'); }
    finally { setBusy(''); }
  }

  useEffect(() => {
    if (contract.data?.guardian?.name && !signerName) setSignerName(contract.data.guardian.name);
    setVerified(Boolean(contract.data?.email_verified));
    setCodeSent(contract.data?.status === 'codigo_enviado' || contract.data?.status === 'verificada');
    if (contract.data?.status === 'pronta') setResendIn(0);
  }, [contract.data, signerName]);

  useEffect(() => {
    if (contract.data?.required_data && !contract.data.required_data.ready) {
      setDataSaveError('');
      setShowDataModal(true);
    }
  }, [contract.data?.required_data]);

  useEffect(() => {
    const ready = contract.data?.required_data?.ready;
    // Uma vez por abertura: gera o que falta e refaz rascunhos de um modelo
    // antigo; o servidor não mexe no que já está no modelo atual.
    if (!ready || contract.data?.status === 'assinada' || generatedFor.current === token) return;
    generatedFor.current = token;
    const generated = contract.data?.enrollments?.every((item) => item.contract_generated);
    if (!generated) setBusy('generate');
    generateContractPdf(token, { onlyIfOutdated: true })
      .then(() => contract.refresh())
      .catch((error) => setMessage(error.message || 'Não foi possível gerar o PDF individual.'))
      .finally(() => setBusy(''));
  }, [contract.data, contract.refresh, token]);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = window.setInterval(() => setResendIn((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  useEffect(() => {
    if (!codeSent || !['pendente', 'processando'].includes(contract.data?.email_delivery_status)) return undefined;
    const timer = window.setInterval(() => contract.refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [codeSent, contract.data?.email_delivery_status]);

  useEffect(() => {
    if (!codeSent || contract.data?.email_delivery_status !== 'pendente' || dispatchedEmailFor.current === token) return;
    dispatchedEmailFor.current = token;
    dispatchPendingContractEmail(token)
      .catch((error) => setMessage(error.message || 'Não foi possível enviar o código por e-mail.'))
      .finally(() => contract.refresh());
  }, [codeSent, contract.data?.email_delivery_status, contract.refresh, token]);

  async function resendCode() {
    setBusy('code'); setMessage('');
    try {
      await sendContractCode(token);
      setResendIn(60);
      setCodeSent(true);
      setMessage('Código solicitado. Aguarde a confirmação de envio para informar os seis caracteres.');
      await contract.refresh();
    } catch (error) { setMessage(error.message || 'Não foi possível solicitar o código.'); }
    finally { setBusy(''); }
  }

  async function confirmCode(event) {
    event.preventDefault(); setBusy('verify'); setMessage('');
    try {
      await verifyContractCode(token, code);
      setVerified(true);
      setMessage('E-mail confirmado. Agora você pode assinar o contrato.');
      await contract.refresh();
    } catch (error) { setMessage(error.message || 'Não foi possível confirmar o código.'); }
    finally { setBusy(''); }
  }

  async function submitSignature(event) {
    event.preventDefault(); setBusy('sign'); setMessage('');
    try {
      await signContract(token, { signerName, signatureImage, accepted });
      setMessage('Contrato assinado com sucesso. As parcelas foram geradas para envio pela escola.');
      await contract.refresh();
    } catch (error) { setMessage(error.message || 'Não foi possível concluir a assinatura.'); }
    finally { setBusy(''); }
  }

  async function submitRequiredData(guardian, students) {
    setBusy('required'); setMessage(''); setDataSaveError('');
    try {
      await completeContractRequiredData(token, guardian, students);
      await generateContractPdf(token);
      setShowDataModal(false);
      setMessage('Dados salvos e contrato individual gerado. Agora você pode solicitar o código de confirmação.');
      await contract.refresh();
    } catch (error) {
      const detail = error.message || 'Não foi possível salvar os dados do contrato.';
      setDataSaveError(detail);
      setMessage(detail);
    }
    finally { setBusy(''); }
  }

  const data = contract.data;
  const signed = data?.status === 'assinada';
  const dataReady = Boolean(data?.required_data?.ready);
  const confirmationEmail = maskEmail(data?.required_data?.guardian?.values?.email || data?.email_masked);
  const contractsGenerated = Boolean(data?.enrollments?.length) && data.enrollments.every((item) => item.contract_generated);
  const emailDeliveryStatus = data?.email_delivery_status;
  const codeAvailable = codeSent && emailDeliveryStatus === 'enviado';
  const emailPending = codeSent && ['pendente', 'processando'].includes(emailDeliveryStatus);
  const emailFailed = codeSent && emailDeliveryStatus === 'falhou';
  const readyToSign = Boolean(signatureImage) && signerName.trim().length >= 3 && accepted;
  const multiple = (data?.enrollments?.length || 0) > 1;
  const familyTotal = (data?.enrollments || []).reduce((sum, item) => sum + (Number(item.amount_cents) || 0), 0);
  const resumeToken = searchParams.get('j');
  const resumeFlow = searchParams.get('f') === 'matricula_nova' ? 'matricula_nova' : 'rematricula';
  const resumePath = resumeFlow === 'matricula_nova' ? '/matricula' : '/rematricula';
  // Link vindo do painel não tem jornada na URL: o banco acha (ou cria) a da família.
  async function goToPayment() {
    if (resumeToken) { navigate(`${resumePath}?j=${encodeURIComponent(resumeToken)}&f=${resumeFlow}`); return; }
    setBusy('payment'); setMessage('');
    try {
      const journey = await contractResumeJourney(token);
      navigate(`${journey.flow === 'matricula_nova' ? '/matricula' : '/rematricula'}?j=${encodeURIComponent(journey.token)}&f=${journey.flow}`);
    } catch (reason) {
      setMessage(reason.message || 'Não foi possível abrir o pagamento agora. Tente de novo em instantes.');
      setBusy('');
    }
  }
  return <DataState loading={contract.loading} error={contract.error} empty={!contract.loading && !contract.error && !data}>{data ? <main className="auth-page" style={{ padding: '32px 18px' }}><section className="public public--single" style={{ width: 'min(860px, 100%)' }}>
    <div className="public-head--navy"><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><LogoBlocks /><span className="public-kicker">Contrato digital</span></div><h2>{multiple ? `Assinatura dos ${data.enrollments.length} contratos` : 'Assinatura de matrícula'}</h2><p>{multiple ? 'Confira os dados, leia cada contrato e assine uma vez só: sua assinatura vale para todos os alunos abaixo.' : 'Confira os dados, leia o documento preenchido e assine para concluir esta etapa.'}</p></div>
    <div className="public-body">
      <div className="notice notice--soft"><span>Responsável: <strong>{data.guardian?.name}</strong> · e-mail de confirmação: {confirmationEmail}</span>{!signed ? <button type="button" className="btn" onClick={() => { setDataSaveError(''); setShowDataModal(true); }}>{dataReady ? 'Revisar e editar dados' : 'Completar dados'}</button> : null}</div>
      {pendingSiblings.length && !signed ? <div className="family-sign family-sign--join"><div className="family-sign__head"><strong>{pendingSiblings.map((child) => child.name.split(' ')[0]).join(', ')} também {pendingSiblings.length > 1 ? 'estão pendentes' : 'está pendente'}</strong><span>Quer assinar os {pendingSiblings.length + (data.enrollments?.length || 1)} contratos juntos? Um código no e-mail e uma assinatura só, com todos os PDFs nesta página.</span></div><button type="button" className="cta" onClick={joinSiblings} disabled={busy === 'join'}>{busy === 'join' ? 'Juntando contratos…' : `Assinar os ${pendingSiblings.length + (data.enrollments?.length || 1)} contratos juntos →`}</button></div> : null}
      <div><h3 style={{ fontSize: 16, marginBottom: 10 }}>{multiple ? 'Alunos' : 'Aluno'}</h3><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{data.enrollments?.map((item) => <div className="row-item" style={{ background: 'var(--surface)' }} key={item.id}><div className="who"><strong>{item.student_name}</strong><span>{item.grade}{item.shift ? ` · ${shiftLabel(item.shift)}` : ''}</span></div><strong>{money(item.amount_cents)}</strong></div>)}{multiple ? <div className="contract-total"><span>Total da família · {data.enrollments.length} contratos</span><strong>{money(familyTotal)}</strong></div> : null}</div></div>
      {signed ? <div className="contract-signed"><div className="contract-signed__head"><strong>{multiple ? 'Contratos assinados ✓' : 'Contrato assinado ✓'}</strong><span>Sua assinatura foi registrada com segurança. Guarde uma cópia {multiple ? 'de cada contrato' : 'do contrato'}.</span></div><div className="contract-signed__actions"><button type="button" className="btn btn--primary" onClick={() => downloadFiles((data.enrollments || []).map((item) => contractPdfUrl(token, item.id, { download: true })))}>⬇ Baixar {multiple ? `os ${data.enrollments.length} contratos` : 'contrato'}</button><button type="button" className="cta" onClick={goToPayment} disabled={busy === 'payment'}>{busy === 'payment' ? 'Abrindo o pagamento…' : 'Ir para o pagamento →'}</button></div>{message && !message.includes('sucesso') ? <div className="notice"><span>{message}</span></div> : null}</div> : contractsGenerated ? <>{!verified ? <form className="contract-confirmation" onSubmit={codeAvailable ? confirmCode : (event) => { event.preventDefault(); if (!emailPending) resendCode(); }}><div className="contract-confirmation__head"><span className={`contract-confirmation__status${codeAvailable ? ' is-sent' : emailFailed ? ' is-failed' : ''}`}>{codeAvailable ? 'Código entregue' : emailFailed ? 'Falha no envio' : emailPending ? 'Aguardando envio' : 'Confirmação por e-mail'}</span><h3>{codeAvailable ? 'Confirme seu e-mail' : emailFailed ? 'Não foi possível entregar o código' : emailPending ? 'Seu código está na fila de envio' : 'Pronto para assinar?'}</h3><p>{codeAvailable ? `Digite os seis caracteres enviados para ${confirmationEmail}.` : emailFailed ? `O envio para ${confirmationEmail} falhou. Você poderá solicitar um novo código.` : emailPending ? `O código foi solicitado para ${confirmationEmail}. Esta página atualizará automaticamente assim que ele for enviado.` : `Ao continuar, solicitaremos um código de confirmação para ${confirmationEmail}.`}</p></div>{codeAvailable ? <label className="contract-confirmation__field"><span>Código de confirmação</span><input className="contract-code-input" required inputMode="text" maxLength="6" value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="A1B2C3" autoComplete="one-time-code" /></label> : null}<div className="contract-confirmation__actions">{codeAvailable ? <button className="btn btn--primary" disabled={Boolean(busy)}>{busy === 'verify' ? 'Confirmando…' : 'Confirmar código'}</button> : emailPending ? <button type="button" className="btn" disabled>Verificando envio…</button> : <button className="btn btn--primary" disabled={Boolean(busy)}>{busy === 'code' ? 'Solicitando…' : emailFailed ? 'Solicitar novo código' : 'Enviar código para assinar'}</button>}{(codeAvailable || emailFailed) ? <button type="button" className="btn" onClick={resendCode} disabled={Boolean(busy) || resendIn > 0}>{resendIn > 0 ? `Reenviar em ${resendIn}s` : 'Reenviar código'}</button> : null}</div></form> : <form className="contract-signature" onSubmit={submitSignature}><div><h3 style={{ fontSize: 16, marginBottom: 5 }}>Assine o contrato</h3><p className="meta">Leia o contrato completo antes de aceitar e assinar. No celular, vire-o na horizontal se preferir uma área maior para desenhar sua assinatura.</p></div><SignaturePad onChange={setSignatureImage} /><Field label="Nome completo de quem assina" ph="Como no documento de identidade" value={signerName} onChange={setSignerName} required /><a className="contract-signature__read-link" href="#contrato-completo">Ler o contrato completo ↓</a><label className="consent"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>{multiple ? `Li e aceito os ${data.enrollments.length} contratos referentes aos alunos acima.` : 'Li e aceito o contrato referente ao aluno acima.'}</span></label><button className="cta" disabled={busy === 'sign' || !readyToSign}>{busy === 'sign' ? 'Registrando assinatura…' : 'Assinar contrato'}</button>{!readyToSign && busy !== 'sign' ? <span className="contract-signature__hint">{!signatureImage ? 'Desenhe sua assinatura' : !signerName.trim() ? 'Informe o nome completo de quem assina' : 'Marque que leu e aceita o contrato'} para liberar o botão.</span> : null}</form>}{message ? <div className="notice"><span>{message}</span>{message.includes('sucesso') && resumeToken ? <button className="btn" onClick={() => navigate(`${resumePath}?j=${encodeURIComponent(resumeToken)}&f=${resumeFlow}`)}>Voltar para a matrícula</button> : null}</div> : null}</> : null}
      {!dataReady ? <div className="contract-pdf-unavailable">Precisamos confirmar alguns dados do responsável ou aluno antes de gerar o contrato.</div> : !contractsGenerated ? <div className="contract-pdf-unavailable">{busy === 'generate' ? 'Gerando seu contrato individual…' : <><span>O PDF individual ainda não foi preparado.</span><button type="button" className="btn" onClick={() => { generatedFor.current = ''; contract.refresh(); }}>Tentar novamente</button></>}</div> : <section className="contract-viewer" id="contrato-completo"><div className="contract-viewer__intro"><strong>Leia o contrato completo</strong><span>O documento foi preenchido com os dados confirmados. Você pode ampliar nele mesmo ou abrir em tela cheia.</span></div>{data.enrollments?.map((item) => <ContractPdfPanel key={item.id} token={token} enrollment={item} />)}</section>}
    </div>
  </section>{showDataModal && !signed ? <ContractDataModal data={data.required_data} busy={busy === 'required'} error={dataSaveError} onClose={() => setShowDataModal(false)} onSubmit={submitRequiredData} /> : null}</main> : null}</DataState>;
}
