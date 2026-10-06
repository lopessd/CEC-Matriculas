import { useEffect, useState } from 'react';
import { sendStaffWhatsapp, suggestStaffMessage } from '../services/data';

/* Modal de confirmação simples, por cima do painel lateral (z-index maior). */
export function ConfirmModal({ title, children, confirmLabel = 'Confirmar', danger = false, busy = false, onConfirm, onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return (
    <div className="modal-backdrop cmodal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="modal-card cmodal-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="modal-close" type="button" aria-label="Fechar" onClick={onClose} disabled={busy}>×</button>
        </div>
        <div className="modal-form cmodal-body">{children}</div>
        <div className="cmodal-actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="button" className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={onConfirm} disabled={busy}>{busy ? 'Aguarde…' : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

function waUrl(phone, text) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (!d.startsWith('55')) d = `55${d}`;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/**
 * Escrever e mandar uma mensagem para a família, de três jeitos:
 * pelo sistema (API da UAZAPI, com confirmação), copiando, ou abrindo o
 * WhatsApp para enviar à mão. A IA pode sugerir o texto.
 */
export default function MessageComposer({ phone, guardianId, name, initialText = '', purpose = 'followup', title = 'Mensagem para a família', allowSuggest = true, onSent }) {
  const [text, setText] = useState(initialText);
  const [instruction, setInstruction] = useState('');
  const [state, setState] = useState({ suggesting: false, sending: false, error: '', copied: false, sent: null, confirm: false });

  useEffect(() => { setText(initialText); }, [initialText]);

  async function suggest() {
    setState((s) => ({ ...s, suggesting: true, error: '' }));
    try {
      const result = await suggestStaffMessage({ phone, guardianId, purpose, instruction });
      setText(result.text || '');
      setState((s) => ({ ...s, suggesting: false }));
    } catch (err) {
      setState((s) => ({ ...s, suggesting: false, error: err.message || 'A IA não conseguiu sugerir agora.' }));
    }
  }

  async function copy() {
    await navigator.clipboard?.writeText(text);
    setState((s) => ({ ...s, copied: true }));
    window.setTimeout(() => setState((s) => ({ ...s, copied: false })), 1800);
  }

  async function send() {
    setState((s) => ({ ...s, sending: true, error: '' }));
    try {
      const result = await sendStaffWhatsapp({ phone, guardianId, text });
      setState((s) => ({ ...s, sending: false, confirm: false, sent: new Date() }));
      onSent?.(result);
    } catch (err) {
      setState((s) => ({ ...s, sending: false, confirm: false, error: err.message || 'Não foi possível enviar.' }));
    }
  }

  const empty = !text.trim();
  return (
    <section className="kdrawer-section mcomposer">
      <h3>{title}</h3>
      {allowSuggest ? (
        <div className="mcomposer-ai">
          <input className="control" placeholder="Orientação para a IA (opcional): ex. lembrar do prazo de 31/10" value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={300} />
          <button type="button" className="btn" disabled={state.suggesting} onClick={suggest}>{state.suggesting ? 'Escrevendo…' : text ? '✨ Sugerir outra' : '✨ Sugerir com IA'}</button>
        </div>
      ) : null}
      <textarea className="kinvite-text" rows={text ? Math.min(16, Math.max(5, text.split('\n').length + 1)) : 4} placeholder="Escreva a mensagem ou peça uma sugestão à IA" value={text} onChange={(event) => setText(event.target.value)} />
      <div className="kdrawer-actions">
        <button type="button" className="btn btn--primary" disabled={empty || state.sending} onClick={() => setState((s) => ({ ...s, confirm: true }))}>Enviar pelo sistema</button>
        <button type="button" className="btn" disabled={empty} onClick={copy}>{state.copied ? 'Copiada' : 'Copiar'}</button>
        <a className={`btn${empty ? ' is-disabled' : ''}`} href={empty ? undefined : waUrl(phone, text)} target="_blank" rel="noreferrer">Abrir no WhatsApp</a>
      </div>
      {state.sent ? <span className="mcomposer-ok">Enviada pelo sistema às {state.sent.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.</span> : null}
      <span className="meta">“Enviar pelo sistema” manda pelo número da escola (API) e fica registrada na conversa, sem pausar a IA. “Abrir no WhatsApp” é o envio à mão.</span>
      {state.error ? <div className="notice"><span>{state.error}</span></div> : null}

      {state.confirm ? (
        <ConfirmModal title="Enviar pelo sistema?" confirmLabel="Enviar agora" busy={state.sending} onConfirm={send} onClose={() => setState((s) => ({ ...s, confirm: false }))}>
          <p className="cmodal-text">Vai sair agora do WhatsApp da escola para <strong>{name || phone}</strong> ({phone}):</p>
          <blockquote className="cmodal-quote">{text}</blockquote>
        </ConfirmModal>
      ) : null}
    </section>
  );
}
