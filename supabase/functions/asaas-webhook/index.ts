import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

type AsaasPayment = {
  id?: unknown;
  value?: unknown;
};

type AsaasEvent = {
  id?: unknown;
  event?: unknown;
  payment?: AsaasPayment;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function tokenMatches(received: string | null, expected: string) {
  if (!received || received.length !== expected.length) return false;

  // Compara todos os caracteres antes de decidir, reduzindo informação útil
  // para tentativas de descobrir o token por tempo de resposta.
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function money(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function shortDate(value: string) {
  const [, month, day] = String(value).split("-");
  return `${day}/${month}`;
}

// Cancela a cobrança vencida no Asaas. Falha aqui não derruba o webhook: a
// parcela já ficou "vencida" no nosso banco e o erro fica no log.
async function cancelAtAsaas(paymentId: string) {
  const apiKey = Deno.env.get("ASAAS_API_KEY");
  if (!apiKey) return;
  const baseUrl = (Deno.env.get("ASAAS_BASE_URL") || "https://api.asaas.com/v3").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/payments/${paymentId}`, {
    method: "DELETE",
    headers: { "User-Agent": "cec-matriculas", access_token: apiKey },
  }).catch((error) => { console.error("Falha ao cancelar cobrança vencida", error); return null; });
  if (response && !response.ok) console.error("Asaas recusou cancelar a cobrança vencida", paymentId, response.status);
}

function paymentStatusFor(eventName: string) {
  switch (eventName) {
    case "PAYMENT_RECEIVED":
    case "PAYMENT_CONFIRMED":
      return "pago";
    case "PAYMENT_OVERDUE":
      return "vencido";
    case "PAYMENT_REFUNDED":
      return "estornado";
    // Baixa em dinheiro desfeita: a parcela volta a ficar em aberto.
    case "PAYMENT_RECEIVED_IN_CASH_UNDONE":
      return "pendente";
    case "PAYMENT_DELETED":
      return "cancelado";
    default:
      return null;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Método não suportado" }, 405);

  const webhookToken = Deno.env.get("ASAAS_WEBHOOK_AUTH_TOKEN");
  if (!webhookToken || !tokenMatches(request.headers.get("asaas-access-token"), webhookToken)) {
    return json({ error: "Não autorizado" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) {
    console.error("Configuração do Supabase indisponível para o webhook Asaas.");
    return json({ error: "Integração indisponível" }, 503);
  }

  let payload: AsaasEvent;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const eventName = typeof payload.event === "string" ? payload.event : "";
  const paymentId = typeof payload.payment?.id === "string" ? payload.payment.id : "";
  if (!eventName || !paymentId) return json({ error: "Evento de pagamento inválido" }, 400);

  // O Asaas reenvia eventos no modelo "at least once". Quando disponível,
  // o id do evento é a chave de idempotência; o fallback mantém compatibilidade
  // com cargas antigas que não o incluam.
  const eventId = typeof payload.id === "string" ? payload.id : `${eventName}:${paymentId}`;
  const externalId = `asaas:${eventId}`;
  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  try {
    const { data: alreadyReceived, error: duplicateError } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("source", "pagamento")
      .eq("external_id", externalId)
      .maybeSingle();
    if (duplicateError) throw duplicateError;
    if (alreadyReceived) return json({ ok: true, status: "duplicado" });

    const { data: webhookEvent, error: insertError } = await supabase
      .from("webhook_events")
      .insert({
        source: "pagamento",
        event_type: `asaas.${eventName}`,
        external_id: externalId,
        payload,
        status: "recebido",
        attempts: 1,
      })
      .select("id")
      .single();
    if (insertError) {
      // A restrição única também protege contra duas entregas simultâneas.
      if (insertError.code === "23505") return json({ ok: true, status: "duplicado" });
      throw insertError;
    }

    // Uma cobrança do Asaas pode cobrir a parcela de vários irmãos (mesmo
    // vencimento). Todas as parcelas ligadas a ela mudam juntas.
    const { data: installments, error: installmentError } = await supabase
      .from("installments")
      .select("id, status, amount_cents, due_date, enrollment_id, enrollments!inner(guardian_id, campaign_id)")
      .eq("provider", "asaas")
      .eq("provider_charge_id", paymentId);
    if (installmentError) throw installmentError;

    const targetStatus = paymentStatusFor(eventName);
    let outcome = "registrado";
    let applied = 0;

    if (!installments?.length) {
      outcome = "cobranca_nao_localizada";
    } else if (targetStatus) {
      for (const installment of installments) {
        // Um atraso recebido tardiamente não pode desfazer uma baixa já confirmada.
        if (targetStatus === "vencido" && installment.status !== "pendente") continue;
        // CONFIRMED e depois RECEIVED (cartão): a segunda chegada não repete o aviso.
        if (targetStatus === installment.status) continue;
        // O cancelamento que nós mesmos pedimos ao vencer não apaga o "vencido".
        if (targetStatus === "cancelado" && installment.status === "vencido") continue;
        if (targetStatus === "pendente" && installment.status !== "pago") continue;
        const update: Record<string, unknown> = { status: targetStatus };
        if (targetStatus === "pendente") {
          update.paid_amount_cents = null;
          update.paid_at = null;
        }
        if (targetStatus === "pago") {
          update.paid_amount_cents = installment.amount_cents;
          update.paid_at = new Date().toISOString();
        }
        const { error: updateError } = await supabase.from("installments").update(update).eq("id", installment.id);
        if (updateError) throw updateError;
        applied += 1;
      }
      outcome = applied ? "parcela_atualizada" : "evento_obsoleto";
    }

    if (applied && installments?.length && (targetStatus === "vencido" || targetStatus === "pago")) {
      const first = installments[0] as unknown as {
        enrollment_id: string; due_date: string;
        enrollments: { guardian_id: string; campaign_id: string };
      };
      const total = installments.reduce((sum, item) => sum + item.amount_cents, 0);
      const enrollmentIds = [...new Set(installments.map((item) => item.enrollment_id))];

      if (targetStatus === "vencido") {
        // Sem multa nem juros: venceu, a cobrança é cancelada no Asaas para
        // não ser paga depois. A secretaria decide o que fazer com a vaga.
        await cancelAtAsaas(paymentId);
      }

      // Restam parcelas em aberto para estas matrículas?
      const { count: open } = await supabase.from("installments")
        .select("id", { count: "exact", head: true })
        .in("enrollment_id", enrollmentIds)
        .in("status", ["pendente", "vencido"]);

      const body = targetStatus === "pago"
        ? (open ? `Recebemos o pagamento de *${money(total)}* ✅ Obrigado!\nAs próximas parcelas seguem na página da jornada.`
          : `Recebemos o pagamento de *${money(total)}* ✅\nEstá tudo certo com a matrícula para 2027. Bem-vindos ao CEC! 🎉`)
        : `A cobrança de *${money(total)}* que vencia em ${shortDate(first.due_date)} não foi paga e foi cancelada.\nSe ainda quiser garantir a vaga, me responda aqui que a secretaria te ajuda.`;
      await supabase.from("message_queue").insert({
        campaign_id: first.enrollments.campaign_id,
        guardian_id: first.enrollments.guardian_id,
        enrollment_id: first.enrollment_id,
        body,
      }).then(({ error }) => { if (error) console.error("Falha ao enfileirar aviso de pagamento", error); });

      for (const enrollmentId of enrollmentIds) {
        await supabase.from("enrollment_events").insert({
          enrollment_id: enrollmentId,
          code: targetStatus === "pago" ? "PAYMENT_RECEIVED" : "PAYMENT_OVERDUE_CANCELLED",
          title: targetStatus === "pago" ? "Pagamento confirmado" : "Cobrança vencida e cancelada",
          body: `${money(total)} — Asaas ${paymentId}`,
          actor: "sistema",
          metadata: { provider_charge_id: paymentId, event: eventName },
        });
      }
    }

    const { error: processedError } = await supabase
      .from("webhook_events")
      .update({ status: "processado", processed_at: new Date().toISOString(), last_error: null })
      .eq("id", webhookEvent.id);
    if (processedError) throw processedError;

    return json({ ok: true, status: outcome });
  } catch (error) {
    console.error("Falha no webhook Asaas", error);
    return json({ error: "Não foi possível processar o evento de pagamento" }, 500);
  }
});
