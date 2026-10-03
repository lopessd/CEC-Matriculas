/* Etapas da jornada (calculadas no banco por onboarding_stage) e utilidades
   comuns às telas de operação: quadro, famílias, pagamentos e matriculados. */
import { useMemo, useState } from 'react';

export const COLUMNS = {
  rematricula: [
    { key: 'a_contatar', label: 'A contatar', hint: 'Base 2026 que ainda não conversou', stages: ['a_contatar'], color: '#A8B8E0' },
    { key: 'conversa', label: 'Em conversa', hint: 'Falou no WhatsApp, ainda sem jornada', stages: ['conversa'], color: '#4A7BD8' },
    { key: 'alunos', label: 'Escolhendo alunos', hint: 'Abriu o link e confirma os filhos', stages: ['identificacao', 'alunos'], color: '#8356B8', anonymous: true },
    { key: 'condicoes', label: 'Plano de pagamento', hint: 'Escolhe em quantas vezes paga', stages: ['condicoes'], color: '#B05CC8' },
    { key: 'assinatura', label: 'Assinatura', hint: 'Contrato pronto para assinar', stages: ['assinatura'], color: '#F07E26' },
    { key: 'cobranca', label: 'Forma de pagamento', hint: 'Assinou; falta boleto, cartão ou Pix', stages: ['cobranca'], color: '#E4581C' },
    { key: 'pagamento', label: 'Aguardando pagamento', hint: 'Tudo escolhido; falta pagar', stages: ['pagamento'], color: '#8A5D08' },
    { key: 'concluida', label: 'Concluída', hint: 'Pagamento confirmado', stages: ['concluida'], color: '#3AA757' },
    { key: 'perdida', label: 'Sem interesse', hint: 'Saiu da campanha', stages: ['perdida'], color: '#6B6A63', optional: true }
  ],
  matricula_nova: [
    { key: 'conversa', label: 'Em conversa', hint: 'Falou no WhatsApp, ainda sem jornada', stages: ['conversa', 'a_contatar'], color: '#4A7BD8' },
    { key: 'dados', label: 'Cadastro', hint: 'Preenche os dados da família', stages: ['dados', 'identificacao', 'alunos'], color: '#8356B8', anonymous: true },
    { key: 'condicoes', label: 'Plano de pagamento', hint: 'Escolhe em quantas vezes paga', stages: ['condicoes'], color: '#B05CC8' },
    { key: 'assinatura', label: 'Assinatura', hint: 'Contrato pronto para assinar', stages: ['assinatura'], color: '#F07E26' },
    { key: 'cobranca', label: 'Forma de pagamento', hint: 'Assinou; falta boleto, cartão ou Pix', stages: ['cobranca'], color: '#E4581C' },
    { key: 'pagamento', label: 'Aguardando pagamento', hint: 'Tudo escolhido; falta pagar', stages: ['pagamento'], color: '#8A5D08' },
    { key: 'concluida', label: 'Concluída', hint: 'Pagamento confirmado', stages: ['concluida'], color: '#3AA757' },
    { key: 'perdida', label: 'Sem interesse', hint: 'Saiu da campanha', stages: ['perdida'], color: '#6B6A63', optional: true }
  ]
};

export const KINDS = [['rematricula', 'Rematrícula'], ['matricula_nova', 'Matrícula nova']];
export const KIND_LABEL = { rematricula: 'Rematrícula', matricula_nova: 'Matrícula nova' };

/** Coluna (rótulo e cor) de uma etapa, em qualquer tipo de campanha. */
export function stageInfo(stage, kind = 'rematricula') {
  const own = (COLUMNS[kind] || []).find((column) => column.stages.includes(stage));
  if (own) return own;
  for (const list of Object.values(COLUMNS)) {
    const found = list.find((column) => column.stages.includes(stage));
    if (found) return found;
  }
  return { key: stage || 'sem_etapa', label: stage || 'Sem etapa', color: '#A8B8E0' };
}

export const stageRank = (stage, kind = 'rematricula') => {
  const index = (COLUMNS[kind] || []).findIndex((column) => column.stages.includes(stage));
  return index < 0 ? 99 : index;
};

export const METHOD_LABEL = { boleto: 'Boleto', cartao: 'Cartão', credit_card: 'Cartão', pix: 'Pix', dinheiro: 'Dinheiro' };
export const METHODS = [['pix', 'Pix'], ['boleto', 'Boleto'], ['cartao', 'Cartão'], ['dinheiro', 'Dinheiro']];

export const INSTALLMENT_LABEL = { pendente: 'Em aberto', pago: 'Recebido', vencido: 'Vencida', cancelado: 'Cancelada', estornado: 'Estornada' };
export const INSTALLMENT_TONE = { pendente: 'mute', pago: 'ok', vencido: 'warn', cancelado: 'mute', estornado: 'warn' };
export const PAID_SOURCE_LABEL = { manual: 'na secretaria', asaas: 'pelo Asaas', asaas_manual: 'na secretaria · registrado no Asaas' };

export const fold = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const centsToInput = (cents) => (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
export const inputToCents = (value) => Math.round(Number(String(value || '').replace(/\./g, '').replace(',', '.')) * 100);
export const localDay = (value) => (value ? new Intl.DateTimeFormat('pt-BR').format(new Date(value)) : '');

export function timeAgo(value) {
  if (!value) return '';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'ontem';
  return days < 45 ? `há ${days} dias` : localDay(value);
}

export function whatsappUrl(phone, text) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (!digits.startsWith('55')) digits = `55${digits}`;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function journeyUrl({ token, flow }) {
  if (!token) return '';
  const path = flow === 'rematricula' ? 'rematricula' : 'matricula';
  return `${window.location.origin}/${path}?j=${encodeURIComponent(token)}&f=${encodeURIComponent(flow || 'matricula_nova')}`;
}

export const contractUrl = (token) => (token ? `${window.location.origin}/contrato/${token}` : '');

export function formatCpfView(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 11 ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}` : value || '—';
}

export function formatPhoneView(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length > 11) digits = digits.slice(2);
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 3)} ${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return value || '—';
}

/**
 * Ordenação de tabela por coluna. `getters` mapeia a chave da coluna para o
 * valor comparável; clicar de novo na mesma coluna inverte a ordem.
 */
export function useSort(rows, getters, initial = { key: null, dir: 'asc' }) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const get = getters[sort.key];
    if (!get) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * factor;
      return String(x).localeCompare(String(y), 'pt-BR', { numeric: true, sensitivity: 'base' }) * factor;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const toggle = (key) => setSort((current) => ({ key, dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc' }));
  return { sorted, sort, toggle };
}

/** Baixa um CSV (separador ";" para abrir direto no Excel em português). */
export function downloadCsv(filename, header, rows) {
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = [header, ...rows].map((line) => line.map(escape).join(';')).join('\n');
  const blob = new Blob([`\ufeff${body}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
