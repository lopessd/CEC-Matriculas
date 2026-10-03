import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

function sameToken(received: string, expected: string) {
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method !== "GET") return json({ error: "Método não suportado" }, 405);

  const token = Deno.env.get("KEEP_ALIVE_TOKEN");
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !url || !serviceRole) return json({ error: "Função não configurada" }, 503);

  const authorization = request.headers.get("Authorization") || "";
  const received = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!sameToken(received, token)) return json({ error: "Não autorizado" }, 401);

  try {
    const supabase = createClient(url, serviceRole, { auth: { persistSession: false } });
    // A consulta real ao Postgres é necessária: só iniciar a Edge Function
    // não demonstra atividade no banco para a política de pausa do Free Plan.
    const { error } = await supabase.from("campaigns").select("id").limit(1);
    if (error) throw error;
    return json({ ok: true, checked_at: new Date().toISOString() });
  } catch (error) {
    console.error("keep-alive: database query failed", error);
    return json({ ok: false, error: "Consulta ao banco falhou" }, 503);
  }
});
