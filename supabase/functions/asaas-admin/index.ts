import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// Ações do painel sobre o Asaas, só para a equipe logada:
// - sync: busca cada cobrança no Asaas e atualiza as parcelas (corrige webhook
//   perdido). Parcela sem cobrança é vinculada quando o valor bate com uma
//   cobrança do cliente (localizado pelo CPF) que ainda não está ligada a nada.
// - link / unlink: vínculo manual entre parcelas e uma cobrança do Asaas.
// - receive / undo: baixa feita pela secretaria; se a parcela tem cobrança no
//   Asaas, a baixa também é registrada lá (receiveInCash / undoReceivedInCash).
// - statement: saldo, extrato e transferências (saques) da conta Asaas.
// - customer / create_charges: cliente e cobranças geradas pelo painel.
// Toda mudança de parcela passa por finance_apply_installment, que grava o
// livro financeiro com a origem e quem fez.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
}

class AsaasError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
class UserError extends Error {}

type Asaas = (path: string, init?: RequestInit) => Promise<any>;

function asaasClient(baseUrl: string, apiKey: string): Asaas {
  return async (path, init = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "User-Agent": "cec-matriculas", access_token: apiKey, ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body?.errors?.map((item: { description?: string }) => item.description).filter(Boolean).join("; ");
      throw new AsaasError(detail || `Asaas respondeu ${response.status}`, response.status);
    }
    return body;
  };
}

type Installment = {
  id: string; enrollment_id: string; number: number; amount_cents: number; due_date: string;
  status: string; method: string | null; provider: string | null; provider_charge_id: string | null;
  paid_at: string | null; paid_amount_cents: number | null; paid_source: string | null; asaas_status: string | null;
  guardian_id: string; guardian_name: string; guardian_cpf: string | null; asaas_customer_id: string | null;
  student_name: string; campaign_id: string;
};

const BILLING_TYPE: Record<string, string> = { boleto: "BOLETO", pix: "PIX", cartao: "CREDIT_CARD" };
const METHOD_FROM_BILLING: Record<string, string> = { PIX: "pix", BOLETO: "boleto", CREDIT_CARD: "cartao", DEBIT_CARD: "cartao" };
const PAID = new Set(["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"]);
const REFUNDED = new Set(["REFUNDED", "REFUND_REQUESTED", "REFUND_IN_PROGRESS", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL"]);

function localStatusFor(payment: any): string | null {
  if (payment?.deleted) return "cancelado";
  const status = String(payment?.status || "");
  if (PAID.has(status)) return "pago";
  if (status === "OVERDUE") return "vencido";
  if (REFUNDED.has(status)) return "estornado";
  if (status === "PENDING" || status === "AWAITING_RISK_ANALYSIS") return "pendente";
  return null;
}

const cents = (value: unknown) => Math.round(Number(value || 0) * 100);
const reais = (value: number) => Math.round(value) / 100;
const noonBr = (day: string) => `${day}T12:00:00-03:00`;
const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

function money(value: number) {
  return (value / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function paymentSummary(payment: any) {
  return {
    id: payment.id, value_cents: cents(payment.value), net_value_cents: cents(payment.netValue), status: payment.status,
    deleted: Boolean(payment.deleted), billing_type: payment.billingType, due_date: payment.dueDate,
    payment_date: payment.clientPaymentDate || payment.paymentDate || payment.confirmedDate || null,
    description: payment.description || "", invoice_url: payment.invoiceUrl || null, bank_slip_url: payment.bankSlipUrl || null,
    installment: payment.installment || null, installment_number: payment.installmentNumber || null,
  };
}

// "Rua A, 120, Apto 2 - Centro, Nanuque/MG, CEP 39860-000" (AddressFields)
function splitAddress(value: string | null) {
  const match = String(value || "").match(/^(.+?), ([^,]+?)(?:, (.+?))? - (.+?), (.+?)\/([A-Z]{2}), CEP (\d{5}-?\d{3})$/);
  if (!match) return value ? { address: value } : {};
  const [, street, number, complement, district, , , cep] = match;
  return { address: street, addressNumber: number, complement: complement || undefined, province: district, postalCode: cep.replace(/\D/g, "") };
}

async function loadInstallments(supabase: SupabaseClient, filter: { guardianIds?: string[]; ids?: string[] }) {
  let query = supabase.from("v_installment_list")
    .select("id, enrollment_id, number, amount_cents, due_date, status, method, provider, provider_charge_id, paid_at, paid_amount_cents, paid_source, asaas_status, guardian_id, guardian_name, guardian_cpf, asaas_customer_id, student_name, campaign_id")
    .neq("status", "cancelado")
    .order("due_date");
  if (filter.ids?.length) query = query.in("id", filter.ids);
  if (filter.guardianIds?.length) query = query.in("guardian_id", filter.guardianIds);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as Installment[];
}

async function apply(supabase: SupabaseClient, id: string, patch: Record<string, unknown>, source: string, actor: string | null, note?: string) {
  const { error } = await supabase.rpc("finance_apply_installment", {
    p_installment_id: id, p_patch: patch, p_source: source, p_actor: actor, p_note: note || null,
  });
  if (error) throw error;
}

// Cliente do Asaas: o ID salvo se existir neste ambiente; senão, pelo CPF.
async function findCustomer(asaas: Asaas, supabase: SupabaseClient, guardian: { id: string; cpf: string | null; asaas_customer_id: string | null }) {
  let id = guardian.asaas_customer_id;
  if (id) {
    const saved = await asaas(`/customers/${id}`).catch(() => null);
    if (saved?.id && !saved.deleted) return { id, origin: "salvo" };
    id = null;
  }
  const cpf = String(guardian.cpf || "").replace(/\D/g, "");
  if (cpf.length !== 11) return { id: null, origin: "sem_cpf" };
  const found = await asaas(`/customers?cpfCnpj=${cpf}`);
  id = (found?.data || []).find((item: { deleted?: boolean }) => !item.deleted)?.id || null;
  if (id && id !== guardian.asaas_customer_id) {
    await supabase.from("guardians").update({ asaas_customer_id: id }).eq("id", guardian.id);
  }
  return { id, origin: id ? "localizado_pelo_cpf" : "nao_encontrado" };
}

async function listCustomerPayments(asaas: Asaas, customerId: string) {
  const all: any[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await asaas(`/payments?customer=${customerId}&limit=100&offset=${offset}`);
    all.push(...(page?.data || []));
    if (!page?.hasMore) break;
  }
  return all;
}

// Atualiza um grupo de parcelas (mesma cobrança) com o que o Asaas diz.
async function applyPayment(supabase: SupabaseClient, rows: Installment[], payment: any, actor: string | null, link: boolean) {
  const changes: any[] = [];
  const target = localStatusFor(payment);
  const now = new Date().toISOString();
  for (const row of rows) {
    const patch: Record<string, unknown> = { asaas_status: payment.deleted ? "DELETED" : payment.status, asaas_synced_at: now };
    if (link) {
      Object.assign(patch, {
        provider: "asaas", provider_charge_id: payment.id, payment_url: payment.invoiceUrl || null,
        bank_slip_url: payment.bankSlipUrl || null,
      });
    }
    let note: string | undefined;
    if (target === "cancelado") {
      // Cobrança apagada no Asaas: a parcela continua devida e fica livre para
      // uma nova cobrança. Se já estava vencida, segue a regra "venceu, já era".
      if (row.status === "pendente") {
        Object.assign(patch, { provider: null, provider_charge_id: null, payment_url: null, bank_slip_url: null, boleto_line: null, pix_code: null });
        note = "Cobrança apagada no Asaas; parcela liberada para nova cobrança";
        changes.push({ installment_id: row.id, student: row.student_name, number: row.number, action: "desvinculada", reason: "cobranca_apagada" });
      }
    } else if (target === "pago" && row.status !== "pago") {
      const day = String(payment.clientPaymentDate || payment.paymentDate || payment.confirmedDate || localToday()).slice(0, 10);
      Object.assign(patch, {
        status: "pago", paid_at: noonBr(day),
        paid_amount_cents: rows.length === 1 ? cents(payment.value) : row.amount_cents,
        paid_source: "asaas",
      });
      const method = payment.status === "RECEIVED_IN_CASH" ? null : METHOD_FROM_BILLING[payment.billingType];
      if (method) patch.method = method;
      changes.push({ installment_id: row.id, student: row.student_name, number: row.number, action: "pago", from: row.status });
    } else if (target && target !== "pago" && row.status === "pago") {
      if (row.paid_source === "manual" && target === "pendente") {
        // Baixa feita só no painel; o Asaas ainda acha que está em aberto.
        changes.push({ installment_id: row.id, student: row.student_name, number: row.number, action: "conflito", reason: "pago_no_painel_aberto_no_asaas" });
      } else if (target === "estornado" || (target === "pendente" && row.paid_source !== "manual")) {
        Object.assign(patch, { status: target, paid_at: null, paid_amount_cents: null });
        changes.push({ installment_id: row.id, student: row.student_name, number: row.number, action: target, from: row.status });
      }
    } else if (target && target !== row.status && row.status !== "pago" && target !== "pago") {
      patch.status = target;
      changes.push({ installment_id: row.id, student: row.student_name, number: row.number, action: target, from: row.status });
    }
    if (link && !changes.some((item) => item.installment_id === row.id)) {
      changes.push({ installment_id: row.id, student: row.student_name, number: row.number, action: "vinculada" });
    }
    await apply(supabase, row.id, patch, "asaas_sync", actor, note);
  }
  return changes;
}

async function syncGuardian(asaas: Asaas, supabase: SupabaseClient, rows: Installment[], linkedElsewhere: Set<string>, actor: string | null) {
  const first = rows[0];
  const report: any = { guardian_id: first.guardian_id, guardian_name: first.guardian_name, changes: [], unmatched_payments: [], errors: [] };
  const customer = await findCustomer(asaas, supabase, { id: first.guardian_id, cpf: first.guardian_cpf, asaas_customer_id: first.asaas_customer_id });
  report.customer_id = customer.id;
  report.customer_origin = customer.origin;
  const payments = customer.id ? await listCustomerPayments(asaas, customer.id) : [];
  const byId = new Map(payments.map((payment) => [payment.id, payment]));

  // 1) Parcelas já vinculadas: consulta cada cobrança.
  const linked = new Map<string, Installment[]>();
  for (const row of rows.filter((item) => item.provider_charge_id)) {
    linked.set(row.provider_charge_id!, [...(linked.get(row.provider_charge_id!) || []), row]);
  }
  for (const [chargeId, group] of linked) {
    try {
      const payment = byId.get(chargeId) || await asaas(`/payments/${chargeId}`).catch((error) => {
        if (error instanceof AsaasError && error.status === 404) return { id: chargeId, deleted: true };
        throw error;
      });
      report.changes.push(...await applyPayment(supabase, group, payment, actor, false));
    } catch (error) {
      report.errors.push({ charge_id: chargeId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // 2) Parcelas sem cobrança: vincula quando o valor bate sem ambiguidade.
  const free = payments.filter((payment) => !payment.deleted && !linkedElsewhere.has(payment.id) && !linked.has(payment.id));
  const open = rows.filter((item) => !item.provider_charge_id && ["pendente", "vencido"].includes(item.status));
  const groups = new Map<string, Installment[]>();
  for (const row of open) groups.set(row.due_date, [...(groups.get(row.due_date) || []), row]);
  const used = new Set<string>();
  const allOpenTotal = open.reduce((sum, row) => sum + row.amount_cents, 0);
  for (const payment of free) {
    const value = cents(payment.value);
    let candidates = [...groups.entries()].filter(([due, group]) => !used.has(due) && Math.abs(group.reduce((sum, row) => sum + row.amount_cents, 0) - value) <= 1);
    if (candidates.length > 1) {
      const sameDay = candidates.filter(([due]) => due === payment.dueDate);
      if (sameDay.length === 1) candidates = sameDay;
    }
    if (candidates.length === 1) {
      const [due, group] = candidates[0];
      used.add(due);
      report.changes.push(...await applyPayment(supabase, group, payment, actor, true));
    } else if (!candidates.length && open.length > 1 && used.size === 0 && Math.abs(allOpenTotal - value) <= 1) {
      // Uma cobrança só para tudo (ex.: pagou o ano inteiro de uma vez).
      for (const due of groups.keys()) used.add(due);
      report.changes.push(...await applyPayment(supabase, open, payment, actor, true));
    } else {
      report.unmatched_payments.push(paymentSummary(payment));
    }
  }
  report.payments_found = payments.length;
  return report;
}

async function sync(asaas: Asaas, supabase: SupabaseClient, guardianIds: string[] | undefined, actor: string | null) {
  const rows = await loadInstallments(supabase, { guardianIds });
  const { data: linkedRows, error } = await supabase.from("installments").select("provider_charge_id").not("provider_charge_id", "is", null);
  if (error) throw error;
  const byGuardian = new Map<string, Installment[]>();
  for (const row of rows) byGuardian.set(row.guardian_id, [...(byGuardian.get(row.guardian_id) || []), row]);
  const families: any[] = [];
  for (const [, group] of byGuardian) {
    const ownCharges = new Set(group.map((row) => row.provider_charge_id).filter(Boolean));
    const elsewhere = new Set((linkedRows || []).map((row) => row.provider_charge_id as string).filter((id) => !ownCharges.has(id)));
    try {
      families.push(await syncGuardian(asaas, supabase, group, elsewhere, actor));
    } catch (error) {
      families.push({ guardian_id: group[0].guardian_id, guardian_name: group[0].guardian_name, changes: [], unmatched_payments: [], errors: [{ message: error instanceof Error ? error.message : String(error) }] });
    }
  }
  return {
    synced_at: new Date().toISOString(),
    families,
    changed: families.reduce((sum, item) => sum + item.changes.filter((change: any) => change.action !== "conflito").length, 0),
    unmatched: families.reduce((sum, item) => sum + item.unmatched_payments.length, 0),
    errors: families.reduce((sum, item) => sum + item.errors.length, 0),
  };
}

async function link(asaas: Asaas, supabase: SupabaseClient, installmentIds: string[], paymentId: string, actor: string | null) {
  if (!installmentIds?.length || !paymentId) throw new UserError("Escolha as parcelas e a cobrança");
  const rows = await loadInstallments(supabase, { ids: installmentIds });
  if (new Set(rows.map((row) => row.guardian_id)).size !== 1) throw new UserError("As parcelas precisam ser da mesma família");
  const { data: taken } = await supabase.from("installments").select("id").eq("provider_charge_id", paymentId).not("id", "in", `(${installmentIds.join(",")})`);
  if (taken?.length) throw new UserError("Essa cobrança já está ligada a outra parcela");
  const payment = await asaas(`/payments/${paymentId}`);
  return applyPayment(supabase, rows, payment, actor, true);
}

async function unlink(supabase: SupabaseClient, installmentIds: string[], actor: string | null) {
  const rows = await loadInstallments(supabase, { ids: installmentIds });
  for (const row of rows) {
    await apply(supabase, row.id, {
      provider: null, provider_charge_id: null, payment_url: null, bank_slip_url: null, boleto_line: null, pix_code: null, asaas_status: null,
    }, "manual", actor, "Desvinculada pela equipe");
  }
  return { ok: true, count: rows.length };
}

async function receive(asaas: Asaas | null, supabase: SupabaseClient, body: any, actor: string | null) {
  const ids: string[] = body.installment_ids || [];
  const rows = (await loadInstallments(supabase, { ids })).filter((row) => row.status !== "pago");
  if (!rows.length) throw new UserError("Nenhuma parcela em aberto selecionada");
  const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.paid_on || "")) ? body.paid_on : localToday();
  const method = ["pix", "boleto", "cartao", "dinheiro"].includes(body.method) ? body.method : null;
  const single = rows.length === 1 && Number(body.amount_cents) > 0 ? Number(body.amount_cents) : null;
  const registerInAsaas = body.register_in_asaas !== false;
  const results: any[] = [];

  const byCharge = new Map<string, Installment[]>();
  for (const row of rows) {
    const key = row.provider_charge_id || `local:${row.id}`;
    byCharge.set(key, [...(byCharge.get(key) || []), row]);
  }
  for (const [key, group] of byCharge) {
    const linked = !key.startsWith("local:") && registerInAsaas && asaas;
    let paidSource = "manual";
    let payment: any = null;
    if (linked) {
      payment = await asaas(`/payments/${key}`);
      if (PAID.has(payment.status)) paidSource = "asaas";
      else if (!payment.deleted) paidSource = "asaas_manual";
    }
    // Grava a baixa antes de avisar o Asaas: o webhook que vem logo depois
    // encontra a parcela já paga e não repete aviso nem muda a origem.
    const apply1 = async (row: Installment) => apply(supabase, row.id, {
      status: "pago", paid_at: noonBr(paidOn), paid_amount_cents: single ?? row.amount_cents,
      ...(method ? { method } : {}), paid_source: paidSource,
      ...(paidSource !== "manual" ? { asaas_status: "RECEIVED_IN_CASH", asaas_synced_at: new Date().toISOString() } : {}),
    }, "manual", actor, body.note || null);
    for (const row of group) await apply1(row);
    if (paidSource === "asaas_manual") {
      try {
        const value = single ?? cents(payment.value);
        await asaas!(`/payments/${key}/receiveInCash`, {
          method: "POST",
          body: JSON.stringify({ paymentDate: paidOn, value: reais(value), notifyCustomer: false }),
        });
      } catch (error) {
        for (const row of group) {
          await apply(supabase, row.id, { status: row.status, paid_at: null, paid_amount_cents: null, asaas_status: payment.status }, "manual", actor, "Baixa revertida: o Asaas recusou o recebimento");
        }
        throw error;
      }
    }
    for (const row of group) results.push({ installment_id: row.id, paid_source: paidSource });
  }

  if (body.notify) {
    const first = rows[0];
    const total = single ?? rows.reduce((sum, row) => sum + row.amount_cents, 0);
    await supabase.from("message_queue").insert({
      campaign_id: first.campaign_id, guardian_id: first.guardian_id, enrollment_id: first.enrollment_id,
      body: `Recebemos o pagamento de *${money(total)}* ✅ Obrigado!`,
    });
  }
  return { ok: true, results };
}

async function undo(asaas: Asaas | null, supabase: SupabaseClient, installmentIds: string[], actor: string | null) {
  const rows = (await loadInstallments(supabase, { ids: installmentIds })).filter((row) => row.status === "pago");
  if (!rows.length) throw new UserError("Nenhuma parcela paga selecionada");
  if (rows.some((row) => row.paid_source === "asaas")) {
    throw new UserError("Esta parcela foi paga pelo Asaas (Pix, boleto ou cartão). O estorno precisa ser feito no painel do Asaas; depois é só sincronizar.");
  }
  // Primeiro o banco, depois o Asaas: o webhook "recebimento desfeito" que
  // chega em seguida encontra a parcela já em aberto.
  for (const row of rows) {
    await apply(supabase, row.id, {
      status: row.due_date < localToday() && row.provider_charge_id ? "vencido" : "pendente",
      paid_at: null, paid_amount_cents: null,
      ...(row.provider_charge_id ? { asaas_status: "PENDING", asaas_synced_at: new Date().toISOString() } : {}),
    }, "manual", actor, "Recebimento desfeito pela equipe");
  }
  const undone = new Set<string>();
  for (const row of rows) {
    if (row.paid_source === "asaas_manual" && row.provider_charge_id && asaas && !undone.has(row.provider_charge_id)) {
      undone.add(row.provider_charge_id);
      await asaas(`/payments/${row.provider_charge_id}/undoReceivedInCash`, { method: "POST" });
    }
  }
  return { ok: true, count: rows.length };
}

async function statement(asaas: Asaas, body: any) {
  const today = localToday();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(body.start || "")) ? body.start : `${today.slice(0, 8)}01`;
  const finish = /^\d{4}-\d{2}-\d{2}$/.test(String(body.finish || "")) ? body.finish : today;
  const offset = Math.max(0, Number(body.offset) || 0);
  const [balance, transactions, transfers] = await Promise.all([
    asaas("/finance/balance").catch(() => null),
    asaas(`/financialTransactions?startDate=${start}&finishDate=${finish}&offset=${offset}&limit=100&order=desc`),
    asaas(`/transfers?dateCreated[ge]=${start}&dateCreated[le]=${finish}&limit=100`).catch(() => ({ data: [] })),
  ]);
  return {
    start, finish,
    balance_cents: balance ? cents(balance.balance) : null,
    transactions: (transactions?.data || []).map((item: any) => ({
      id: item.id, date: item.date, type: item.type, description: item.description, value_cents: cents(item.value),
      balance_cents: cents(item.balance), payment_id: item.paymentId || null, transfer_id: item.transferId || null,
    })),
    has_more: Boolean(transactions?.hasMore),
    transfers: (transfers?.data || []).map((item: any) => ({
      id: item.id, date: item.effectiveDate || item.scheduleDate || item.dateCreated, status: item.status, type: item.type,
      value_cents: cents(item.value), net_value_cents: cents(item.netValue), fee_cents: cents(item.transferFee),
      description: item.description || item.bankAccount?.bank?.name || "", bank: item.bankAccount?.bank?.name || null,
      pix_key: item.bankAccount?.pixAddressKey || null,
    })),
  };
}

async function ensureCustomer(asaas: Asaas, supabase: SupabaseClient, guardianId: string) {
  const { data: guardian, error } = await supabase.from("guardians")
    .select("id, full_name, cpf, email, phone, address, asaas_customer_id").eq("id", guardianId).single();
  if (error) throw error;
  const cpf = String(guardian.cpf || "").replace(/\D/g, "");
  if (cpf.length !== 11) throw new UserError("O responsável precisa de CPF para ter cadastro no Asaas");
  const phone = String(guardian.phone || "").replace(/\D/g, "").replace(/^55/, "");
  const data = {
    name: guardian.full_name, cpfCnpj: cpf, email: guardian.email || undefined, mobilePhone: phone || undefined,
    externalReference: guardian.id, notificationDisabled: false, ...splitAddress(guardian.address),
  };
  const found = await findCustomer(asaas, supabase, guardian);
  let id = found.id;
  let origin = found.origin;
  if (id) {
    await asaas(`/customers/${id}`, { method: "PUT", body: JSON.stringify(data) }).catch((err) => console.error("Cliente não atualizado", err));
  } else {
    id = (await asaas("/customers", { method: "POST", body: JSON.stringify(data) })).id;
    origin = "criado";
  }
  if (id !== guardian.asaas_customer_id) await supabase.from("guardians").update({ asaas_customer_id: id }).eq("id", guardian.id);
  return { customer_id: id, origin };
}

// Cobranças pelo painel: uma por vencimento somando os irmãos; cartão vira
// parcelamento com a taxa repassada (card_total_cents). Só parcelas sem
// cobrança. Dinheiro não gera cobrança.
async function createCharges(asaas: Asaas, supabase: SupabaseClient, body: any, actor: string | null) {
  const guardianId = String(body.guardian_id || "");
  const rows = (await loadInstallments(supabase, { guardianIds: [guardianId] }))
    .filter((row) => row.status === "pendente" && !row.provider_charge_id);
  if (!rows.length) throw new UserError("Não há parcelas em aberto sem cobrança para esta família");
  const method = String(body.method || rows[0].method || "boleto");
  const billingType = BILLING_TYPE[method];
  if (!billingType) throw new UserError("Pagamento em dinheiro não gera cobrança no Asaas; use “Marcar como recebido”");
  const { customer_id: customerId } = await ensureCustomer(asaas, supabase, guardianId);
  const names = [...new Set(rows.map((row) => row.student_name.split(" ")[0]))];
  const groups = new Map<string, Installment[]>();
  for (const row of rows) groups.set(row.due_date, [...(groups.get(row.due_date) || []), row]);
  const dueDates = [...groups.keys()].sort();
  const today = localToday();
  const now = new Date().toISOString();
  const created: any[] = [];

  const save = async (due: string, payment: any, extra: Record<string, unknown> = {}) => {
    for (const row of groups.get(due)!) {
      await apply(supabase, row.id, {
        provider: "asaas", provider_charge_id: payment.id, payment_url: payment.invoiceUrl || null,
        bank_slip_url: payment.bankSlipUrl || null, method, asaas_status: payment.status || "PENDING", asaas_synced_at: now, ...extra,
      }, "manual", actor, "Cobrança gerada pelo painel");
    }
    created.push(paymentSummary(payment));
  };

  if (billingType === "CREDIT_CARD") {
    const net = rows.reduce((sum, row) => sum + row.amount_cents, 0);
    const count = Math.min(3, dueDates.length);
    const { data: total, error } = await supabase.rpc("card_total_cents", { p_net_cents: net, p_installments: count });
    if (error) throw error;
    const cardTotal = Number(total) || net;
    const first = await asaas("/payments", {
      method: "POST",
      body: JSON.stringify({
        customer: customerId, billingType,
        ...(count > 1 ? { installmentCount: count, totalValue: reais(cardTotal) } : { value: reais(cardTotal) }),
        dueDate: today,
        description: `CEC Matrícula 2027 — ${count > 1 ? `${count}x no cartão` : "cartão à vista"} (inclui taxa do cartão) — ${names.join(", ")}`,
        externalReference: guardianId,
      }),
    });
    const list = first.installment ? await asaas(`/payments?installment=${first.installment}&limit=20`) : { data: [first] };
    const payments = [...(list?.data || [])].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    for (let index = 0; index < dueDates.length; index += 1) {
      const payment = payments[Math.min(index, payments.length - 1)] || first;
      await save(dueDates[index], { ...payment, invoiceUrl: payment.invoiceUrl || first.invoiceUrl });
    }
  } else {
    for (let index = 0; index < dueDates.length; index += 1) {
      const due = dueDates[index];
      const value = groups.get(due)!.reduce((sum, row) => sum + row.amount_cents, 0);
      const payment = await asaas("/payments", {
        method: "POST",
        body: JSON.stringify({
          customer: customerId, billingType, value: reais(value), dueDate: due < today ? today : due,
          description: `CEC Matrícula 2027 — parcela ${index + 1}/${dueDates.length} — ${names.join(", ")}`,
          externalReference: guardianId,
        }),
      });
      const extra: Record<string, unknown> = {};
      if (billingType === "BOLETO") {
        extra.boleto_line = await asaas(`/payments/${payment.id}/identificationField`).then((res) => res?.identificationField || null).catch(() => null);
      }
      extra.pix_code = await asaas(`/payments/${payment.id}/pixQrCode`).then((res) => res?.payload || null).catch(() => null);
      await save(due, payment, extra);
    }
  }

  for (const enrollmentId of new Set(rows.map((row) => row.enrollment_id))) {
    await supabase.from("enrollment_events").insert({
      enrollment_id: enrollmentId, code: "PAYMENT_CHECKOUT_CREATED", title: "Cobrança gerada no Asaas",
      body: `Cobrança ${method} gerada pela equipe.`, actor: "equipe", actor_id: actor,
      metadata: { method, due_dates: dueDates, asaas_customer_id: customerId },
    });
  }
  return { ok: true, customer_id: customerId, charges: created };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Método não suportado" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return json({ error: "Configuração interna ausente" }, 500);
  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  // Só a equipe (perfil ativo).
  const jwt = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await supabase.auth.getUser(jwt);
  const actor = auth?.user?.id || null;
  if (!actor) return json({ error: "Entre novamente no painel" }, 401);
  const { data: profile } = await supabase.from("profiles").select("id").eq("id", actor).eq("active", true).maybeSingle();
  if (!profile) return json({ error: "Apenas a equipe pode usar o Asaas pelo painel" }, 403);

  const apiKey = Deno.env.get("ASAAS_API_KEY");
  const baseUrl = (Deno.env.get("ASAAS_BASE_URL") || "https://api.asaas.com/v3").replace(/\/$/, "");
  const asaas = apiKey ? asaasClient(baseUrl, apiKey) : null;
  const environment = baseUrl.includes("sandbox") ? "sandbox" : "producao";

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    if (action === "status") {
      if (!asaas) return json({ configured: false, environment });
      const balance = await asaas("/finance/balance").catch((error) => ({ error: error.message }));
      return json({ configured: true, environment, balance_cents: balance?.error ? null : cents(balance.balance), error: balance?.error || null });
    }
    // Baixa e estorno manuais funcionam mesmo sem a chave (só no painel).
    if (action === "receive") return json(await receive(asaas, supabase, body, actor));
    if (action === "undo") return json(await undo(asaas, supabase, body.installment_ids || [], actor));
    if (action === "unlink") return json(await unlink(supabase, body.installment_ids || [], actor));
    if (!asaas) return json({ error: "A chave do Asaas não está configurada no servidor", code: "asaas_not_configured" }, 503);
    if (action === "sync") return json({ environment, ...await sync(asaas, supabase, body.guardian_ids, actor) });
    if (action === "link") return json({ ok: true, changes: await link(asaas, supabase, body.installment_ids, body.payment_id, actor) });
    if (action === "statement") return json({ environment, ...await statement(asaas, body) });
    if (action === "customer") return json(await ensureCustomer(asaas, supabase, String(body.guardian_id || "")));
    if (action === "create_charges") return json(await createCharges(asaas, supabase, body, actor));
    return json({ error: "Ação desconhecida" }, 400);
  } catch (error) {
    console.error(error);
    if (error instanceof UserError) return json({ error: error.message }, 422);
    if (error instanceof AsaasError) return json({ error: `Asaas: ${error.message}` }, 502);
    return json({ error: error instanceof Error ? error.message : "Falha ao falar com o Asaas" }, 500);
  }
});
