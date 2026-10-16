-- Automação de contato da rematrícula (aba Automação do painel).
--
-- Uma família por vez, dentro do horário, com intervalo sorteado entre os
-- envios e tetos por hora e por dia. A decisão de QUEM recebe e QUANDO fica
-- aqui; a Edge Function `automation-tick` só envia o que `automation_pick()`
-- reservou e devolve o resultado em `automation_result()`. O pg_cron chama a
-- função a cada minuto, só quando a automação está ligada pela equipe no
-- painel (nasce desligada).
--
-- Os itens vão para `message_queue` com origin = 'automacao' e saem com
-- track_source 'cec_queue': o agente reconhece como envio da própria escola,
-- não pausa a IA e continua a conversa quando a família responder.

create extension if not exists pg_net with schema extensions;

alter table public.message_queue add column if not exists origin text;
create index if not exists message_queue_origin_idx on public.message_queue (origin, status, sent_at);

-- ── Configuração (uma linha só) ─────────────────────────────────────────

create table if not exists public.automation_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  daily_cap integer not null default 30,
  hourly_cap integer not null default 8,
  min_gap_seconds integer not null default 240,
  max_gap_seconds integer not null default 540,
  windows text not null default '08:30-11:30,13:30-18:00',
  weekdays smallint[] not null default '{1,2,3,4,5}',
  max_touches integer not null default 3,
  touch_gap_days integer not null default 2,
  deadline date not null default '2026-10-31',
  journey_base_url text not null default 'https://cecnanuque.com.br',
  next_send_after timestamptz,
  paused_reason text,
  consecutive_failures integer not null default 0,
  last_tick_at timestamptz,
  last_tick_result jsonb,
  cron_token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.automation_settings (id) values (1) on conflict (id) do nothing;
alter table public.automation_settings enable row level security;

create table if not exists public.automation_templates (
  key text primary key,
  label text not null,
  sort smallint not null default 0,
  body text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.automation_templates enable row level security;

-- Variações separadas por uma linha com "---": cada família recebe sempre a
-- mesma variação (sorteio fixo pelo id), e famílias diferentes recebem
-- textos diferentes. Texto igual para centenas de números é sinal de spam.
insert into public.automation_templates (key, label, sort, body) values
('contato_1', '1º contato (nunca conversou com a escola)', 1,
$t$Oi, {{responsavel}}! Tudo bem? 😊

Aqui é da secretaria do CEC. A rematrícula 2027 de {{alunos}} já está aberta, e até {{prazo}} vale a condição especial de outubro: o valor da rematrícula sem o reajuste de 2027, com a opção de pagar só em janeiro.

Posso te mandar o link para garantir a vaga?
---
Olá, {{responsavel}}, tudo bem?

Aqui é do CEC 💙 As rematrículas de 2027 já estão abertas e queremos muito continuar com {{alunos}} no ano que vem. Até {{prazo}}, a rematrícula sai sem o reajuste da nova tabela, e dá para garantir a vaga agora e pagar só em janeiro.

Quer que eu te envie o link?
---
Oi, {{responsavel}}! Aqui é da secretaria do CEC 😊

Passando para avisar que a rematrícula de {{alunos}} para 2027 já pode ser feita pelo celular, em poucos minutos. Fechando até {{prazo}}, vale o valor especial de outubro, sem o reajuste de 2027.

Posso te mandar o link?$t$),
('contato_2', 'Lembrete (2º contato)', 2,
$t$Oi, {{responsavel}}, tudo bem? Passando para lembrar que a condição especial da rematrícula de {{alunos}} vale só até {{prazo}}. Depois disso entra a tabela de 2027.

Quer que eu te mande o link? Leva poucos minutos e dá para pagar só em janeiro.
---
Olá, {{responsavel}}! Aqui é do CEC de novo 😊 A rematrícula de {{alunos}} com o valor de outubro fica aberta até {{prazo}}.

Posso te enviar o link para garantir a vaga?$t$),
('contato_3', 'Último lembrete (3º contato)', 3,
$t${{responsavel}}, últimos dias da condição de outubro para a rematrícula de {{alunos}}: vale até {{prazo}}. Depois disso, o valor passa para a tabela de 2027.

Posso te mandar o link agora? Se vocês não forem continuar no CEC em 2027, é só me avisar por aqui que eu não insisto mais. 🙏
---
Oi, {{responsavel}}! Último lembrete sobre a rematrícula de {{alunos}}: a condição especial termina em {{prazo}}.

Quer garantir a vaga? É só me responder que eu mando o link. Se não for continuar, me avise por aqui. 💙$t$),
('jornada_parada', 'Começou e parou no meio (vai com o link)', 4,
$t$Oi, {{responsavel}}! Vi que a rematrícula de {{alunos}} ficou pela metade, na etapa de {{etapa}}. Para garantir o valor de outubro, é só continuar de onde parou até {{prazo}}:
{{link}}

Se tiver qualquer dúvida, me chama por aqui. 😊
---
Olá, {{responsavel}}, tudo bem? A rematrícula de {{alunos}} está quase pronta: falta {{etapa}}. O link é o mesmo, e a condição de outubro vale até {{prazo}}:
{{link}}$t$)
on conflict (key) do nothing;

-- ── Quadro sem a checagem de equipe (uso interno) ───────────────────────
-- Mesma regra de etapa do painel: copiada do staff_journey_board atual, só
-- sem o is_staff(). Assim a automação e o quadro nunca discordam.
do $migration$
declare d text; n text;
begin
  d := pg_get_functiondef('public.staff_journey_board(text)'::regprocedure);
  n := replace(d, 'FUNCTION public.staff_journey_board(', 'FUNCTION public.journey_board_internal(');
  if n = d then raise exception 'staff_journey_board: cabeçalho não encontrado'; end if;
  d := n;
  n := replace(d, $a$  if not public.is_staff() then raise exception 'Apenas a equipe pode ver o quadro' using errcode = '42501'; end if;
$a$, '');
  if n = d then raise exception 'staff_journey_board: checagem de equipe não encontrada'; end if;
  execute n;
end
$migration$;
revoke all on function public.journey_board_internal(text) from public, anon, authenticated;

-- ── Texto ───────────────────────────────────────────────────────────────

create or replace function public.pt_join(p_items text[])
returns text language sql immutable set search_path to '' as $$
  select case coalesce(array_length(p_items, 1), 0)
    when 0 then null
    when 1 then p_items[1]
    else array_to_string(p_items[1:array_length(p_items, 1) - 1], ', ') || ' e ' || p_items[array_length(p_items, 1)]
  end
$$;

create or replace function public.automation_first_name(p_name text)
returns text language sql immutable set search_path to '' as $$
  select case
    when p_name is null or p_name ~* '(respons[aá]vel|centro ed|whatsapp|^\s*$)' then null
    else initcap(lower(split_part(btrim(regexp_replace(p_name, '[^[:alpha:][:space:]-]', '', 'g')), ' ', 1)))
  end
$$;

create or replace function public.automation_render(
  p_key text, p_guardian_id uuid, p_name text, p_students text, p_stage text, p_link text, p_deadline date)
returns text language plpgsql stable set search_path to '' as $$
declare v_body text; v_parts text[]; v_text text; v_stage text;
begin
  select body into v_body from public.automation_templates where key = p_key;
  if v_body is null then return null; end if;
  v_parts := regexp_split_to_array(v_body, '\n-{3,}\n');
  v_text := v_parts[1 + (abs(hashtext(p_guardian_id::text || p_key)) % array_length(v_parts, 1))];
  v_stage := case p_stage
    when 'identificacao' then 'confirmar os dados'
    when 'dados' then 'preencher os dados'
    when 'alunos' then 'confirmar os alunos'
    when 'condicoes' then 'escolher o plano de pagamento'
    when 'assinatura' then 'assinar o contrato'
    when 'cobranca' then 'escolher a forma de pagamento'
    else 'concluir' end;
  v_text := replace(v_text, '{{responsavel}}', coalesce(p_name, 'família'));
  v_text := replace(v_text, '{{alunos}}', coalesce(p_students, 'seu filho'));
  v_text := replace(v_text, '{{prazo}}', to_char(p_deadline, 'DD/MM'));
  v_text := replace(v_text, '{{etapa}}', v_stage);
  v_text := replace(v_text, '{{link}}', coalesce(p_link, ''));
  v_text := regexp_replace(v_text, '^família,', 'Família,');
  return btrim(v_text);
end $$;

-- ── Quem pode receber ───────────────────────────────────────────────────

create or replace function public.automation_candidates()
returns table (
  guardian_id uuid, guardian_name text, phone text, stage text, link text,
  students text, touches integer, last_touch_at timestamptz, last_inbound_at timestamptz,
  last_outbound_at timestamptz, template_key text, priority integer, block text, body text)
language plpgsql stable security definer set search_path to '' as $$
#variable_conflict use_column
declare v_set public.automation_settings; v_board jsonb; v_last_order integer;
begin
  select * into v_set from public.automation_settings where id = 1;
  v_board := public.journey_board_internal('rematricula');
  -- Última série que a escola oferece no ano seguinte: quem está nela não segue.
  select max(g.sort_order) into v_last_order
    from public.grade_offerings o join public.grades g on g.id = o.grade_id
   where o.academic_year = extract(year from v_set.deadline)::int + 1;

  return query
  with cards as (
    select (x->>'guardian_id')::uuid as gid, x->>'guardian_name' as gname, x->>'guardian_phone' as gphone,
           x->>'stage' as st, x->>'token' as tok, coalesce(x->>'flow', 'rematricula') as fl,
           coalesce((x->>'needs_human')::boolean, false) as nh, x->>'handler' as hd, x->'students' as studs,
           x->>'last_activity_at' as last_act
      from jsonb_array_elements(v_board->'cards') x
  ),
  enriched as (
    select c.*,
      case when c.st in ('a_contatar', 'conversa', 'perdida') then
        (select public.pt_join(array_agg(initcap(lower(split_part(st2.full_name, ' ', 1))) order by st2.full_name))
           from public.student_guardians sg
           join public.students st2 on st2.id = sg.student_id
           left join public.classes cl on cl.id = st2.current_class_id
           left join public.grades gr on gr.id = cl.grade_id
          where sg.guardian_id = c.gid and (gr.sort_order is null or gr.sort_order < v_last_order))
      else
        (select public.pt_join(array_agg(initcap(lower(split_part(s->>'name', ' ', 1))) order by s->>'name'))
           from jsonb_array_elements(c.studs) s)
      end as names,
      (select count(*)::int from public.message_queue q
        where q.guardian_id = c.gid and q.origin = 'automacao' and q.status = 'enviada') as n_touch,
      (select max(q.sent_at) from public.message_queue q
        where q.guardian_id = c.gid and q.origin = 'automacao' and q.status = 'enviada') as last_touch,
      (select max(m.created_at) from public.messages m join public.conversations cv on cv.id = m.conversation_id
        where cv.guardian_id = c.gid and m.direction = 'entrada') as last_in,
      (select max(m.created_at) from public.messages m join public.conversations cv on cv.id = m.conversation_id
        where cv.guardian_id = c.gid and m.direction = 'saida' and m.status <> 'falhou') as last_out,
      (select cv.ai_intent from public.conversations cv where cv.guardian_id = c.gid
        order by cv.last_message_at desc nulls last limit 1) as intent,
      -- A IA prometeu a equipe e ninguém da escola falou depois.
      exists (
        select 1 from public.messages m join public.conversations cv on cv.id = m.conversation_id
         where cv.guardian_id = c.gid and m.sender = 'ia'
           and m.body ~* '(avisei a equipe|secretaria (vai|precisa)|chamar algu|encaminh|alguém te responde)'
           and not exists (select 1 from public.messages m2 where m2.conversation_id = cv.id
                            and m2.sender = 'equipe' and m2.created_at > m.created_at)
      ) as promised,
      g.opted_out_at, h.hidden as fu_hidden
    from cards c
    join public.guardians g on g.id = c.gid
    left join public.followup_hidden h on h.phone = c.gphone
  ),
  judged as (
    select e.*,
      case
        when e.gphone is null or length(regexp_replace(e.gphone, '\D', '', 'g')) < 12 then 'sem_telefone'
        when e.opted_out_at is not null then 'pediu_para_sair'
        when e.st in ('pagamento', 'concluida', 'cobranca') then 'ja_assinou'
        when e.st = 'perdida' then 'nao_vai_continuar'
        when coalesce(e.fu_hidden, false) then 'desativado_no_follow_up'
        when e.names is null then 'sem_aluno_em_2027'
        when e.nh or e.hd in ('humano', 'encerrada') then 'com_a_equipe'
        when e.promised then 'esperando_a_escola'
        when e.intent in ('nao_interessado', 'sem_interesse', 'opt_out') then 'nao_quer'
        when e.n_touch >= v_set.max_touches then 'limite_de_contatos'
        when e.last_in > now() - interval '48 hours' then 'conversando'
        when e.last_out > now() - make_interval(days => v_set.touch_gap_days) then 'contato_recente'
      end as why,
      case
        when e.st in ('identificacao', 'dados', 'alunos', 'condicoes', 'assinatura') and e.tok is not null then 'jornada_parada'
        else 'contato_' || least(e.n_touch + case when e.st = 'a_contatar' then 1 else 2 end, 3)
      end as tkey,
      case when e.st = 'a_contatar' and e.n_touch = 0 then 1 when e.n_touch = 0 then 2 when e.n_touch = 1 then 3 else 4 end as prio
    from enriched e
  ),
  dedup as (
    select distinct on (regexp_replace(coalesce(j.gphone, j.gid::text), '\D', '', 'g')) j.*
      from judged j
     order by regexp_replace(coalesce(j.gphone, j.gid::text), '\D', '', 'g'), (j.why is null) desc, j.prio
  )
  select d.gid, d.gname, d.gphone, d.st,
         case when d.tok is not null then rtrim(v_set.journey_base_url, '/') || '/' ||
           case when d.fl = 'rematricula' then 'rematricula' else 'matricula' end || '?j=' || d.tok || '&f=' || d.fl end,
         d.names, d.n_touch, d.last_touch, d.last_in, d.last_out, d.tkey, d.prio, d.why,
         public.automation_render(d.tkey, d.gid, public.automation_first_name(d.gname), d.names, d.st,
           case when d.tok is not null then rtrim(v_set.journey_base_url, '/') || '/' ||
             case when d.fl = 'rematricula' then 'rematricula' else 'matricula' end || '?j=' || d.tok || '&f=' || d.fl end,
           v_set.deadline)
    from dedup d
   order by (d.why is null) desc, d.prio, coalesce(d.last_touch, d.last_out, (d.last_act)::timestamptz, 'epoch') asc, d.gname;
end $$;
revoke all on function public.automation_candidates() from public, anon, authenticated;

-- ── Janela de envio ─────────────────────────────────────────────────────

create or replace function public.automation_in_window(p_set public.automation_settings, p_at timestamptz default now())
returns boolean language plpgsql stable set search_path to '' as $$
declare v_local timestamp := p_at at time zone 'America/Sao_Paulo'; v_win text; v_from time; v_to time;
begin
  if not (extract(isodow from v_local)::smallint = any(p_set.weekdays)) then return false; end if;
  foreach v_win in array regexp_split_to_array(p_set.windows, '\s*,\s*') loop
    continue when v_win !~ '^\d{1,2}:\d{2}-\d{1,2}:\d{2}$';
    v_from := split_part(v_win, '-', 1)::time;
    v_to := split_part(v_win, '-', 2)::time;
    if v_local::time >= v_from and v_local::time < v_to then return true; end if;
  end loop;
  return false;
end $$;

create or replace function public.automation_sent_counts()
returns table (today integer, last_hour integer, failed_today integer)
language sql stable security definer set search_path to '' as $$
  select
    count(*) filter (where q.status = 'enviada' and q.sent_at >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'))::int,
    count(*) filter (where q.status = 'enviada' and q.sent_at >= now() - interval '1 hour')::int,
    count(*) filter (where q.status = 'falhou' and q.updated_at >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'))::int
  from public.message_queue q where q.origin = 'automacao'
$$;
revoke all on function public.automation_sent_counts() from public, anon, authenticated;

-- ── Reserva do próximo envio (chamada pela Edge Function) ───────────────

create or replace function public.automation_pick()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_set public.automation_settings; v_c record; v_counts record; v_campaign uuid;
  v_conv uuid; v_msg uuid; v_queue uuid; v_track uuid; v_gap integer; v_result jsonb;
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
    when exists (select 1 from public.message_queue q where q.origin = 'automacao' and q.status = 'processando'
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

  select * into v_c from public.automation_candidates() c where c.block is null and c.body is not null limit 1;
  if not found then
    v_result := jsonb_build_object('action', 'wait', 'reason', 'ninguem_para_contatar');
    update public.automation_settings set last_tick_at = now(), last_tick_result = v_result where id = 1;
    return v_result;
  end if;

  select id into v_campaign from public.campaigns
   where kind::text = 'rematricula' and status::text = 'ativa' order by starts_on desc limit 1;

  insert into public.conversations (guardian_id, handler) values (v_c.guardian_id, 'ia')
  on conflict (guardian_id) do nothing;
  select id into v_conv from public.conversations where guardian_id = v_c.guardian_id;

  v_track := gen_random_uuid();
  insert into public.messages (conversation_id, direction, sender, body, status, track_source, track_id)
  values (v_conv, 'saida', 'ia', v_c.body, 'na_fila', 'cec_queue', v_track)
  returning id into v_msg;

  insert into public.message_queue (campaign_id, guardian_id, attempt_number, body, status, locked_at, origin, message_id, scheduled_for)
  values (v_campaign, v_c.guardian_id, v_c.touches + 1, v_c.body, 'processando', now(), 'automacao', v_msg, now())
  returning id into v_queue;

  v_gap := v_set.min_gap_seconds + floor(random() * (greatest(v_set.max_gap_seconds, v_set.min_gap_seconds) - v_set.min_gap_seconds + 1))::int;
  v_result := jsonb_build_object(
    'action', 'send', 'queue_id', v_queue, 'message_id', v_msg, 'track_id', v_track,
    'number', regexp_replace(v_c.phone, '\D', '', 'g'), 'body', v_c.body,
    'delay_ms', least(9000, 2500 + length(v_c.body) * 15 + floor(random() * 1500)::int),
    'guardian', v_c.guardian_name, 'template', v_c.template_key, 'touch', v_c.touches + 1);
  update public.automation_settings
     set next_send_after = now() + make_interval(secs => v_gap), last_tick_at = now(),
         last_tick_result = v_result - 'body'
   where id = 1;
  return v_result;
end $$;
revoke all on function public.automation_pick() from public, anon, authenticated;

create or replace function public.automation_result(p_queue_id uuid, p_ok boolean, p_provider_id text, p_error text)
returns void language plpgsql security definer set search_path to '' as $$
declare v_q public.message_queue; v_fail integer;
begin
  select * into v_q from public.message_queue where id = p_queue_id;
  if not found then return; end if;
  if p_ok then
    update public.messages set status = 'enviada', sent_at = now(),
           provider_message_id = coalesce(provider_message_id, nullif(p_provider_id, ''))
     where id = v_q.message_id;
    update public.message_queue set status = 'enviada', locked_at = null where id = p_queue_id;
    update public.automation_settings set consecutive_failures = 0 where id = 1;
  else
    update public.messages set status = 'falhou', error = left(p_error, 500) where id = v_q.message_id;
    update public.message_queue set status = 'falhou', locked_at = null, last_error = left(p_error, 500) where id = p_queue_id;
    update public.automation_settings set consecutive_failures = consecutive_failures + 1 where id = 1
      returning consecutive_failures into v_fail;
    -- Três falhas seguidas: algo está errado com o número ou a instância.
    -- Parar é mais barato do que insistir e tomar bloqueio.
    if v_fail >= 3 then
      update public.automation_settings
         set enabled = false, paused_reason = 'Parou sozinha: 3 envios seguidos falharam. Último erro: ' || left(coalesce(p_error, ''), 200)
       where id = 1;
    end if;
  end if;
end $$;
revoke all on function public.automation_result(uuid, boolean, text, text) from public, anon, authenticated;

create or replace function public.automation_pause(p_reason text)
returns void language sql security definer set search_path to '' as $$
  update public.automation_settings set enabled = false, paused_reason = p_reason where id = 1;
$$;
revoke all on function public.automation_pause(text) from public, anon, authenticated;

-- ── Cron: acorda a Edge Function a cada minuto, só quando faz sentido ──

create or replace function public.automation_cron()
returns void language plpgsql security definer set search_path to '' as $$
declare v_set public.automation_settings;
begin
  select * into v_set from public.automation_settings where id = 1;
  if not v_set.enabled or not public.automation_in_window(v_set) then return; end if;
  if v_set.next_send_after is not null and v_set.next_send_after > now() + interval '20 seconds' then return; end if;
  perform net.http_post(
    url := 'https://uczxuaaojixapkdlayph.supabase.co/functions/v1/automation-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-automation-token', v_set.cron_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
end $$;
revoke all on function public.automation_cron() from public, anon, authenticated;

select cron.schedule('cec-automacao', '* * * * *', 'select public.automation_cron()');

-- ── Painel ──────────────────────────────────────────────────────────────

create or replace function public.staff_automation_overview()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_set public.automation_settings; v_counts record; v_out jsonb;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe' using errcode = '42501'; end if;
  select * into v_set from public.automation_settings where id = 1;
  select * into v_counts from public.automation_sent_counts();

  with cand as (select * from public.automation_candidates())
  select jsonb_build_object(
    'settings', to_jsonb(v_set) - 'cron_token',
    'in_window', public.automation_in_window(v_set),
    'counts', jsonb_build_object('today', v_counts.today, 'last_hour', v_counts.last_hour, 'failed_today', v_counts.failed_today),
    'templates', (select coalesce(jsonb_agg(to_jsonb(t) - 'updated_by' order by t.sort), '[]'::jsonb) from public.automation_templates t),
    'eligible', (select count(*) from cand where block is null),
    'by_template', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
        select template_key k, count(*) n from cand where block is null group by 1) x),
    'by_block', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
        select coalesce(block, 'pode_receber') k, count(*) n from cand group by 1) x),
    'remaining_touches', (select coalesce(sum(greatest(v_set.max_touches - touches, 0)), 0) from cand
        where block is null or block in ('contato_recente', 'conversando')),
    'first_contact_left', (select count(*) from cand where stage = 'a_contatar' and touches = 0
        and (block is null or block in ('contato_recente'))),
    'next', (select coalesce(jsonb_agg(jsonb_build_object(
        'guardian_id', guardian_id, 'name', guardian_name, 'phone', phone, 'stage', stage, 'students', students,
        'touch', touches + 1, 'template', template_key, 'body', body)), '[]'::jsonb)
        from (select * from cand where block is null and body is not null limit 12) n),
    'blocked_sample', (select coalesce(jsonb_agg(jsonb_build_object(
        'guardian_id', guardian_id, 'name', guardian_name, 'phone', phone, 'stage', stage, 'students', students,
        'touches', touches, 'block', block)), '[]'::jsonb)
        from (select * from cand where block is not null and block not in ('ja_assinou', 'sem_aluno_em_2027')
              order by block, guardian_name limit 80) b),
    'recent', (select coalesce(jsonb_agg(r order by r->>'at' desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'queue_id', q.id, 'at', coalesce(q.sent_at, q.updated_at), 'status', q.status, 'touch', q.attempt_number,
          'error', q.last_error, 'name', g.full_name, 'phone', g.phone, 'guardian_id', g.id,
          'body', q.body,
          'replied', exists (select 1 from public.messages m join public.conversations cv on cv.id = m.conversation_id
                              where cv.guardian_id = g.id and m.direction = 'entrada' and m.created_at > q.sent_at)) as r
          from public.message_queue q join public.guardians g on g.id = q.guardian_id
         where q.origin = 'automacao'
         order by coalesce(q.sent_at, q.updated_at) desc limit 60) rr),
    'totals', (select jsonb_build_object(
        'sent', count(*) filter (where q.status = 'enviada'),
        'failed', count(*) filter (where q.status = 'falhou'),
        'families', count(distinct q.guardian_id) filter (where q.status = 'enviada'),
        'replied', count(distinct q.guardian_id) filter (where q.status = 'enviada' and exists (
            select 1 from public.messages m join public.conversations cv on cv.id = m.conversation_id
             where cv.guardian_id = q.guardian_id and m.direction = 'entrada' and m.created_at > q.sent_at)))
        from public.message_queue q where q.origin = 'automacao')
  ) into v_out;
  return v_out;
end $$;

create or replace function public.staff_automation_save(p_settings jsonb default null, p_templates jsonb default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_set public.automation_settings; v_t jsonb; v_enable boolean;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe' using errcode = '42501'; end if;
  select * into v_set from public.automation_settings where id = 1 for update;

  if p_settings is not null then
    if (p_settings->>'daily_cap')::int not between 1 and 200 then raise exception 'Limite por dia deve ficar entre 1 e 200'; end if;
    if (p_settings->>'hourly_cap')::int not between 1 and 30 then raise exception 'Limite por hora deve ficar entre 1 e 30'; end if;
    if (p_settings->>'min_gap_seconds')::int < 60 then raise exception 'O intervalo mínimo é de 1 minuto'; end if;
    if (p_settings->>'max_gap_seconds')::int < (p_settings->>'min_gap_seconds')::int then raise exception 'O intervalo máximo precisa ser maior que o mínimo'; end if;
    if (p_settings->>'max_touches')::int not between 1 and 5 then raise exception 'Contatos por família: de 1 a 5'; end if;
    if (p_settings->>'touch_gap_days')::int not between 1 and 14 then raise exception 'Dias entre contatos: de 1 a 14'; end if;
    if coalesce(p_settings->>'windows', '') !~ '^\s*\d{1,2}:\d{2}-\d{1,2}:\d{2}(\s*,\s*\d{1,2}:\d{2}-\d{1,2}:\d{2})*\s*$' then
      raise exception 'Horários no formato 08:30-11:30, 13:30-18:00'; end if;
    v_enable := coalesce((p_settings->>'enabled')::boolean, v_set.enabled);
    update public.automation_settings set
      enabled = v_enable,
      daily_cap = (p_settings->>'daily_cap')::int,
      hourly_cap = (p_settings->>'hourly_cap')::int,
      min_gap_seconds = (p_settings->>'min_gap_seconds')::int,
      max_gap_seconds = (p_settings->>'max_gap_seconds')::int,
      windows = btrim(p_settings->>'windows'),
      weekdays = coalesce((select array_agg(x::smallint order by x::smallint) from jsonb_array_elements_text(p_settings->'weekdays') x
                            where x::int between 1 and 7), v_set.weekdays),
      max_touches = (p_settings->>'max_touches')::int,
      touch_gap_days = (p_settings->>'touch_gap_days')::int,
      deadline = coalesce((p_settings->>'deadline')::date, v_set.deadline),
      paused_reason = case when v_enable and not v_set.enabled then null else v_set.paused_reason end,
      consecutive_failures = case when v_enable and not v_set.enabled then 0 else v_set.consecutive_failures end,
      next_send_after = case when v_enable and not v_set.enabled then now() + interval '30 seconds' else v_set.next_send_after end,
      updated_at = now(), updated_by = auth.uid()
    where id = 1;
  end if;

  if p_templates is not null then
    for v_t in select * from jsonb_array_elements(p_templates) loop
      if btrim(coalesce(v_t->>'body', '')) = '' then raise exception 'Texto vazio em %', v_t->>'key'; end if;
      if v_t->>'key' = 'jornada_parada' and position('{{link}}' in v_t->>'body') = 0 then
        raise exception 'O texto de quem parou no meio precisa ter {{link}}'; end if;
      update public.automation_templates set body = btrim(v_t->>'body'), updated_at = now(), updated_by = auth.uid()
       where key = v_t->>'key';
    end loop;
  end if;
  return public.staff_automation_overview();
end $$;

-- O ícone "Contatado" do follow-up passa a contar também a automação.
do $migration$
declare d text; n text;
begin
  d := pg_get_functiondef('public.staff_debug_followup(text)'::regprocedure);
  n := replace(d, $a$m.track_source = 'cec_staff'$a$, $b$m.track_source in ('cec_staff', 'cec_queue')$b$);
  if n = d then raise exception 'staff_debug_followup: trecho esperado não encontrado'; end if;
  execute n;
end
$migration$;
