import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Gera as cobranças da família no Asaas depois que ela assina e escolhe a
// forma de pagamento. Uma cobrança por vencimento cobre a parcela de todos os
// irmãos (o webhook baixa todas as parcelas ligadas àquela cobrança).
// Cartão (até 3x) vira uma cobrança parcelada do Asaas (installmentCount),
// com a taxa do cartão somada ao valor (card_fees): quem paga o parcelamento
// é a família. Boleto e Pix guardam PDF, linha digitável e Pix copia e cola
// para a página e a IA mandarem sem a família precisar abrir o Asaas.
// Idempotente: só cria cobrança para parcela sem provider_charge_id.
//
// Segredos: ASAAS_API_KEY e, opcionalmente, ASAAS_BASE_URL
// (padrão produção; sandbox: https://api-sandbox.asaas.com/v3).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
}

const BILLING_TYPE: Record<string, string> = { boleto: "BOLETO", pix: "PIX", cartao: "CREDIT_CARD" };

type Installment = { id: string; enrollment_id: string; amount_cents: number; due_date: string; method: string | null };

class AsaasError extends Error {}

function asaasClient(baseUrl: string, apiKey: string) {
  return async function call(path: string, init: RequestInit = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "User-Agent": "cec-matriculas", access_token: apiKey, ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body?.errors?.map((item: { description?: string }) => item.description).filter(Boolean).join("; ");
      throw new AsaasError(detail || `Asaas respondeu ${response.status}`);
    }
    return body;
  };
}

// "Rua A, 120, Apto 2 - Centro, Nanuque/MG, CEP 39860-000" (AddressFields)
function splitAddress(value: string | null) {
  const match = String(value || "").match(/^(.+?), ([^,]+?)(?:, (.+?))? - (.+?), (.+?)\/([A-Z]{2}), CEP (\d{5}-?\d{3})$/);
  if (!match) return value ? { address: value } : {};
  const [, street, number, complement, district, , , cep] = match;
  return { address: street, addressNumber: number, complement: complement || undefined, province: district, postalCode: cep.replace(/\D/g, "") };
}

function money(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function shortDate(value: string) {
  const [, month, day] = value.split("-");
  return `${day}/${month}`;
}

function localToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Método não suportado" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const apiKey = Deno.env.get("ASAAS_API_KEY");
  const baseUrl = (Deno.env.get("ASAAS_BASE_URL") || "https://api.asaas.com/v3").replace(/\/$/, "");
  if (!supabaseUrl || !serviceRole) return json({ error: "Configuração interna ausente" }, 500);
  if (!apiKey) {
    return json({ error: "O pagamento online ainda não foi ativado pela escola. Avisaremos por aqui e pelo WhatsApp.", code: "asaas_not_configured" }, 503);
  }

  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });
  const asaas = asaasClient(baseUrl, apiKey);

  try {
    const { token } = await request.json();
    if (typeof token !== "string" || token.length < 20) return json({ error: "Jornada inválida" }, 404);

    const { data: session, error: sessionError } = await supabase
      .from("enrollment_onboarding_sessions")
      .select("id, guardian_id, campaign_id, status, token, flow")
      .eq("token", token.trim())
      .neq("status", "cancelada")
      .maybeSingle();
    if (sessionError) throw sessionError;
    if (!session?.guardian_id) return json({ error: "Jornada inválida ou expirada" }, 404);

    const { data: stage } = await supabase.rpc("onboarding_stage", { p_session_id: session.id });
    if (stage !== "pagamento" && stage !== "concluida") return json({ error: "Escolha a forma de pagamento antes de gerar a cobrança" }, 409);

    const { data: items, error: itemsError } = await supabase
      .from("enrollment_onboarding_items")
      .select("enrollment_id, enrollments!inner(students!inner(full_name))")
      .eq("onboarding_session_id", session.id);
    if (itemsError) throw itemsError;
    const enrollmentIds = (items || []).map((item) => item.enrollment_id);
    const names = (items || []).map((item) => {
      const enrollment = item.enrollments as unknown as { students?: { full_name?: string } };
      return String(enrollment?.students?.full_name || "").split(" ")[0];
    }).filter(Boolean);

    const { data: pending, error: pendingError } = await supabase
      .from("installments")
      .select("id, enrollment_id, amount_cents, due_date, method")
      .in("enrollment_id", enrollmentIds)
      .eq("status", "pendente")
      .is("provider_charge_id", null)
      .order("due_date");
    if (pendingError) throw pendingError;

    // Dinheiro é pago na secretaria: não gera cobrança no Asaas.
    const cash = (pending || []).length > 0 && (pending as Installment[]).every((row) => row.method === "dinheiro");
    if ((pending || []).length && !cash) {
      const { data: guardian, error: guardianError } = await supabase
        .from("guardians")
        .select("id, full_name, cpf, email, phone, address, asaas_customer_id")
        .eq("id", session.guardian_id)
        .single();
      if (guardianError) throw guardianError;
      if (!guardian.cpf) return json({ error: "O CPF do responsável é necessário para gerar a cobrança" }, 422);

      // Cliente no Asaas: reaproveita o ID salvo se ele existir neste ambiente
      // (sandbox e produção têm IDs diferentes), senão localiza pelo CPF e só
      // então cria. Cliente encontrado recebe os dados atuais do responsável.
      const phone = String(guardian.phone || "").replace(/\D/g, "").replace(/^55/, "");
      const customerData = {
        name: guardian.full_name,
        cpfCnpj: String(guardian.cpf).replace(/\D/g, ""),
        email: guardian.email || undefined,
        mobilePhone: phone || undefined,
        externalReference: guardian.id,
        ...splitAddress(guardian.address),
      };
      let customerId = guardian.asaas_customer_id as string | null;
      let customerOrigin = "salvo";
      if (customerId) {
        const saved = await asaas(`/customers/${customerId}`).catch(() => null);
        if (!saved?.id || saved.deleted) customerId = null;
      }
      if (!customerId) {
        const found = await asaas(`/customers?cpfCnpj=${customerData.cpfCnpj}`);
        customerId = (found?.data || []).find((item: { deleted?: boolean }) => !item.deleted)?.id || null;
        customerOrigin = "localizado_pelo_cpf";
      }
      if (customerId) {
        await asaas(`/customers/${customerId}`, { method: "PUT", body: JSON.stringify(customerData) })
          .catch((error) => console.error("Não foi possível atualizar o cliente no Asaas", error));
      } else {
        const created = await asaas("/customers", { method: "POST", body: JSON.stringify(customerData) });
        customerId = created.id;
        customerOrigin = "criado";
      }
      console.log("Cliente Asaas", customerOrigin, customerId);
      if (customerId !== guardian.asaas_customer_id) {
        await supabase.from("guardians").update({ asaas_customer_id: customerId }).eq("id", guardian.id);
      }

      // Uma cobrança por vencimento, somando os irmãos.
      const groups = new Map<string, Installment[]>();
      for (const row of pending as Installment[]) groups.set(row.due_date, [...(groups.get(row.due_date) || []), row]);
      const dueDates = [...groups.keys()].sort();
      const method = (pending as Installment[])[0].method || "boleto";
      const billingType = BILLING_TYPE[method] || "BOLETO";
      const today = localToday();
      const description = (index: number) =>
        `CEC Matrícula 2027 — parcela ${index + 1}/${dueDates.length}${names.length ? ` — ${names.join(", ")}` : ""}`;
      const reais = (cents: number) => Math.round(cents) / 100;
      // Linha digitável e Pix: chamadas extras do Asaas. Se falharem, a
      // cobrança continua válida pelo invoiceUrl; só não sai o atalho.
      const paymentDetails = async (payment: { id: string; billingType?: string }) => {
        const details: { boleto_line?: string; pix_code?: string } = {};
        if (billingType === "BOLETO") {
          details.boleto_line = await asaas(`/payments/${payment.id}/identificationField`)
            .then((body) => body?.identificationField || undefined).catch(() => undefined);
        }
        if (billingType === "BOLETO" || billingType === "PIX") {
          details.pix_code = await asaas(`/payments/${payment.id}/pixQrCode`)
            .then((body) => body?.payload || undefined).catch(() => undefined);
        }
        return details;
      };
      const save = async (dueDate: string, payment: { id: string; invoiceUrl?: string; bankSlipUrl?: string }, details = {}) => {
        const ids = groups.get(dueDate)!.map((row) => row.id);
        const { error } = await supabase.from("installments")
          .update({
            provider: "asaas", provider_charge_id: payment.id, payment_url: payment.invoiceUrl || null,
            bank_slip_url: payment.bankSlipUrl || null, ...details,
          })
          .in("id", ids);
        if (error) throw error;
      };

      let cardTotal: number | null = null;
      if (billingType === "CREDIT_CARD") {
        const net = dueDates.reduce((sum, due) => sum + groups.get(due)!.reduce((acc, row) => acc + row.amount_cents, 0), 0);
        const count = Math.min(3, dueDates.length);
        const { data: total, error: feeError } = await supabase.rpc("card_total_cents", { p_net_cents: net, p_installments: count });
        if (feeError) throw feeError;
        cardTotal = Number(total) || net;
        const first = await asaas("/payments", {
          method: "POST",
          body: JSON.stringify({
            customer: customerId, billingType,
            ...(count > 1 ? { installmentCount: count, totalValue: reais(cardTotal) } : { value: reais(cardTotal) }),
            dueDate: today,
            description: `CEC Matrícula 2027 — ${count > 1 ? `${count}x no cartão` : "cartão à vista"} (inclui taxa do cartão)${names.length ? ` — ${names.join(", ")}` : ""}`,
            externalReference: session.id,
          }),
        });
        const list = first.installment ? await asaas(`/payments?installment=${first.installment}&limit=20`) : { data: [first] };
        const payments = [...(list?.data || [])].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
        for (let index = 0; index < dueDates.length; index += 1) {
          const payment = payments[Math.min(index, payments.length - 1)] || first;
          await save(dueDates[index], { id: payment.id, invoiceUrl: payment.invoiceUrl || first.invoiceUrl });
        }
      } else {
        for (let index = 0; index < dueDates.length; index += 1) {
          const due = dueDates[index];
          const value = groups.get(due)!.reduce((acc, row) => acc + row.amount_cents, 0);
          const payment = await asaas("/payments", {
            method: "POST",
            body: JSON.stringify({
              customer: customerId, billingType, value: reais(value),
              dueDate: due < today ? today : due,
              description: description(index),
              externalReference: session.id,
            }),
          });
          await save(due, payment, await paymentDetails(payment));
        }
      }

      // Aviso pelo WhatsApp via fila (nada vai direto para a UAZAPI): a
      // família recebe os vencimentos e o link da jornada, onde estão os
      // botões de pagar. Pelo chat, a IA manda o PDF ou o Pix quando pedirem.
      const journeyBase = (Deno.env.get("JOURNEY_BASE_URL") || "https://cecnanuque.com.br").replace(/\/$/, "");
      const lines = billingType === "CREDIT_CARD"
        ? [`💳 Cartão: *${money(cardTotal || 0)}*${dueDates.length > 1 ? ` em ${Math.min(3, dueDates.length)}x` : ""} (inclui a taxa do cartão).`]
        : dueDates.map((due, index) => {
          const value = groups.get(due)!.reduce((acc, row) => acc + row.amount_cents, 0);
          return `• ${dueDates.length > 1 ? `${index + 1}ª parcela` : "Parcela única"}: *${money(value)}* — vence ${shortDate(due < today ? today : due)}`;
        });
      const label = ({ BOLETO: "boleto", PIX: "Pix", CREDIT_CARD: "cartão" } as Record<string, string>)[billingType];
      await supabase.from("message_queue").insert({
        campaign_id: session.campaign_id,
        guardian_id: guardian.id,
        enrollment_id: enrollmentIds[0] || null,
        body: [
          `Sua cobrança no ${label} já está pronta ✅`,
          ...lines,
          `Para pagar, abra: ${journeyBase}/${session.flow === "rematricula" ? "rematricula" : "matricula"}?j=${encodeURIComponent(session.token)}&f=${session.flow || "matricula_nova"}`,
          billingType === "CREDIT_CARD" ? "" : `Se preferir, me peça aqui que eu mando o ${billingType === "PIX" ? "Pix copia e cola" : "boleto em PDF"}.`,
        ].filter(Boolean).join("\n"),
      }).then(({ error }) => { if (error) console.error("Falha ao enfileirar aviso de cobrança", error); });

      for (const enrollmentId of enrollmentIds) {
        await supabase.from("enrollment_events").insert({
          enrollment_id: enrollmentId, code: "PAYMENT_CHECKOUT_CREATED", title: "Cobrança gerada no Asaas",
          body: `Cobrança ${method} gerada para a família.`, actor: "sistema", metadata: { method, due_dates: dueDates, card_total_cents: cardTotal, asaas_customer_id: customerId, asaas_customer: customerOrigin },
        });
      }
    }

    const { data: charges, error: chargesError } = await supabase.rpc("onboarding_charges", { p_session_id: session.id });
    if (chargesError) throw chargesError;
    return json({ ok: true, charges });
  } catch (error) {
    console.error(error);
    if (error instanceof AsaasError) return json({ error: `O Asaas recusou a cobrança: ${error.message}` }, 502);
    return json({ error: "Não foi possível gerar a cobrança agora. Tente novamente em instantes." }, 500);
  }
});
