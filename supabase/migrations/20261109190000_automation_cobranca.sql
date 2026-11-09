-- Automação: modo Cobrança.
--
-- A mesma automação (horário, intervalo sorteado, tetos por hora e por dia,
-- pg_cron e Edge Function `automation-tick`) ganha um segundo modo. Em
-- "cobranca", em vez de convidar para a rematrícula, ela manda para cada
-- família a cobrança do Asaas que vence nos próximos `billing_lead_days` dias:
-- boleto vai com o PDF anexo e a linha digitável no texto; Pix vai com o
-- copia e cola. Cartão não entra (o Asaas debita sozinho).
--
-- Uma mensagem por cobrança (irmãos já somam numa cobrança só). O que já foi
-- tentado para aquela cobrança (enviado, enviando ou falhou) não volta.
-- Quando a forma foi definida pela escola (`billing_chosen_by = 'escola'` no
-- contexto da jornada), o texto ganha um parágrafo oferecendo a troca.

alter table public.automation_settings add column if not exists mode text not null default 'contato';
alter table public.automation_settings add column if not exists billing_lead_days integer not null default 5;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'automation_settings_mode_check') then
    alter table public.automation_settings add constraint automation_settings_mode_check check (mode in ('contato', 'cobranca'));
  end if;
end $c$;

alter table public.message_queue add column if not exists ref text;
create index if not exists message_queue_origin_ref_idx on public.message_queue (origin, ref);

-- ── Textos ──────────────────────────────────────────────────────────────

insert into public.automation_templates (key, label, sort, body) values
('cobranca_boleto', 'Cobrança: boleto (vai com o PDF anexo)', 10,
$t$Oi, {{responsavel}}! Tudo bem? 😊

Aqui é da secretaria do CEC. Referente à rematrícula 2027 de {{alunos}}, estou te enviando o boleto da {{parcela}}, no valor de {{valor}}, com vencimento {{vencimento}}.

{{ajuste}}

Linha digitável:
{{linha}}

Se já tiver pago, é só desconsiderar. Qualquer dúvida, me chama por aqui 💙
---
Olá, {{responsavel}}, tudo bem?

Aqui é do CEC. Segue em anexo o boleto da rematrícula 2027 de {{alunos}}: {{parcela}}, no valor de {{valor}}, com vencimento {{vencimento}}.

{{ajuste}}

Se preferir copiar o código:
{{linha}}

Caso já tenha pago, pode desconsiderar esta mensagem. Estamos à disposição! 😊
---
Oi, {{responsavel}}! Aqui é da secretaria do CEC 💙

Estou te mandando o boleto referente à rematrícula 2027 de {{alunos}}. É a {{parcela}}, no valor de {{valor}}, e vence {{vencimento}}.

{{ajuste}}

Código do boleto:
{{linha}}

Se já tiver pago, desconsidere. Qualquer dúvida, é só responder aqui.$t$),
('cobranca_pix', 'Cobrança: Pix', 11,
$t$Oi, {{responsavel}}! Tudo bem? 😊

Aqui é da secretaria do CEC. Referente à rematrícula 2027 de {{alunos}}, segue o Pix do pagamento à vista, no valor de {{valor}}, com vencimento {{vencimento}}.

{{ajuste}}

Pix copia e cola:
{{pix}}

Se já tiver pago, é só desconsiderar. Qualquer dúvida, me chama por aqui 💙
---
Olá, {{responsavel}}, tudo bem?

Aqui é do CEC. Estou te enviando o Pix da rematrícula 2027 de {{alunos}}: pagamento à vista de {{valor}}, com vencimento {{vencimento}}.

{{ajuste}}

Código Pix (copia e cola):
{{pix}}

Caso já tenha pago, pode desconsiderar. Estamos à disposição! 😊$t$),
('cobranca_ajuste_boleto', 'Cobrança: parágrafo quando a escola escolheu boleto', 12,
$t$Como a forma de pagamento não tinha sido escolhida no site, deixamos no boleto, que é o mais prático pra quem parcela. Se preferir pagar no cartão ou quiser ajustar alguma coisa, é só me responder aqui que a gente resolve.$t$),
('cobranca_ajuste_pix', 'Cobrança: parágrafo quando a escola escolheu Pix', 13,
$t$Como a forma de pagamento não tinha sido escolhida no site, deixamos no Pix, que combina com o pagamento à vista. Se preferir boleto ou cartão, é só me avisar por aqui que a gente troca.$t$)
on conflict (key) do nothing;

create or replace function public.money_brl(p_cents bigint)
returns text language sql immutable set search_path to '' as $$
  select 'R$ ' || translate(to_char(coalesce(p_cents, 0) / 100.0, 'FM999G999G990D00'), ',.', '.,')
$$;

create or replace function public.billing_render(
  p_key text, p_seed text, p_name text, p_students text, p_parcela text, p_cents bigint,
  p_due date, p_line text, p_pix text, p_link text, p_school_chose boolean)
returns text language plpgsql stable set search_path to '' as $$
declare v_body text; v_parts text[]; v_text text; v_adj text; v_today date := public.local_today(); v_due text;
begin
  select body into v_body from public.automation_templates where key = p_key;
  if v_body is null then return null; end if;
  v_parts := regexp_split_to_array(v_body, '\n-{3,}\n');
  v_text := v_parts[1 + (abs(hashtext(p_seed || p_key)) % array_length(v_parts, 1))];
  if p_school_chose then
    select body into v_adj from public.automation_templates
     where key = case when p_key = 'cobranca_pix' then 'cobranca_ajuste_pix' else 'cobranca_ajuste_boleto' end;
  end if;
  v_due := case
    when p_due < v_today then to_char(p_due, 'DD/MM')
    when p_due = v_today then 'hoje, ' || to_char(p_due, 'DD/MM')
    when p_due = v_today + 1 then 'amanhã, ' || to_char(p_due, 'DD/MM')
    else to_char(p_due, 'DD/MM') end;
  v_text := replace(v_text, '{{responsavel}}', coalesce(p_name, 'família'));
  v_text := replace(v_text, '{{alunos}}', coalesce(p_students, 'seu filho'));
  v_text := replace(v_text, '{{parcela}}', coalesce(p_parcela, 'parcela'));
  v_text := replace(v_text, '{{valor}}', public.money_brl(p_cents));
  v_text := replace(v_text, '{{vencimento}}', v_due);
  v_text := replace(v_text, '{{linha}}', coalesce(p_line, ''));
  v_text := replace(v_text, '{{pix}}', coalesce(p_pix, ''));
  v_text := replace(v_text, '{{link}}', coalesce(p_link, ''));
  v_text := replace(v_text, '{{ajuste}}', coalesce(btrim(v_adj), ''));
  v_text := regexp_replace(v_text, '^família,', 'Família,');
  v_text := regexp_replace(v_text, '\n[ \t]*\n([ \t]*\n)+', E'\n\n', 'g');
  return btrim(v_text);
end $$;

-- ── Quem recebe: uma linha por cobrança do Asaas ────────────────────────

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
           i.number as n, i.bank_slip_url, i.boleto_line, i.pix_code, i.payment_url,
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
           max(bank_slip_url) as slip, max(boleto_line) as line, max(pix_code) as pix, max(payment_url) as url,
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
        when ch.m = 'pix' and ch.pix is null then 'sem_pix'
        when ch.m <> 'pix' and (ch.slip is null or ch.line is null) then 'sem_boleto'
      end as why
      from charges ch join public.guardians g on g.id = ch.gid
  )
  select j.cid, j.gid, j.gname, j.gphone, j.names, j.due, j.cents, j.m, j.parc, j.chose,
         case when j.m = 'pix' then null else j.slip end, j.url, j.tkey, j.why,
         public.billing_render(j.tkey, j.gid::text, public.automation_first_name(j.gname), j.names, j.parc, j.cents,
                               j.due, j.line, j.pix, j.url, j.chose)
    from judged j
   order by (j.why is null) desc, j.due, j.gname;
end $$;
revoke all on function public.billing_candidates() from public, anon, authenticated;

-- Os tetos por hora e por dia valem para os dois modos somados.
create or replace function public.automation_sent_counts()
returns table (today integer, last_hour integer, failed_today integer)
language sql stable security definer set search_path to '' as $$
  select
    count(*) filter (where q.status = 'enviada' and q.sent_at >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'))::int,
    count(*) filter (where q.status = 'enviada' and q.sent_at >= now() - interval '1 hour')::int,
    count(*) filter (where q.status = 'falhou' and q.updated_at >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'))::int
  from public.message_queue q where q.origin in ('automacao', 'cobranca')
$$;
revoke all on function public.automation_sent_counts() from public, anon, authenticated;

-- ── Reserva do próximo envio ────────────────────────────────────────────

create or replace function public.automation_pick()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_set public.automation_settings; v_c record; v_b record; v_counts record; v_campaign uuid;
  v_conv uuid; v_msg uuid; v_queue uuid; v_track uuid; v_gap integer; v_result jsonb;
  v_gid uuid; v_body text; v_origin text; v_ref text; v_attempt integer;
begin
  if not pg_try_advisory_xact_lock(hashtext('cec_automation_pick')) then
    return jsonb_build_object('action', 'wait', 'reason', 'outra_rodada');
  end if;
  select * into v_set from public.automation_settings where id = 1 for update;

  v_result := case
    when not v_set.enabled then jsonb_build_object('action', 'wait', 'reason', 'desligada')
    when not public.automation_in_window(v_set) then jsonb_build_object('action', 'wait', 'reason', 'fora_do_horario')
    when v_set.next_send_after is not null and v_set.next_send_after > now()
      then jsonb_build_object('action', 'wait', 'reason', 'intervalo', 'next', v_set.next_send_after)
    when exists (select 1 from public.message_queue q where q.origin in ('automacao', 'cobranca') and q.status = 'processando'
                  and q.locked_at > now() - interval '5 minutes')
      then jsonb_build_object('action', 'wait', 'reason', 'enviando')
  end;
  if v_result is null then
    select * into v_counts from public.automation_sent_counts();
    if v_counts.today >= v_set.daily_cap then
      v_result := jsonb_build_object('action', 'wait', 'reason', 'limite_do_dia');
    elsif v_counts.last_hour >= v_set.hourly_cap then
      v_result := jsonb_build_object('action', 'wait', 'reason', 'limite_da_hora');
    end if;
  end if;
  if v_result is not null then
    update public.automation_settings set last_tick_at = now(), last_tick_result = v_result where id = 1;
    return v_result;
  end if;

  if v_set.mode = 'cobranca' then
    select * into v_b from public.billing_candidates() b where b.block is null and b.body is not null limit 1;
    if not found then
      v_result := jsonb_build_object('action', 'wait', 'reason', 'ninguem_para_cobrar');
      update public.automation_settings set last_tick_at = now(), last_tick_result = v_result where id = 1;
      return v_result;
    end if;
    v_gid := v_b.guardian_id; v_body := v_b.body; v_origin := 'cobranca'; v_ref := v_b.charge_id; v_attempt := 1;
  else
    select * into v_c from public.automation_candidates() c where c.block is null and c.body is not null limit 1;
    if not found then
      v_result := jsonb_build_object('action', 'wait', 'reason', 'ninguem_para_contatar');
      update public.automation_settings set last_tick_at = now(), last_tick_result = v_result where id = 1;
      return v_result;
    end if;
    v_gid := v_c.guardian_id; v_body := v_c.body; v_origin := 'automacao'; v_ref := null; v_attempt := v_c.touches + 1;
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
  if v_origin = 'cobranca' then
    v_result := jsonb_build_object(
      'action', 'send', 'queue_id', v_queue, 'message_id', v_msg, 'track_id', v_track,
      'number', regexp_replace(v_b.phone, '\D', '', 'g'), 'body', v_body,
      'delay_ms', least(9000, 2500 + length(v_body) * 15 + floor(random() * 1500)::int),
      'guardian', v_b.guardian_name, 'template', v_b.template_key, 'touch', 1,
      'charge_id', v_b.charge_id, 'due_date', v_b.due_date,
      'media_url', v_b.media_url,
      'doc_name', case when v_b.media_url is not null then 'Boleto CEC ' || to_char(v_b.due_date, 'DD-MM-YYYY') || '.pdf' end);
  else
    v_result := jsonb_build_object(
      'action', 'send', 'queue_id', v_queue, 'message_id', v_msg, 'track_id', v_track,
      'number', regexp_replace(v_c.phone, '\D', '', 'g'), 'body', v_body,
      'delay_ms', least(9000, 2500 + length(v_body) * 15 + floor(random() * 1500)::int),
      'guardian', v_c.guardian_name, 'template', v_c.template_key, 'touch', v_c.touches + 1);
  end if;
  update public.automation_settings
     set next_send_after = now() + make_interval(secs => v_gap), last_tick_at = now(),
         last_tick_result = v_result - 'body'
   where id = 1;
  return v_result;
end $$;
revoke all on function public.automation_pick() from public, anon, authenticated;

-- ── Painel ──────────────────────────────────────────────────────────────

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
          'parcela', parcela, 'school_chose', school_chose, 'has_pdf', media_url is not null, 'media_url', media_url,
          'block', block, 'body', body)), '[]'::jsonb) from cand),
      'recent', (select coalesce(jsonb_agg(r order by r->>'at' desc), '[]'::jsonb) from (
          select jsonb_build_object(
            'queue_id', q.id, 'at', coalesce(q.sent_at, q.updated_at), 'status', q.status,
            'error', q.last_error, 'name', g.full_name, 'phone', g.phone, 'guardian_id', g.id, 'body', q.body,
            'replied', exists (select 1 from public.messages m join public.conversations cv on cv.id = m.conversation_id
                                where cv.guardian_id = g.id and m.direction = 'entrada' and m.created_at > q.sent_at)) as r
            from public.message_queue q join public.guardians g on g.id = q.guardian_id
           where q.origin = 'cobranca'
           order by coalesce(q.sent_at, q.updated_at) desc limit 120) rr)
    ) from (select 1) one
  );
end $$;

create or replace function public.staff_automation_set_mode(p_mode text, p_lead_days integer default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  if not public.is_staff() then raise exception 'Apenas a equipe' using errcode = '42501'; end if;
  if p_mode not in ('contato', 'cobranca') then raise exception 'Modo inválido'; end if;
  if p_lead_days is not null and p_lead_days not between 0 and 45 then raise exception 'Dias antes do vencimento: de 0 a 45'; end if;
  update public.automation_settings
     set mode = p_mode, billing_lead_days = coalesce(p_lead_days, billing_lead_days),
         -- Trocar de modo desliga: a equipe confere a lista nova antes de ligar.
         enabled = case when mode is distinct from p_mode then false else enabled end,
         updated_at = now(), updated_by = auth.uid()
   where id = 1;
  return public.staff_billing_overview();
end $$;

-- Tirar (ou devolver) uma cobrança da lista de envio.
create or replace function public.staff_billing_skip(p_charge_id text, p_skip boolean default true)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gid uuid;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe' using errcode = '42501'; end if;
  if p_skip then
    select e.guardian_id into v_gid from public.installments i join public.enrollments e on e.id = i.enrollment_id
     where i.provider_charge_id = p_charge_id limit 1;
    if v_gid is null then raise exception 'Cobrança não encontrada'; end if;
    if not exists (select 1 from public.message_queue where origin = 'cobranca' and ref = p_charge_id and status = 'cancelada') then
      insert into public.message_queue (campaign_id, guardian_id, attempt_number, body, status, origin, ref, last_error, scheduled_for)
      values ((select id from public.campaigns where kind::text = 'rematricula' and status::text = 'ativa' order by starts_on desc limit 1),
              v_gid, 1, '(tirada da cobrança pela equipe)', 'cancelada', 'cobranca', p_charge_id, 'Tirada pela equipe', now());
    end if;
  else
    update public.message_queue set status = 'falhou', origin = 'cobranca_desfeita'
     where origin = 'cobranca' and ref = p_charge_id and status = 'cancelada';
  end if;
  return public.staff_billing_overview();
end $$;
