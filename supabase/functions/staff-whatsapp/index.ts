import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// WhatsApp pelo painel, só para a equipe logada:
// - suggest: a IA escreve uma sugestão de mensagem para a família, a partir do
//   cadastro, da etapa da jornada, das últimas mensagens e (se houver) do
//   levantamento do follow-up. Não envia nada.
// - send: envia o texto pela UAZAPI com o carimbo `cec_staff`. O agente trata
//   esse carimbo como eco (não pausa a IA nem duplica a mensagem). Quando o
//   número tem conversa no banco, a mensagem fica registrada nela.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const STAFF_TRACK_SOURCE = "cec_staff";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
}
class UserError extends Error {}

const digits = (value: unknown) => String(value || "").replace(/\D/g, "");
function e164(value: unknown) {
  let d = digits(value);
  if (!d) return "";
  if (!d.startsWith("55") && d.length <= 11) d = `55${d}`;
  // Celular BR salvo sem o nono dígito no WhatsApp (55 + DDD + 8 dígitos).
  if (d.startsWith("55") && d.length === 12 && /[6-9]/.test(d[4])) d = `${d.slice(0, 4)}9${d.slice(4)}`;
  return `+${d}`;
}

type Ctx = { supabase: SupabaseClient; actor: string; actorName: string };

async function findGuardian(supabase: SupabaseClient, guardianId?: string, phone?: string) {
  if (guardianId) {
    const { data } = await supabase.from("guardians").select("id, full_name, phone").eq("id", guardianId).maybeSingle();
    if (data) return data;
  }
  if (phone) {
    const { data } = await supabase.from("guardians").select("id, full_name, phone").eq("phone", e164(phone)).limit(1).maybeSingle();
    if (data) return data;
  }
  return null;
}

async function latestConversation(supabase: SupabaseClient, guardianId: string | null) {
  if (!guardianId) return null;
  const { data } = await supabase.from("conversations").select("id, handler, ai_summary")
    .eq("guardian_id", guardianId).order("last_message_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  return data;
}

async function familyContext(supabase: SupabaseClient, guardian: any) {
  if (!guardian) return null;
  const journeyBase = (Deno.env.get("JOURNEY_BASE_URL") || "https://cecnanuque.com.br").replace(/\/$/, "");
  const [{ data: links }, { data: sessions }, { data: enrollments }] = await Promise.all([
    supabase.from("student_guardians").select("students(full_name, classes:current_class_id(name))").eq("guardian_id", guardian.id),
    supabase.from("enrollment_onboarding_sessions").select("id, token, flow, status, updated_at").eq("guardian_id", guardian.id)
      .neq("status", "cancelada").order("updated_at", { ascending: false }).limit(1),
    supabase.from("enrollments").select("amount_cents, status, students(full_name), grades:target_grade_id(name), campaigns!inner(status, academic_year)")
      .eq("guardian_id", guardian.id).eq("campaigns.status", "ativa"),
  ]);
  const session = sessions?.[0] || null;
  let stage: string | null = null;
  if (session) {
    const { data } = await supabase.rpc("onboarding_stage", { p_session_id: session.id });
    stage = data || null;
  }
  return {
    responsavel: guardian.full_name,
    alunos: (links || []).map((row: any) => `${row.students?.full_name}${row.students?.classes?.name ? ` (hoje: ${row.students.classes.name})` : ""}`),
    matriculas_2027: (enrollments || []).map((row: any) => ({
      aluno: row.students?.full_name, serie_2027: row.grades?.name, valor: row.amount_cents ? `R$ ${(row.amount_cents / 100).toFixed(2).replace(".", ",")}` : null, status: row.status,
    })),
    etapa_da_jornada: stage,
    link_da_jornada: session?.token ? `${journeyBase}/${session.flow === "rematricula" ? "rematricula" : "matricula"}?j=${session.token}&f=${session.flow}` : null,
  };
}

async function suggest(ctx: Ctx, body: any) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new UserError("A IA ainda não está configurada no servidor (falta OPENAI_API_KEY no Supabase).");
  const model = Deno.env.get("OPENAI_TEXT_MODEL") || "gpt-4o-mini";
  const effort = Deno.env.get("OPENAI_REASONING_EFFORT");
  const phone = e164(body.phone);
  const guardian = await findGuardian(ctx.supabase, body.guardian_id, phone);
  const conversation = await latestConversation(ctx.supabase, guardian?.id || null);
  const family = await familyContext(ctx.supabase, guardian);

  let history: string[] = [];
  if (conversation) {
    const { data } = await ctx.supabase.from("messages").select("sender, body, media_type, created_at")
      .eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(30);
    history = (data || []).reverse().map((m: any) => `[${new Date(m.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}] ${m.sender === "responsavel" ? "FAMÍLIA" : m.sender === "ia" ? "IA DA ESCOLA" : "SECRETARIA"}: ${m.body || `(${m.media_type || "mídia"})`}`);
  }
  const { data: review } = await ctx.supabase.from("debug_followup_review").select("resumo, parou_em, pendencia, contato_whatsapp, alunos_hint, transcript")
    .eq("phone", phone).order("gerado_em", { ascending: false }).limit(1).maybeSingle();
  if (!history.length && review?.transcript?.length) {
    history = review.transcript.slice(-30).map((m: any) => `[${new Date(m.t).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}] ${m.de === "familia" ? "FAMÍLIA" : m.de === "ia" ? "IA DA ESCOLA" : "SECRETARIA"}: ${m.texto || `(${m.tipo})`}`);
  }

  const purpose = body.purpose === "rematricula" ? "convidar a família a fazer ou concluir a rematrícula 2027 (use o link da jornada se existir)" : "retomar a conversa de onde parou (follow-up)";
  const system = [
    "Você escreve mensagens de WhatsApp em nome da secretaria do CEC (Centro Educacional Cristão), uma escola em Nanuque/MG.",
    "Tom: caloroso, simples, educado, como uma secretária de escola do interior. Português do Brasil. Frases curtas. No máximo 1 ou 2 emojis.",
    "Formatação de WhatsApp: *negrito* com um asterisco. Sem markdown de títulos ou listas longas.",
    "Regras: use SOMENTE os dados fornecidos. Nunca invente valores, descontos, datas ou promessas. Não confirme desconto que não esteja nos dados.",
    "Se a família fez uma pergunta que ficou sem resposta e a resposta não está nos dados, reconheça a demora, diga que vai verificar e peça só o que falta.",
    "Se faltar o nome do aluno, peça. Não mencione que existe uma IA nem 'sistema'. Não assine com nome de pessoa.",
    "Responda apenas com o texto da mensagem, pronto para enviar.",
  ].join("\n");
  const user = [
    `Objetivo: ${purpose}.`,
    body.instruction ? `Orientação da atendente: ${String(body.instruction).slice(0, 600)}` : "",
    `Hoje: ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}. A condição especial de rematrícula vale até 31/10/2026.`,
    `Contato no WhatsApp: ${review?.contato_whatsapp || "(desconhecido)"} · telefone ${phone}`,
    family ? `Cadastro: ${JSON.stringify(family)}` : "Este número não tem cadastro na base.",
    review ? `Levantamento da equipe — o que aconteceu: ${review.resumo}\nOnde parou: ${review.parou_em}\nO que falta: ${review.pendencia}${review.alunos_hint ? `\nAlunos achados pelo nome: ${review.alunos_hint}` : ""}` : "",
    history.length ? `Últimas mensagens:\n${history.join("\n")}` : "Não há mensagens anteriores.",
  ].filter(Boolean).join("\n\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], ...(effort ? { reasoning_effort: effort } : {}) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI respondeu ${response.status}`);
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("A IA não devolveu texto.");
  return { text, model, used_history: history.length, has_family: Boolean(family) };
}

async function send(ctx: Ctx, body: any) {
  const base = (Deno.env.get("UAZAPI_BASE_URL") || "").replace(/\/$/, "");
  const token = Deno.env.get("UAZAPI_TOKEN");
  if (!base || !token) throw new UserError("O envio pelo sistema ainda não está configurado (faltam UAZAPI_BASE_URL e UAZAPI_TOKEN no Supabase).");
  const phone = e164(body.phone);
  const text = String(body.text || "").trim();
  if (!phone || phone.length < 12) throw new UserError("Telefone inválido.");
  if (!text) throw new UserError("A mensagem está vazia.");
  if (text.length > 4000) throw new UserError("Mensagem longa demais.");

  const guardian = await findGuardian(ctx.supabase, body.guardian_id, phone);
  const conversation = await latestConversation(ctx.supabase, guardian?.id || null);
  const trackId = crypto.randomUUID();
  let messageId: string | null = null;
  if (conversation) {
    const { data, error } = await ctx.supabase.from("messages").insert({
      conversation_id: conversation.id, direction: "saida", sender: "equipe", staff_id: ctx.actor, body: text,
      status: "na_fila", track_source: STAFF_TRACK_SOURCE, track_id: trackId,
    }).select("id").single();
    if (error) throw new Error(`Não foi possível registrar a mensagem: ${error.message}`);
    messageId = data.id;
  }

  const response = await fetch(`${base}/send/text`, {
    method: "POST",
    headers: { token, "Content-Type": "application/json" },
    body: JSON.stringify({
      number: digits(phone), text, readchat: true, linkPreview: false,
      delay: Math.min(6000, 1200 + text.length * 25), track_source: STAFF_TRACK_SOURCE, track_id: trackId,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (messageId) await ctx.supabase.from("messages").update({ status: "falhou", error: JSON.stringify(result || response.status).slice(0, 500) }).eq("id", messageId);
    throw new Error(result?.error || result?.message || `UAZAPI respondeu ${response.status}`);
  }
  const providerId = result?.messageid || result?.id || result?.key?.id || null;
  if (messageId) await ctx.supabase.from("messages").update({ status: "enviada", sent_at: new Date().toISOString(), provider_message_id: providerId }).eq("id", messageId);
  return { ok: true, logged: Boolean(messageId), provider_message_id: providerId, sent_by: ctx.actorName };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Método não suportado" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return json({ error: "Configuração interna ausente" }, 500);
  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const jwt = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await supabase.auth.getUser(jwt);
  const actor = auth?.user?.id || null;
  if (!actor) return json({ error: "Entre novamente no painel" }, 401);
  const { data: profile } = await supabase.from("profiles").select("id, full_name").eq("id", actor).eq("active", true).maybeSingle();
  if (!profile) return json({ error: "Apenas a equipe pode usar o WhatsApp pelo painel" }, 403);
  const ctx: Ctx = { supabase, actor, actorName: profile.full_name || "" };

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    if (action === "status") return json({ ai: Boolean(Deno.env.get("OPENAI_API_KEY")), send: Boolean(Deno.env.get("UAZAPI_BASE_URL") && Deno.env.get("UAZAPI_TOKEN")) });
    if (action === "suggest") return json(await suggest(ctx, body));
    if (action === "send") return json(await send(ctx, body));
    return json({ error: "Ação desconhecida" }, 400);
  } catch (error) {
    console.error(error);
    if (error instanceof UserError) return json({ error: error.message }, 400);
    return json({ error: (error as Error).message || "Erro inesperado" }, 502);
  }
});
