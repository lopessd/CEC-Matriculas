import { useMemo, useState } from 'react';
import { asaasAdmin } from '../services/data';
import { date as formatDate, money } from '../lib/format';
import {
  INSTALLMENT_LABEL, INSTALLMENT_TONE, METHODS, METHOD_LABEL, PAID_SOURCE_LABEL,
  centsToInput, inputToCents, localDay, todayIso
} from '../lib/journey';

/* Parcelas de uma família agrupadas pela cobrança (uma cobrança do Asaas pode
   cobrir a parcela de vários irmãos). Cada grupo dá baixa, desfaz, abre a
   cobrança e vincula/desvincula; no rodapé, atualizar pelo Asaas e gerar as
   cobranças. Todas as ações passam pela Edge Function asaas-admin. */

const ASAAS_STATUS = {
  PENDING: 'aguardando', RECEIVED: 'recebida', CONFIRMED: 'confirmada', RECEIVED_IN_CASH: 'recebida em dinheiro',
  OVERDUE: 'vencida', REFUNDED: 'estornada', DELETED: 'apagada', REFUND_REQUESTED: 'estorno pedido'
};

function groupRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.provider_charge_id || `due:${row.due_date}:${row.status === 'pago' ? row.id : 'open'}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()].map(([key, items]) => {
    const statuses = new Set(items.map((item) => item.status));
    const status = statuses.size === 1 ? items[0].status : statuses.has('vencido') ? 'vencido' : statuses.has('pendente') ? 'pendente' : items[0].status;
    return {
      key, items, status,
      due: items[0].due_date,
      total: items.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0),
      paid: items.reduce((sum, item) => sum + Number(item.status === 'pago' ? item.paid_amount_cents ?? item.amount_cents : 0), 0),
      charge: items[0].provider_charge_id,
      first: items[0]
    };
  }).sort((a, b) => String(a.due).localeCompare(String(b.due)));
}

function ReceiveForm({ group, busy, onCancel, onSubmit }) {
  const single = group.items.length === 1;
  const [form, setForm] = useState({
    method: group.first.method || 'pix', paidOn: todayIso(), amount: centsToInput(group.total),
    registerInAsaas: Boolean(group.charge), notify: false
  });
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  return (
    <form className="fp-form" onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
      <label>Forma<select value={form.method} onChange={(event) => set({ method: event.target.value })}>{METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Recebido em<input type="date" value={form.paidOn} max={todayIso()} onChange={(event) => set({ paidOn: event.target.value })} required /></label>
      <label>Valor (R$)<input inputMode="decimal" value={form.amount} disabled={!single} title={single ? '' : 'Várias parcelas: cada uma recebe o próprio valor'} onChange={(event) => set({ amount: event.target.value })} required /></label>
      <div className="fp-form-checks">
        {group.charge ? <label className="fp-check"><input type="checkbox" checked={form.registerInAsaas} onChange={(event) => set({ registerInAsaas: event.target.checked })} />Registrar o recebimento também no Asaas</label> : null}
        <label className="fp-check"><input type="checkbox" checked={form.notify} onChange={(event) => set({ notify: event.target.checked })} />Avisar a família no WhatsApp</label>
      </div>
      <div className="fp-form-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Salvando…' : 'Confirmar recebimento'}</button>
      </div>
    </form>
  );
}

function LinkPicker({ group, payments, loading, onSearch, onPick, onCancel, busy }) {
  return (
    <div className="fp-link">
      <div className="fp-link-head">
        <strong>Vincular a uma cobrança do Asaas</strong>
        <span>Cobranças deste responsável no Asaas que ainda não estão ligadas a nenhuma parcela.</span>
      </div>
      {loading ? <div className="meta">Buscando no Asaas…</div> : null}
      {!loading && payments == null ? <button type="button" className="btn" onClick={onSearch}>Buscar cobranças no Asaas</button> : null}
      {!loading && payments?.length === 0 ? <div className="meta">Nenhuma cobrança livre encontrada para este CPF no Asaas.</div> : null}
      {(payments || []).map((payment) => {
        const matches = Math.abs(payment.value_cents - group.total) <= 1;
        return (
          <button type="button" key={payment.id} className={`fp-link-option${matches ? ' is-match' : ''}`} disabled={busy} onClick={() => onPick(payment)}>
            <span><strong>{money(payment.value_cents)}</strong> · {ASAAS_STATUS[payment.status] || payment.status} · {payment.billing_type}</span>
            <small>vence {formatDate(payment.due_date)}{payment.payment_date ? ` · pago em ${formatDate(payment.payment_date)}` : ''} · {payment.id}{payment.description ? ` · ${payment.description}` : ''}</small>
            {matches ? <em>valor igual ao da parcela</em> : null}
          </button>
        );
      })}
      <div className="fp-form-actions"><button type="button" className="btn btn--ghost" onClick={onCancel}>Fechar</button></div>
    </div>
  );
}

function ChargeGroup({ group, busy, onAction, unmatched, onSearchUnmatched, searching }) {
  const [mode, setMode] = useState(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [copied, setCopied] = useState('');
  const paid = group.status === 'pago';
  const open = ['pendente', 'vencido'].includes(group.status);
  const ids = group.items.map((item) => item.id);
  const first = group.first;

  async function copy(label, value) {
    await navigator.clipboard?.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(''), 1600);
  }

  return (
    <div className={`fp-group is-${group.status}`}>
      <div className="fp-group-head">
        <div className="fp-group-when">
          <strong>{money(group.total)}</strong>
          <span>vence {formatDate(group.due)}</span>
        </div>
        <span className={`fp-status fp-status--${INSTALLMENT_TONE[group.status] || 'mute'}`}>{INSTALLMENT_LABEL[group.status] || group.status}</span>
        {group.charge
          ? <span className="fp-asaas" title={group.charge}>Asaas · {ASAAS_STATUS[first.asaas_status] || 'vinculada'}{first.asaas_synced_at ? ` · conferido ${localDay(first.asaas_synced_at)}` : ''}</span>
          : <span className="fp-asaas is-off">Sem cobrança no Asaas</span>}
      </div>
      <ul className="fp-lines">
        {group.items.map((item) => (
          <li key={item.id}>
            <span>{item.student_name || 'Aluno'} · parcela {item.number}</span>
            <span>{money(item.amount_cents)}</span>
          </li>
        ))}
      </ul>
      {paid ? (
        <div className="fp-paid">
          Recebido {localDay(first.paid_at)}{first.method ? ` · ${METHOD_LABEL[first.method] || first.method}` : ''}{first.paid_source ? ` · ${PAID_SOURCE_LABEL[first.paid_source] || first.paid_source}` : ''}
          {group.paid !== group.total ? ` · ${money(group.paid)}` : ''}
        </div>
      ) : null}

      {mode === 'receive' ? (
        <ReceiveForm group={group} busy={busy} onCancel={() => setMode(null)} onSubmit={async (form) => {
          const cents = inputToCents(form.amount);
          const ok = await onAction('receive', {
            installment_ids: ids, method: form.method, paid_on: form.paidOn,
            amount_cents: group.items.length === 1 && cents > 0 ? cents : undefined,
            register_in_asaas: form.registerInAsaas, notify: form.notify
          }, 'Recebimento registrado');
          if (ok) setMode(null);
        }} />
      ) : null}

      {mode === 'link' ? (
        <LinkPicker group={group} payments={unmatched} loading={searching} busy={busy} onSearch={onSearchUnmatched} onCancel={() => setMode(null)}
          onPick={async (payment) => { if (await onAction('link', { installment_ids: ids, payment_id: payment.id }, 'Cobrança vinculada')) setMode(null); }} />
      ) : null}

      {!mode ? (
        <div className="fp-actions">
          {open ? <button type="button" className="btn btn--primary" disabled={busy} onClick={() => setMode('receive')}>Marcar como recebido</button> : null}
          {paid ? (confirmUndo
            ? <><span className="meta">Voltar para em aberto{first.paid_source === 'asaas_manual' ? ' (desfaz também no Asaas)' : ''}?</span><button type="button" className="btn btn--danger" disabled={busy} onClick={async () => { if (await onAction('undo', { installment_ids: ids }, 'Recebimento desfeito')) setConfirmUndo(false); }}>Sim, desfazer</button><button type="button" className="btn btn--ghost" onClick={() => setConfirmUndo(false)}>Cancelar</button></>
            : <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setConfirmUndo(true)}>Desfazer recebimento</button>) : null}
          {first.payment_url ? <a className="btn" href={first.payment_url} target="_blank" rel="noreferrer">Abrir cobrança ↗</a> : null}
          {first.bank_slip_url ? <a className="btn" href={first.bank_slip_url} target="_blank" rel="noreferrer">Boleto PDF ↗</a> : null}
          {first.boleto_line ? <button type="button" className="btn btn--ghost" onClick={() => copy('linha', first.boleto_line)}>{copied === 'linha' ? 'Copiada' : 'Copiar linha digitável'}</button> : null}
          {first.pix_code ? <button type="button" className="btn btn--ghost" onClick={() => copy('pix', first.pix_code)}>{copied === 'pix' ? 'Copiado' : 'Copiar Pix'}</button> : null}
          {!group.charge && group.status !== 'cancelado' ? <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setMode('link')}>Vincular cobrança do Asaas</button> : null}
          {group.charge && !paid ? <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onAction('unlink', { installment_ids: ids }, 'Cobrança desvinculada')}>Desvincular</button> : null}
        </div>
      ) : null}
    </div>
  );
}

export default function FamilyPayments({ rows, guardianId, unmatched: initialUnmatched, onChanged, showFooter = true }) {
  const groups = useMemo(() => groupRows((rows || []).filter((row) => row.status !== 'cancelado')), [rows]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [unmatched, setUnmatched] = useState(initialUnmatched ?? null);
  const [searching, setSearching] = useState(false);
  const [charging, setCharging] = useState(null);
  const withoutCharge = (rows || []).filter((row) => row.status === 'pendente' && !row.provider_charge_id);

  async function run(action, payload, success) {
    setBusy(true); setMessage(null);
    try {
      const result = await asaasAdmin(action, payload);
      setMessage({ tone: 'ok', text: success });
      await onChanged?.(result);
      return result || true;
    } catch (error) {
      setMessage({ tone: 'warn', text: error.message || 'Não foi possível concluir.' });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function syncFamily() {
    setSearching(true);
    const result = await run('sync', { guardian_ids: [guardianId] }, 'Família conferida no Asaas');
    setSearching(false);
    if (result?.families) {
      const family = result.families.find((item) => item.guardian_id === guardianId);
      setUnmatched(family?.unmatched_payments || []);
      const changes = family?.changes?.filter((change) => change.action !== 'conflito').length || 0;
      const conflicts = family?.changes?.filter((change) => change.action === 'conflito').length || 0;
      const errors = family?.errors?.length || 0;
      const customer = family?.customer_id ? '' : ' Não há cliente com este CPF no Asaas.';
      setMessage({
        tone: errors ? 'warn' : 'ok',
        text: `${changes ? `${changes} parcela${changes > 1 ? 's' : ''} atualizada${changes > 1 ? 's' : ''}.` : 'Nada mudou no Asaas.'}${conflicts ? ` ${conflicts} recebida${conflicts > 1 ? 's' : ''} só no painel (em aberto no Asaas).` : ''}${family?.unmatched_payments?.length ? ` ${family.unmatched_payments.length} cobrança${family.unmatched_payments.length > 1 ? 's' : ''} do Asaas sem parcela: use “Vincular”.` : ''}${customer}${errors ? ` ${errors} erro(s): ${family.errors.map((item) => item.message).join('; ')}` : ''}`
      });
    }
  }

  if (!groups.length) {
    return <div className="fp-empty">As parcelas aparecem aqui depois que o contrato é assinado.</div>;
  }

  return (
    <div className="fp">
      {message ? <div className={`fp-message fp-message--${message.tone}`}>{message.text}</div> : null}
      {groups.map((group) => (
        <ChargeGroup key={group.key} group={group} busy={busy} onAction={run} unmatched={unmatched} searching={searching} onSearchUnmatched={syncFamily} />
      ))}
      {showFooter ? (
        <div className="fp-footer">
          <button type="button" className="btn" disabled={busy} onClick={syncFamily}>{searching ? 'Conferindo…' : 'Atualizar pelo Asaas'}</button>
          {withoutCharge.length ? (charging ? (
            <div className="fp-charge">
              <span>Criar {new Set(withoutCharge.map((row) => row.due_date)).size} cobrança(s) no Asaas para {money(withoutCharge.reduce((sum, row) => sum + row.amount_cents, 0))}. O Asaas avisa a família por e-mail e SMS.</span>
              <select value={charging} onChange={(event) => setCharging(event.target.value)}>
                <option value="boleto">Boleto (com Pix)</option>
                <option value="pix">Pix</option>
                <option value="cartao">Cartão (até 3x, com taxa)</option>
              </select>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={async () => { if (await run('create_charges', { guardian_id: guardianId, method: charging }, 'Cobranças criadas no Asaas')) setCharging(null); }}>Criar cobranças</button>
              <button type="button" className="btn btn--ghost" onClick={() => setCharging(null)}>Cancelar</button>
            </div>
          ) : <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setCharging(['boleto', 'pix', 'cartao'].includes(withoutCharge[0].method) ? withoutCharge[0].method : 'boleto')}>Gerar cobranças no Asaas</button>) : null}
        </div>
      ) : null}
    </div>
  );
}
