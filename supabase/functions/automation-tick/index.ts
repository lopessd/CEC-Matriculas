import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// Automação de contato da rematrícula (aba Automação do painel).
//
// O pg_cron chama esta função a cada minuto (`automation_cron()`), só com a
// automação ligada e dentro do horário. Cada chamada envia NO MÁXIMO uma
// mensagem: `automation_pick()` decide se pode (horário, intervalo sorteado,
// tetos por hora e por dia) e para quem, e reserva o envio. Aqui só se manda
// pela UAZAPI, com o "digitando…", e se devolve o resultado.
//
// A equipe logada também usa esta função pelo painel:
// - status: a UAZAPI está configurada e conectada?
// - test: manda para um número da equipe o texto que uma família receberia,
//   marcado como teste. Nunca manda para a família.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-automation-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const QUEUE_TRACK_SOURCE = "cec_queue";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
}

function uazapi() {
  const base = (Deno.env.get("UAZAPI_BASE_URL") || "").replace(/\/$/, "");
  const token = Deno.env.get("UAZAPI_TOKEN") || "";
  return base && token ? { base, token } : null;
}

// Mesmo critério do agente (services/whatsapp.py, is_healthy): o campo
// estruturado `status.connected` manda; o resto é plano B.
async function whatsappConnected(api: { base: string; token: string }) {
  try {
    const response = await fetch(`${api.base}/instance/status`, { headers: { token: api.token } });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) return false;
    const status = data.status;
    if (status && typeof status === "object" && typeof status.connected === "boolean") return status.connected && !status.resetting;
    const explicit = data.instance?.status;
    if (typeof explicit === "string") return ["connected", "open", "online"].includes(explicit.trim().toLowerCase());
    const blob = JSON.stringify(data).toLowerCase();
    if (["disconnected", "close", "qrcode", "banned"].some((bad) => blob.includes(bad))) return false;
    return ["connected", "open", "online"].some((good) => blob.includes(good));
  } catch {
    return false;
  }
}

async function sendText(api: { base: string; token: string }, number: string, text: string, delay: number, trackId: string) {
  const response = await fetch(`${api.base}/send/text`, {
    method: "POST",
    headers: { token: api.token, "Content-Type": "application/json" },
    body: JSON.stringify({
      number, text, delay, readchat: true, linkPreview: false,
      track_source: QUEUE_TRACK_SOURCE, track_id: trackId,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || result?.message || `UAZAPI respondeu ${response.status}`);
  return String(result?.messageid || result?.id || result?.key?.id || "");
}

async function tick(supabase: SupabaseClient) {
  const api = uazapi();
  if (!api) {
    await supabase.rpc("automation_pause", { p_reason: "Faltam UAZAPI_BASE_URL e UAZAPI_TOKEN nos segredos do Supabase." });
    return { action: "wait", reason: "envio_nao_configurado" };
  }
  if (!(await whatsappConnected(api))) {
    const result = { action: "wait", reason: "whatsapp_desconectado" };
    await supabase.from("automation_settings").update({ last_tick_at: new Date().toISOString(), last_tick_result: result }).eq("id", 1);
    return result;
  }

  const { data: pick, error } = await supabase.rpc("automation_pick");
  if (error) throw new Error(error.message);
  if (pick?.action !== "send") return pick;

  try {
    const providerId = await sendText(api, pick.number, pick.body, pick.delay_ms, pick.track_id);
    await supabase.rpc("automation_result", { p_queue_id: pick.queue_id, p_ok: true, p_provider_id: providerId || null, p_error: null });
    return { action: "sent", guardian: pick.guardian, template: pick.template, touch: pick.touch };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.rpc("automation_result", { p_queue_id: pick.queue_id, p_ok: false, p_provider_id: null, p_error: message.slice(0, 500) });
    return { action: "failed", guardian: pick.guardian, error: message };
  }
}

async function staffAction(supabase: SupabaseClient, request: Request) {
  const jwt = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await supabase.auth.getUser(jwt);
  const actor = auth?.user?.id;
  if (!actor) return json({ error: "Entre novamente no painel" }, 401);
  const { data: profile } = await supabase.from("profiles").select("id").eq("id", actor).eq("active", true).maybeSingle();
  if (!profile) return json({ error: "Apenas a equipe pode usar a automação" }, 403);

  const body = await request.json().catch(() => ({}));
  const api = uazapi();
  if (body.action === "status") {
    return json({ configured: Boolean(api), connected: api ? await whatsappConnected(api) : false });
  }
  if (body.action === "test") {
    if (!api) return json({ error: "O envio ainda não está configurado (faltam UAZAPI_BASE_URL e UAZAPI_TOKEN no Supabase)." }, 400);
    let number = String(body.phone || "").replace(/\D/g, "");
    if (number.length <= 11) number = `55${number}`;
    if (number.length < 12) return json({ error: "Telefone inválido." }, 400);
    const text = String(body.text || "").trim();
    if (!text) return json({ error: "Sem texto para testar." }, 400);
    try {
      const id = await sendText(api, number, `[TESTE da automação — esta mensagem iria para uma família]\n\n${text}`,
        Math.min(9000, 2500 + text.length * 15), crypto.randomUUID());
      return json({ ok: true, provider_message_id: id });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }
  return json({ error: "Ação desconhecida" }, 400);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Método não suportado" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return json({ error: "Configuração interna ausente" }, 500);
  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const cronToken = request.headers.get("x-automation-token");
  if (cronToken) {
    const { data: settings } = await supabase.from("automation_settings").select("cron_token").eq("id", 1).maybeSingle();
    if (!settings || settings.cron_token !== cronToken) return json({ error: "Token inválido" }, 401);
    try {
      return json(await tick(supabase));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
  return await staffAction(supabase, request);
});
