import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Field, LogoBlocks } from '../components/ui';
import DataState from '../components/DataState';
import { useAsyncData } from '../hooks/useAsyncData';
import { money } from '../lib/format';
import { completeMatriculaLink, openMatriculaLink, saveMatriculaLink } from '../services/data';

const emptyForm = { guardianName: '', email: '', phone: '', studentName: '', birthDate: '', previousSchool: '', gradeId: '' };

export default function LinkMatricula() {
  const { token } = useParams();
  const link = useAsyncData(() => openMatriculaLink(token), [token]);
  const [form, setForm] = useState(emptyForm);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!link.data || loaded) return;
    setForm({
      guardianName: link.data.guardian?.name || '', email: link.data.guardian?.email || '', phone: link.data.guardian?.phone || '',
      studentName: link.data.student?.name || '', birthDate: link.data.student?.birth_date || '', previousSchool: link.data.student?.previous_school || '',
      gradeId: link.data.target_grade_id || ''
    });
    setLoaded(true);
  }, [link.data, loaded]);

  const update = (name) => (value) => setForm((current) => ({ ...current, [name]: value }));
  const gradeOptions = (link.data?.offerings || []).map((item) => ({ value: item.grade_id, label: `${item.name} · ${money(item.amount_cents)}` }));

  async function submit(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      await saveMatriculaLink(token, form);
      await completeMatriculaLink(token);
      setMessage('Formulário concluído. A matrícula seguirá para a etapa de assinatura do contrato.');
      await link.refresh();
    } catch (error) { setMessage(error.message || 'Não foi possível salvar agora.'); }
    finally { setSaving(false); }
  }

  return <DataState loading={link.loading} error={link.error} empty={!link.loading && !link.error && !link.data}>{link.data ? <main className="auth-page" style={{ padding: '32px 18px' }}><section className="public public--single" style={{ width: 'min(860px, 100%)' }}><div className="public-head--navy"><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><LogoBlocks /><span className="public-kicker">Matrícula individual</span></div><h2>Continue sua matrícula</h2><p>Confirme os dados para encaminhar a matrícula à etapa de assinatura.</p></div><div className="public-body"><div className="notice notice--soft"><span>{link.data.campaign} · Link individual seguro</span></div><form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}><div className="grid grid--2"><Field label="Nome do responsável" value={form.guardianName} onChange={update('guardianName')} required /><Field label="E-mail" type="email" value={form.email} onChange={update('email')} required /><Field label="WhatsApp" value={form.phone} onChange={update('phone')} required /><Field label="Nome do aluno" value={form.studentName} onChange={update('studentName')} required /><Field label="Nascimento" type="date" value={form.birthDate} onChange={update('birthDate')} /><Field label="Escola atual" value={form.previousSchool} onChange={update('previousSchool')} /><Field label="Série pretendida" type="select" options={gradeOptions} value={form.gradeId} onChange={update('gradeId')} required /></div>{message ? <div className="notice"><span>{message}</span></div> : null}<div className="public-foot"><span>O parcelamento será definido automaticamente pela data de assinatura, até janeiro. Boleto, cartão e Pix estarão disponíveis na etapa de pagamento.</span><button className="cta" disabled={saving}>{saving ? 'Concluindo…' : 'Concluir formulário →'}</button></div></form></div></section></main> : null}</DataState>;
}
