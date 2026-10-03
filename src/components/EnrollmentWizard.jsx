import { useEffect, useState } from 'react';
import NewEnrollmentWizard from './NewEnrollmentWizard';
import RematriculaWizard from './RematriculaWizard';

/* Porta de entrada do "+ Matrícula": rematrícula (família da base) ou
   matrícula nova (família que ainda não estuda no CEC). */
export default function EnrollmentWizard({ initialMode = null, onClose, onCreated }) {
  const [mode, setMode] = useState(initialMode);

  useEffect(() => {
    if (mode) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onClose]);

  if (mode === 'rematricula') return <RematriculaWizard onClose={onClose} onCreated={onCreated} onSwitchToNew={() => setMode('nova')} />;
  if (mode === 'nova') return <NewEnrollmentWizard onClose={onClose} onCreated={onCreated} />;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card wizard-start" role="dialog" aria-modal="true" aria-labelledby="start-title">
        <div className="modal-head">
          <div><h2 id="start-title">Nova matrícula</h2><p>Que tipo de matrícula a secretaria vai fazer?</p></div>
          <button className="modal-close" type="button" aria-label="Fechar" onClick={onClose}>×</button>
        </div>
        <div className="wizard-start-options">
          <button type="button" className="wizard-start-option" onClick={() => setMode('rematricula')}>
            <strong>Rematrícula</strong>
            <span>Família que já estuda no CEC. Busque pelo pai, CPF, telefone ou aluno, marque os filhos e, se precisar, adicione um irmão novo.</span>
          </button>
          <button type="button" className="wizard-start-option" onClick={() => setMode('nova')}>
            <strong>Matrícula nova</strong>
            <span>Família nova na escola. Cadastre o responsável e os alunos do zero.</span>
          </button>
        </div>
      </section>
    </div>
  );
}
