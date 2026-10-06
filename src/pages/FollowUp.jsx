import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDebugFollowup } from '../services/data';

/* TESTE / DEBUG — levantamento manual das conversas do WhatsApp (uazapi).
   Os dados vêm de `debug_followup_review`, carregada fora do painel; a RPC
   junta com o cadastro atual (responsável, alunos, etapa). Nada aqui muda a
   família: é só para enxergar onde cada conversa parou. */

const CATS = [
  { key: 'esperando_escola', label: 'Esperando a escola', hint: 'A família falou por último ou a IA prometeu a equipe, e ninguém respondeu.', color: '#C0392B' },
  { key: 'nao_identificado', label: 'Pai/mãe não identificado', hint: 'É família de aluno, mas o número não bate com o cadastro.', color: '#E4581C' },
  { key: 'combinado', label: 'Combinado, falta concluir', hint: 'A equipe negociou; falta mandar a rematrícula.', color: '#B8430E' },
  { key: 'link_parado', label: 'Recebeu o link e parou', hint: 'Jornada aberta, parada em Alunos.', color: '#4A7BD8' },
  { key: 'pai_sumiu', label: 'Família parou de responder', hint: 'A IA perguntou e a família não voltou.', color: '#3A5FBF' },
  { key: 'adiou', label: 'Adiou / não vai agora', hint: 'Risco de perder o aluno.', color: '#7A2FA8' },
  { key: 'pagamento', label: 'Assinou, falta pagamento', hint: 'Contrato feito; forma ou parcela pendente.', color: '#25794A' },
  { key: 'financeiro_2026', label: 'Cobrança de mensalidade', hint: 'Cobranças de 2026 e do curso técnico.', color: '#6B6A63' },
  { key: 'concluido', label: 'Concluído', hint: '', color: '#3AA757' },
  { key: 'fora', label: 'Fora da matrícula', hint: 'Equipe, fornecedor, banco, teste.', color: '#8F897D' }
];
const CAT = Object.fromEntries(CATS.map((c) => [c.key, c]));

const IDENT = {
  base: 'Na base',
  pai_fora_da_base: 'Aluno achado, número fora do cadastro',
  desconhecido: 'Não sabemos quem é',
  nao_familia: 'Não é família'
};
const WAITING = { escola: 'Esperando a escola', familia: 'Esperando a família', ninguem: 'Ninguém' };
const WHO = { familia: 'Família', ia: 'IA', equipe: 'Equipe' };
const FLAG = {
  ia_prometeu_equipe: 'IA prometeu a equipe',
  sem_resposta_humana: 'Sem resposta humana',
  pai_falou_por_ultimo: 'Família falou por último',
  ia_pausada_humano: 'IA pausada (humano)',
  responsavel_sem_telefone_na_base: 'Responsável sem telefone na base',
  numero_diferente_da_base: 'Número diferente do cadastro',
  numero_nao_vinculado: 'Número não vinculado',
  numero_de_outro_responsavel: 'Número no nome de outro responsável',
  telefone_errado_na_base: 'Telefone errado na base',
  erro_ia_instabilidade: 'Erro da IA (instabilidade)',
  desconto_convenio: 'Desconto de convênio',
  negociacao_desconto: 'Pediu desconto',
  pergunta_mensalidade_2027: 'Perguntou a mensalidade 2027',
  valor_negociado_fora_da_tabela: 'Valor negociado',
  sem_jornada: 'Sem jornada aberta',
  matricula_nova_junto: 'Tem matrícula nova junto',
  risco_de_perda: 'Risco de perda',
  reacao_ao_valor: 'Reagiu ao valor',
  link_nao_enviado: 'Link não enviado',
  parado_na_cobranca: 'Parado na cobrança',
  assinou: 'Assinou',
  concluida: 'Concluída',
  cobranca_sem_resposta: 'Cobrança sem resposta',
  promessa_de_pagamento: 'Prometeu pagar',
  acordo_de_divida: 'Acordo de dívida',
  pedido_pedagogico: 'Pedido pedagógico',
  comprovante_anterior: 'Mandou comprovante antes',
  curso_tecnico: 'Curso técnico',
  fornecedor: 'Fornecedor',
  equipe_interna: 'Equipe interna',
  teste: 'Teste',
  provavel_teste: 'Provável teste',
  sem_registro_no_banco: 'Sem registro no banco',
  ia_respondeu_assunto_interno: 'IA respondeu assunto interno',
  ia_atendeu_fornecedor: 'IA atendeu fornecedor',
  ia_respondeu_robo: 'IA respondeu robô',
  ia_valor_incompleto: 'IA passou valor incompleto',
  midia_nao_lida_pela_ia: 'Mídia que a IA não leu',
  cobranca_para_fornecedor: 'Cobrança foi para fornecedor',
  senha_enviada_no_chat: 'Senha enviada no chat',
  quer_rematricular: 'Quer rematricular',
  financeiro: 'Financeiro'
};
const HOT = new Set(['sem_resposta_humana', 'pai_falou_por_ultimo', 'erro_ia_instabilidade', 'risco_de_perda', 'senha_enviada_no_chat', 'cobranca_para_fornecedor']);
const TYPE = {
  AudioMessage: 'áudio', DocumentMessage: 'documento', ImageMessage: 'imagem', VideoMessage: 'vídeo',
  ReactionMessage: 'reação', StickerMessage: 'figurinha', ContactMessage: 'contato', TemplateMessage: 'mensagem de robô',
  ListMessage: 'lista', call: 'ligação'
};

const fmt = (value) => (value ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—');
function ago(value) {
  if (!value) return '';
  const hours = (Date.now() - new Date(value).getTime()) / 3600000;
  if (hours < 1) return `há ${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `há ${Math.round(hours)} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}
const LOWER = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
function proper(value) {
  const text = String(value || '');
  if (text !== text.toUpperCase()) return text;
  return text.toLowerCase().split(/\s+/).map((w, i) => (i && LOWER.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
function displayName(row) {
  const base = row.responsavel && row.responsavel !== 'Responsavel (WhatsApp)' ? proper(row.responsavel) : '';
  return base || row.contato_whatsapp || row.phone;
}
const waUrl = (phone) => `https://wa.me/${String(phone || '').replace(/\D/g, '')}`;
const norm = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function Row({ row, onOpen }) {
  const cat = CAT[row.categoria] || CAT.fora;
  const students = row.alunos_base || row.alunos_hint;
  return (
    <button type="button" className="fu-row" style={{ '--accent': cat.color }} onClick={() => onOpen(row)}>
      <div className="fu-row-main">
        <div className="fu-row-top">
          <strong>{displayName(row)}</strong>
          {row.contato_whatsapp && displayName(row) !== row.contato_whatsapp ? <span className="fu-contact">“{row.contato_whatsapp}”</span> : null}
        </div>
        {students ? <span className="fu-students">{students}</span> : null}
        <span className="fu-paused">{row.parou_em}</span>
      </div>
      <div className="fu-row-side">
        <span className={`fu-wait fu-wait--${row.aguardando}`}>{WAITING[row.aguardando]}</span>
        <span className="meta">{WHO[row.ultima_msg_de] || '—'} · {ago(row.ultima_msg_em)}</span>
        <div className="fu-flags">
          {row.identificacao !== 'base' ? <span className="kpill kpill--human">{IDENT[row.identificacao]}</span> : null}
          {(row.flags || []).filter((f) => HOT.has(f)).map((f) => <span key={f} className="kpill kpill--hot">{FLAG[f] || f}</span>)}
        </div>
      </div>
    </button>
  );
}

function Transcript({ items }) {
  if (!items?.length) return <div className="kcol-empty">Sem mensagens</div>;
  return (
    <div className="fu-chat">
      {items.map((m, index) => (
        <div key={`${m.t}-${index}`} className={`fu-msg fu-msg--${m.de}${m.antes_do_corte ? ' is-before' : ''}`}>
          <div className="fu-msg-head"><strong>{WHO[m.de]}</strong><span>{fmt(m.t)}{m.antes_do_corte ? ' · antes de sexta 11h' : ''}</span></div>
          {TYPE[m.tipo] ? <em className="fu-msg-type">[{TYPE[m.tipo]}]</em> : null}
          {m.texto ? <p>{m.texto}</p> : null}
        </div>
      ))}
    </div>
  );
}

function Drawer({ row, onClose }) {
  const navigate = useNavigate();
  const cat = CAT[row.categoria] || CAT.fora;
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const kv = [
    ['Contato no WhatsApp', row.contato_whatsapp],
    ['Cadastro', row.responsavel || 'nenhum'],
    ['Identificação', IDENT[row.identificacao]],
    ['Alunos (base)', row.alunos_base || '—'],
    row.alunos_hint ? ['Alunos (achados pelo nome)', row.alunos_hint] : null,
    ['Etapa agora', row.etapa_agora || 'sem jornada'],
    ['Atendimento agora', row.atendimento_agora === 'humano' ? 'Equipe (IA pausada)' : row.atendimento_agora === 'ia' ? 'IA' : '—'],
    ['Esperando', WAITING[row.aguardando]],
    ['Última mensagem', `${WHO[row.ultima_msg_de] || '—'} · ${fmt(row.ultima_msg_em)}`],
    ['Última da família', fmt(row.ultima_msg_familia_em)],
    ['Mensagens', `família ${row.msgs_familia} · IA ${row.msgs_ia} · equipe ${row.msgs_equipe}`],
    ['Chat uazapi', row.chat_id],
    row.guardian_id ? ['guardian_id', row.guardian_id] : null
  ].filter(Boolean);
  return (
    <div className="kdrawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="kdrawer fu-drawer" role="dialog" aria-modal="true" aria-label={displayName(row)}>
        <div className="kdrawer-head">
          <div>
            <span className="kdrawer-stage" style={{ '--accent': cat.color }}><i />{cat.label}</span>
            <h2>{displayName(row)}</h2>
            <span className="meta">{row.phone}</span>
          </div>
          <button type="button" className="modal-close" aria-label="Fechar" onClick={onClose}>×</button>
        </div>
        <div className="kdrawer-actions">
          <a className="btn btn--primary" href={waUrl(row.phone)} target="_blank" rel="noreferrer">Abrir WhatsApp</a>
          {row.guardian_id ? <button type="button" className="btn" onClick={() => navigate(`/familias/${row.guardian_id}`)}>Ver ficha</button> : null}
        </div>
        <section className="kdrawer-section">
          <h3>O que aconteceu</h3>
          <p className="fu-text">{row.resumo}</p>
          <h3>Onde parou</h3>
          <p className="fu-text">{row.parou_em}</p>
          <h3>O que falta</h3>
          <p className="fu-text fu-text--strong">{row.pendencia}</p>
          {row.flags?.length ? <div className="fu-flags">{row.flags.map((f) => <span key={f} className={`kpill${HOT.has(f) ? ' kpill--hot' : ''}`}>{FLAG[f] || f}</span>)}</div> : null}
        </section>
        <section className="kdrawer-section">
          <h3>Dados para depurar</h3>
          {kv.map(([label, value]) => <div className="kdrawer-kv fu-kv" key={label}><span>{label}</span><strong>{value}</strong></div>)}
        </section>
        <section className="kdrawer-section">
          <h3>Conversa (uazapi)</h3>
          <Transcript items={row.transcript} />
        </section>
      </aside>
    </div>
  );
}

export default function FollowUp() {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [cat, setCat] = useState('');
  const [onlyOutside, setOnlyOutside] = useState(false);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    getDebugFollowup()
      .then((data) => setState({ loading: false, error: '', data }))
      .catch((error) => setState({ loading: false, error: error.message || String(error), data: null }));
  }, []);

  const rows = useMemo(() => state.data?.rows || [], [state.data]);
  const counts = useMemo(() => rows.reduce((acc, r) => ({ ...acc, [r.categoria]: (acc[r.categoria] || 0) + 1 }), {}), [rows]);
  const outside = rows.filter((r) => r.identificacao === 'pai_fora_da_base' || r.identificacao === 'desconhecido').length;
  const waitingSchool = rows.filter((r) => r.aguardando === 'escola').length;
  const visible = useMemo(() => {
    const term = norm(search.trim());
    return rows.filter((r) => (!cat || r.categoria === cat)
      && (!onlyOutside || r.identificacao === 'pai_fora_da_base' || r.identificacao === 'desconhecido')
      && (!term || norm([r.responsavel, r.contato_whatsapp, r.phone, r.alunos_base, r.alunos_hint, r.resumo].join(' ')).includes(term)));
  }, [rows, cat, onlyOutside, search]);
  const groups = CATS.map((c) => [c, visible.filter((r) => r.categoria === c.key)]).filter(([, list]) => list.length);

  return (
    <div className="fu-page">
      <div className="notice notice--soft fu-banner">
        <p><strong>Aba de teste.</strong> Levantamento de todas as conversas do WhatsApp da escola no período {state.data?.snapshot || ''}, lidas na uazapi e cruzadas com a base. Só leitura: nada aqui manda mensagem ou muda a jornada. O cadastro, a etapa e o atendimento são atuais; a conversa e a análise são do momento do levantamento.</p>
      </div>

      {state.error ? <div className="notice"><strong>Não foi possível carregar.</strong><span>{state.error}</span></div> : null}
      {state.loading ? <div className="notice">Carregando…</div> : null}

      {state.data ? (
        <>
          <div className="fu-kpis">
            <div className="fu-kpi fu-kpi--hot"><span>Esperando a escola</span><strong>{waitingSchool}</strong><small>a próxima mensagem é nossa</small></div>
            <div className="fu-kpi"><span>Família fora do cadastro</span><strong>{outside}</strong><small>número não bate com a base</small></div>
            <div className="fu-kpi"><span>Link parado ou família sumiu</span><strong>{(counts.link_parado || 0) + (counts.pai_sumiu || 0)}</strong><small>a próxima mensagem é da família</small></div>
            <div className="fu-kpi"><span>Conversas no período</span><strong>{rows.length}</strong><small>inclui cobrança, equipe e fornecedor</small></div>
          </div>

          <div className="fu-toolbar">
            <input className="control fu-search" type="search" placeholder="Buscar nome, aluno, telefone ou assunto" value={search} onChange={(event) => setSearch(event.target.value)} />
            <button type="button" className={`chip${onlyOutside ? ' is-active' : ''}`} onClick={() => setOnlyOutside((v) => !v)}>Só fora do cadastro<span className="chip-count">{outside}</span></button>
          </div>
          <div className="chip-row">
            <button type="button" className={`chip${!cat ? ' is-active' : ''}`} onClick={() => setCat('')}>Todas<span className="chip-count">{rows.length}</span></button>
            {CATS.filter((c) => counts[c.key]).map((c) => (
              <button key={c.key} type="button" className={`chip${cat === c.key ? ' is-active' : ''}`} onClick={() => setCat(cat === c.key ? '' : c.key)}>{c.label}<span className="chip-count">{counts[c.key]}</span></button>
            ))}
          </div>

          {groups.map(([c, list]) => (
            <section key={c.key} className="fu-group" style={{ '--accent': c.color }}>
              <header className="fu-group-head">
                <div><i /><strong>{c.label}</strong><span className="kcol-count">{list.length}</span></div>
                {c.hint ? <span className="meta">{c.hint}</span> : null}
              </header>
              <div className="fu-list">{list.map((r) => <Row key={r.id} row={r} onOpen={setOpen} />)}</div>
            </section>
          ))}
          {!groups.length ? <div className="kcol-empty">Nada com esse filtro</div> : null}
        </>
      ) : null}

      {open ? <Drawer row={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
