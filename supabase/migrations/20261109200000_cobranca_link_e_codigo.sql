-- Cobrança: link de pagamento no texto e o código numa 2ª mensagem.
--
-- 1ª mensagem: o texto com o link da fatura do Asaas (lá a família vê o
-- boleto, baixa o PDF ou paga no Pix). 2ª mensagem, logo depois: só a linha
-- digitável (ou o Pix copia e cola), para copiar sem levar texto junto.
-- Não precisa anexar PDF, então funciona com a `automation-tick` já publicada.
--
-- O código sai como `origin = 'cobranca_codigo'`, com o mesmo `ref` da
-- cobrança. Ele não conta nos tetos (é parte do mesmo contato) e passa na
-- frente de qualquer família nova.

update public.automation_templates set body = $t$Oi, {{responsavel}}! Tudo bem? 😊

Aqui é da secretaria do CEC. Referente à rematrícula 2027 de {{alunos}}, estou te enviando o boleto da {{parcela}}, no valor de {{valor}}, com vencimento {{vencimento}}.

É só abrir o link pra ver o boleto ou pagar no Pix:
{{link}}

{{ajuste}}

Logo abaixo te mando o código do boleto, pra facilitar na hora de copiar. Se já tiver pago, é só desconsiderar 💙
---
Olá, {{responsavel}}, tudo bem?

Aqui é do CEC. Segue o boleto da rematrícula 2027 de {{alunos}}: {{parcela}}, no valor de {{valor}}, com vencimento {{vencimento}}.

Pelo link você vê o boleto, baixa o PDF ou paga no Pix:
{{link}}

{{ajuste}}

Na próxima mensagem vai o código do boleto, pra copiar e colar no app do banco. Caso já tenha pago, pode desconsiderar 😊
---
Oi, {{responsavel}}! Aqui é da secretaria do CEC 💙

Estou te mandando o boleto referente à rematrícula 2027 de {{alunos}}. É a {{parcela}}, no valor de {{valor}}, e vence {{vencimento}}.

Link pra pagar (boleto ou Pix):
{{link}}

{{ajuste}}

Abaixo vai o código do boleto. Se já tiver pago, desconsidere. Qualquer dúvida, é só responder aqui.$t$,
  label = 'Cobrança: boleto (link no texto, código na mensagem seguinte)', updated_at = now()
 where key = 'cobranca_boleto';

update public.automation_templates set body = $t$Oi, {{responsavel}}! Tudo bem? 😊

Aqui é da secretaria do CEC. Referente à rematrícula 2027 de {{alunos}}, segue o pagamento à vista no Pix, no valor de {{valor}}, com vencimento {{vencimento}}.

Pelo link dá pra pagar com o QR Code:
{{link}}

{{ajuste}}

Logo abaixo te mando o Pix copia e cola. Se já tiver pago, é só desconsiderar 💙
---
Olá, {{responsavel}}, tudo bem?

Aqui é do CEC. Estou te enviando o Pix da rematrícula 2027 de {{alunos}}: pagamento à vista de {{valor}}, com vencimento {{vencimento}}.

Link do pagamento:
{{link}}

{{ajuste}}

Na próxima mensagem vai o código Pix copia e cola. Caso já tenha pago, pode desconsiderar 😊$t$,
  label = 'Cobrança: Pix (link no texto, copia e cola na mensagem seguinte)', updated_at = now()
 where key = 'cobranca_pix';

-- Mesma assinatura: só muda a regra de "sem boleto" (agora pede link e
-- linha digitável) e o anexo, que deixa de existir.
create or replace function public.billing_candidates()
returns table (
  charge_id text, guardian_id uuid, guardian_name text, phone text, students text,
  due_date date, amount_cents bigint, method text, parcela text, school_chose boolean,
  media_url text, link text, template_key text, block text, body text)
language plpgsql stable security definer set search_path to '' as $$
#variable_conflict use_column
declare v_set public.automation_settings; v_today date := public.local_today();
begin
  select * into v_set from public.automation_settings where id = 1;
  return query
  with ins as (
    select i.provider_charge_id as cid, i.due_date as due, i.amount_cents as cents, i.method::text as m,
           i.number as n, i.boleto_line, i.pix_code, i.payment_url,
           e.id as eid, e.guardian_id as gid, st.full_name as sname,
           exists (select 1 from public.enrollment_onboarding_items oi
                     join public.enrollment_onboarding_sessions s on s.id = oi.onboarding_session_id
                    where oi.enrollment_id = e.id and s.context->>'billing_chosen_by' = 'escola') as chose1,
           (select count(*) from public.installments i2 where i2.enrollment_id = e.id
              and i2.status <> 'cancelado' and i2.number < 1000) as total
      from public.installments i
      join public.enrollments e on e.id = i.enrollment_id
      join public.campaigns c on c.id = e.campaign_id
       and c.academic_year = (select max(c2.academic_year) from public.campaigns c2 where c2.status::text = 'ativa')
      join public.students st on st.id = e.student_id
     where i.status = 'pendente' and i.provider_charge_id is not null and i.number < 1000
       and coalesce(i.method::text, 'boleto') in ('boleto', 'pix')
       and i.due_date between v_today and v_today + v_set.billing_lead_days
  ),
  charges as (
    select cid, min(due) as due, sum(cents)::bigint as cents, min(m) as m, min(n) as n, max(total) as total,
           (array_agg(gid))[1] as gid,
           max(boleto_line) as line, max(pix_code) as pix, max(payment_url) as url,
           public.pt_join(array_agg(distinct initcap(lower(split_part(sname, ' ', 1))))) as names,
           bool_or(chose1) as chose
      from ins group by cid
  ),
  judged as (
    select ch.*, g.full_name as gname, g.phone as gphone,
      case when ch.m = 'pix' then 'cobranca_pix' else 'cobranca_boleto' end as tkey,
      case when ch.total <= 1 then 'parcela única' else ch.n || 'ª parcela (de ' || ch.total || ')' end as parc,
      case
        when g.phone is null or length(regexp_replace(g.phone, '\D', '', 'g')) < 12 then 'sem_telefone'
        when g.opted_out_at is not null then 'pediu_para_sair'
        when exists (select 1 from public.message_queue q where q.origin = 'cobranca' and q.ref = ch.cid
                      and q.status in ('enviada', 'processando', 'falhou')) then 'ja_avisado'
        when exists (select 1 from public.message_queue q where q.origin = 'cobranca' and q.ref = ch.cid
                      and q.status = 'cancelada') then 'tirada_pela_equipe'
        when ch.url is null then 'sem_link'
        when ch.m = 'pix' and ch.pix is null then 'sem_pix'
        when ch.m <> 'pix' and ch.line is null then 'sem_boleto'
      end as why
      from charges ch join public.guardians g on g.id = ch.gid
  )
  select j.cid, j.gid, j.gname, j.gphone, j.names, j.due, j.cents, j.m, j.parc, j.chose,
         null::text, j.url, j.tkey, j.why,
         public.billing_render(j.tkey, j.gid::text, public.automation_first_name(j.gname), j.names, j.parc, j.cents,
                               j.due, j.line, j.pix, j.url, j.chose)
    from judged j
   order by (j.why is null) desc, j.due, j.gname;
end $$;
revoke all on function public.billing_candidates() from public, anon, authenticated;

-- Código que vai sozinho na 2ª mensagem.
create or replace function public.billing_code(p_charge_id text)
returns text language sql stable security definer set search_path to '' as $$
  select case when bool_or(i.method::text = 'pix') then max(i.pix_code) else max(i.boleto_line) end
    from public.installments i where i.provider_charge_id = p_charge_id
$$;
revoke all on function public.billing_code(text) from public, anon, authenticated;

create or replace function public.automation_pick()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_set public.automation_settings; v_c record; v_b record; v_counts record; v_campaign uuid;
  v_conv uuid; v_msg uuid; v_queue uuid; v_track uuid; v_gap integer; v_result jsonb;
  v_gid uuid; v_body text; v_origin text; v_ref text; v_attempt integer; v_number text; v_name text;
  v_tpl text; v_pend record;
begin
  if not pg_try_advisory_xact_lock(hashtext('cec_automation_pick')) then
    return jsonb_build_object('action', 'wait', 'reason', 'outra_rodada');
  end if;
  select * into v_set from public.automation_settings where id = 1 for update;

  v_result := case
    when not v_set.enabled then jsonb_build_object('action', 'wait', 'reason', 'desligada')
    when exists (select 1 from public.message_queue q where q.origin in ('automacao', 'cobranca', 'cobranca_codigo')
                  and q.status = 'processando' and q.locked_at > now() - interval '5 minutes')
      then jsonb_build_object('action', 'wait', 'reason', 'enviando')
  end;

  -- O código de uma cobrança que acabou de sair vai antes de tudo, mesmo no
  -- fim do horário ou com o teto da hora batido: é o mesmo contato.
  if v_result is null then
    select q.ref, q.guardian_id, regexp_replace(g.phone, '\D', '', 'g') as number, g.full_name, q.attempt_number
      into v_pend
      from public.message_queue q join public.guardians g on g.id = q.guardian_id
     where q.origin = 'cobranca' and q.status = 'enviada' and q.sent_at > now() - interval '3 hours'
       and not exists (select 1 from public.message_queue q2 where q2.origin = 'cobranca_codigo' and q2.ref = q.ref)
     order by q.sent_at limit 1;
    if found then
      v_body := public.billing_code(v_pend.ref);
      if v_body is not null then
        v_gid := v_pend.guardian_id; v_origin := 'cobranca_codigo'; v_ref := v_pend.ref; v_attempt := 1;
        v_number := v_pend.number; v_name := v_pend.full_name; v_tpl := 'cobranca_codigo';
      end if;
    end if;
  end if;

  if v_result is null and v_origin is null then
    v_result := case
      when not public.automation_in_window(v_set) then jsonb_build_object('action', 'wait', 'reason', 'fora_do_horario')
      when v_set.next_send_after is not null and v_set.next_send_after > now()
        then jsonb_build_object('action', 'wait', 'reason', 'intervalo', 'next', v_set.next_send_after)
    end;
    if v_result is null then
      select * into v_counts from public.automation_sent_counts();
      if v_counts.today >= v_set.daily_cap then
        v_result := jsonb_build_object('action', 'wait', 'reason', 'limite_do_dia');
      elsif v_counts.last_hour >= v_set.hourly_cap then
        v_result := jsonb_build_object('action', 'wait', 'reason', 'limite_da_hora');
      end if;
    end if;
  end if;
  if v_result is not null then
    update public.automation_settings set last_tick_at = now(), last_tick_result = v_result where id = 1;
    return v_result;
  end if;

  if v_origin is null and v_set.mode = 'cobranca' then
    select * into v_b from public.billing_candidates() b where b.block is null and b.body is not null limit 1;
    if not found then
      v_result := jsonb_build_object('action', 'wait', 'reason', 'ninguem_para_cobrar');
      update public.automation_settings set last_tick_at = now(), last_tick_result = v_result where id = 1;
      return v_result;
    end if;
    v_gid := v_b.guardian_id; v_body := v_b.body; v_origin := 'cobranca'; v_ref := v_b.charge_id; v_attempt := 1;
    v_number := regexp_replace(v_b.phone, '\D', '', 'g'); v_name := v_b.guardian_name; v_tpl := v_b.template_key;
  elsif v_origin is null then
    select * into v_c from public.automation_candidates() c where c.block is null and c.body is not null limit 1;
    if not found then
      v_result := jsonb_build_object('action', 'wait', 'reason', 'ninguem_para_contatar');
      update public.automation_settings set last_tick_at = now(), last_tick_result = v_result where id = 1;
      return v_result;
    end if;
    v_gid := v_c.guardian_id; v_body := v_c.body; v_origin := 'automacao'; v_ref := null; v_attempt := v_c.touches + 1;
    v_number := regexp_replace(v_c.phone, '\D', '', 'g'); v_name := v_c.guardian_name; v_tpl := v_c.template_key;
  end if;

  select id into v_campaign from public.campaigns
   where kind::text = 'rematricula' and status::text = 'ativa' order by starts_on desc limit 1;

  insert into public.conversations (guardian_id, handler) values (v_gid, 'ia')
  on conflict (guardian_id) do nothing;
  select id into v_conv from public.conversations where guardian_id = v_gid;

  v_track := gen_random_uuid();
  insert into public.messages (conversation_id, direction, sender, body, status, track_source, track_id)
  values (v_conv, 'saida', 'ia', v_body, 'na_fila', 'cec_queue', v_track)
  returning id into v_msg;

  insert into public.message_queue (campaign_id, guardian_id, attempt_number, body, status, locked_at, origin, ref, message_id, scheduled_for)
  values (v_campaign, v_gid, v_attempt, v_body, 'processando', now(), v_origin, v_ref, v_msg, now())
  returning id into v_queue;

  v_gap := v_set.min_gap_seconds + floor(random() * (greatest(v_set.max_gap_seconds, v_set.min_gap_seconds) - v_set.min_gap_seconds + 1))::int;
  v_result := jsonb_build_object(
    'action', 'send', 'queue_id', v_queue, 'message_id', v_msg, 'track_id', v_track,
    'number', v_number, 'body', v_body,
    'delay_ms', case when v_origin = 'cobranca_codigo' then 1500
                     else least(9000, 2500 + length(v_body) * 15 + floor(random() * 1500)::int) end,
    'guardian', v_name, 'template', v_tpl, 'touch', v_attempt, 'charge_id', v_ref);
  update public.automation_settings
     -- Depois da cobrança, só uns segundos: o próximo minuto do cron já manda o código.
     set next_send_after = case when v_origin = 'cobranca' then now() + interval '10 seconds'
                                else now() + make_interval(secs => v_gap) end,
         last_tick_at = now(),
         last_tick_result = v_result - 'body'
   where id = 1;
  return v_result;
end $$;
revoke all on function public.automation_pick() from public, anon, authenticated;

-- Painel: mostra o código que vai na 2ª mensagem e o histórico com os dois envios.
create or replace function public.staff_billing_overview()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_set public.automation_settings; v_counts record;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe' using errcode = '42501'; end if;
  select * into v_set from public.automation_settings where id = 1;
  select * into v_counts from public.automation_sent_counts();
  return (
    with cand as (select * from public.billing_candidates())
    select jsonb_build_object(
      'settings', to_jsonb(v_set) - 'cron_token',
      'in_window', public.automation_in_window(v_set),
      'today', public.local_today(),
      'counts', jsonb_build_object('today', v_counts.today, 'last_hour', v_counts.last_hour, 'failed_today', v_counts.failed_today),
      'templates', (select coalesce(jsonb_agg(to_jsonb(t) - 'updated_by' order by t.sort), '[]'::jsonb)
                      from public.automation_templates t where t.key like 'cobranca%'),
      'eligible', (select count(*) from cand where block is null),
      'by_block', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
          select coalesce(block, 'pode_receber') k, count(*) n from cand group by 1) x),
      'candidates', (select coalesce(jsonb_agg(jsonb_build_object(
          'charge_id', charge_id, 'guardian_id', guardian_id, 'name', guardian_name, 'phone', phone,
          'students', students, 'due_date', due_date, 'amount_cents', amount_cents, 'method', method,
          'parcela', parcela, 'school_chose', school_chose, 'link', link,
          'code', public.billing_code(charge_id),
          'block', block, 'body', body)), '[]'::jsonb) from cand),
      'recent', (select coalesce(jsonb_agg(r order by r->>'at' desc), '[]'::jsonb) from (
          select jsonb_build_object(
            'queue_id', q.id, 'at', coalesce(q.sent_at, q.updated_at), 'status', q.status,
            'error', q.last_error, 'name', g.full_name, 'phone', g.phone, 'guardian_id', g.id, 'body', q.body,
            'code_status', (select q2.status from public.message_queue q2 where q2.origin = 'cobranca_codigo' and q2.ref = q.ref
                             order by q2.created_at desc limit 1),
            'replied', exists (select 1 from public.messages m join public.conversations cv on cv.id = m.conversation_id
                                where cv.guardian_id = g.id and m.direction = 'entrada' and m.created_at > q.sent_at)) as r
            from public.message_queue q join public.guardians g on g.id = q.guardian_id
           where q.origin = 'cobranca'
           order by coalesce(q.sent_at, q.updated_at) desc limit 120) rr)
    ) from (select 1) one
  );
end $$;

-- O cron também acorda fora do horário quando há um código para mandar
-- (cobrança que saiu no último minuto da janela).
create or replace function public.automation_cron()
returns void language plpgsql security definer set search_path to '' as $$
declare v_set public.automation_settings; v_code boolean;
begin
  select * into v_set from public.automation_settings where id = 1;
  if not v_set.enabled then return; end if;
  v_code := exists (select 1 from public.message_queue q
                     where q.origin = 'cobranca' and q.status = 'enviada' and q.sent_at > now() - interval '3 hours'
                       and not exists (select 1 from public.message_queue q2 where q2.origin = 'cobranca_codigo' and q2.ref = q.ref));
  if not v_code then
    if not public.automation_in_window(v_set) then return; end if;
    if v_set.next_send_after is not null and v_set.next_send_after > now() + interval '20 seconds' then return; end if;
  end if;
  perform net.http_post(
    url := 'https://uczxuaaojixapkdlayph.supabase.co/functions/v1/automation-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-automation-token', v_set.cron_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
end $$;
revoke all on function public.automation_cron() from public, anon, authenticated;
