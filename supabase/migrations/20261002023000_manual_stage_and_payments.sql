-- Mudança manual de etapa no quadro e baixa manual de parcelas.

create or replace function public.journey_stage_rank(p_stage text)
returns integer language sql immutable set search_path to '' as $$
  select case p_stage
    when 'perdida' then -1 when 'a_contatar' then 0 when 'conversa' then 1
    when 'identificacao' then 2 when 'dados' then 2 when 'alunos' then 3
    when 'condicoes' then 4 when 'assinatura' then 5 when 'cobranca' then 6
    when 'pagamento' then 7 when 'concluida' then 8 else 0 end
$$;

-- Uma linha por família e campanha. stage nulo = segue o sistema.
-- auto_stage guarda a etapa calculada no momento em que a equipe moveu.
create table if not exists public.journey_stage_overrides (
  campaign_id uuid not null references public.campaigns(id),
  guardian_id uuid not null references public.guardians(id),
  stage text check (stage in ('a_contatar','conversa','identificacao','alunos','dados','condicoes','assinatura','cobranca','pagamento','concluida','perdida')),
  auto_stage text,
  note text,
  set_by uuid references public.profiles(id),
  set_at timestamptz not null default now(),
  primary key (campaign_id, guardian_id)
);
alter table public.journey_stage_overrides enable row level security;
create policy "equipe lê" on public.journey_stage_overrides for select to authenticated using ((select public.is_staff()));

create or replace function public.staff_journey_board(p_kind text default 'rematricula')
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_campaign public.campaigns;
  v_cards jsonb;
  v_anonymous integer;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe pode ver o quadro' using errcode = '42501'; end if;

  select * into v_campaign from public.campaigns
   where kind::text = p_kind and status::text = 'ativa'
   order by starts_on desc limit 1;
  if not found then return jsonb_build_object('campaign', null, 'cards', '[]'::jsonb, 'anonymous_sessions', 0); end if;

  with base_2026 as (
    select distinct e.guardian_id
      from public.enrollments e join public.campaigns c on c.id = e.campaign_id
     where c.academic_year = v_campaign.academic_year - 1 and c.kind::text = 'rematricula' and e.guardian_id is not null
  ),
  remat_guardians as (
    select guardian_id from base_2026
    union
    select s.guardian_id from public.enrollment_onboarding_sessions s
      join public.campaigns c on c.id = s.campaign_id
     where c.kind::text = 'rematricula' and c.status::text = 'ativa' and s.guardian_id is not null
  ),
  families as (
    select s.guardian_id from public.enrollment_onboarding_sessions s
     where s.campaign_id = v_campaign.id and s.guardian_id is not null and s.status <> 'cancelada'
    union
    select e.guardian_id from public.enrollments e where e.campaign_id = v_campaign.id and e.guardian_id is not null
    union
    select guardian_id from base_2026 where p_kind = 'rematricula'
    union
    -- Matrícula nova: quem conversa no WhatsApp e não é da base nem da rematrícula.
    select cv.guardian_id from public.conversations cv
     where p_kind = 'matricula_nova' and cv.guardian_id not in (select guardian_id from remat_guardians)
  ),
  sessions as (
    select distinct on (s.guardian_id) s.*, public.onboarding_stage(s.id) as stage
      from public.enrollment_onboarding_sessions s
     where s.campaign_id = v_campaign.id and s.guardian_id in (select guardian_id from families) and s.status <> 'cancelada'
     order by s.guardian_id, s.updated_at desc
  ),
  convs as (
    select distinct on (cv.guardian_id) cv.*
      from public.conversations cv
     where cv.guardian_id in (select guardian_id from families)
     order by cv.guardian_id, cv.last_message_at desc nulls last
  ),
  current_enr as (
    select e.*, st.full_name as student_name, g.name as grade_name, fc.name as from_class_name,
           exists (select 1 from sessions s join public.enrollment_onboarding_items oi on oi.onboarding_session_id = s.id
                    where oi.enrollment_id = e.id) as in_session
      from public.enrollments e
      join public.students st on st.id = e.student_id
      left join public.grades g on g.id = e.target_grade_id
      left join public.classes fc on fc.id = e.from_class_id
     where e.campaign_id = v_campaign.id and e.guardian_id in (select guardian_id from families)
  ),
  previous_enr as (
    select distinct on (e.student_id) e.guardian_id, e.student_id, st.full_name as student_name, cl.name as class_name
      from public.enrollments e
      join public.campaigns c on c.id = e.campaign_id
      join public.students st on st.id = e.student_id
      left join public.classes cl on cl.id = coalesce(e.target_class_id, st.current_class_id)
     where p_kind = 'rematricula' and c.academic_year = v_campaign.academic_year - 1
       and e.guardian_id in (select guardian_id from families)
     order by e.student_id, e.created_at desc
  ),
  cards as (
    select
      g.id as guardian_id,
      g.full_name as guardian_name,
      g.phone as guardian_phone,
      s.id as session_id,
      s.token,
      s.flow::text as flow,
      s.context->'plan_choice'->>'name' as plan_name,
      s.context->>'billing_method' as billing_method,
      (select array_agg(ce.status::text) from current_enr ce where ce.guardian_id = g.id) as statuses,
      case
        when g.opted_out_at is not null then 'perdida'
        when exists (select 1 from current_enr ce where ce.guardian_id = g.id)
         and not exists (select 1 from current_enr ce where ce.guardian_id = g.id and ce.lost_at is null
                           and ce.status::text not in ('sem_interesse', 'opt_out', 'fora_campanha')) then 'perdida'
        when s.stage is not null then s.stage
        when exists (select 1 from current_enr ce where ce.guardian_id = g.id and ce.completed_at is not null) then 'concluida'
        when exists (select 1 from current_enr ce where ce.guardian_id = g.id and ce.signed_at is not null) then 'pagamento'
        when cv.id is not null or exists (select 1 from current_enr ce where ce.guardian_id = g.id and ce.contacted_at is not null) then 'conversa'
        else 'a_contatar'
      end as auto_stage,
      (exists (select 1 from current_enr ce where ce.guardian_id = g.id and ce.status::text = 'precisa_humano')
        or (cv.handler::text = 'humano' and cv.closed_at is null)) as needs_human,
      coalesce(
        (select jsonb_agg(jsonb_build_object('name', ce.student_name, 'grade', ce.grade_name, 'from', ce.from_class_name,
                                             'amount_cents', ce.amount_cents, 'is_new', coalesce(ce.is_new_student, false))
                          order by ce.student_name)
           from current_enr ce where ce.guardian_id = g.id and (s.id is null or ce.in_session)),
        (select jsonb_agg(jsonb_build_object('name', pe.student_name, 'from', pe.class_name) order by pe.student_name)
           from previous_enr pe where pe.guardian_id = g.id),
        '[]'::jsonb) as students,
      (select sum(ce.amount_cents) from current_enr ce where ce.guardian_id = g.id and (s.id is null or ce.in_session)) as amount_cents,
      (select ce.id from current_enr ce where ce.guardian_id = g.id order by ce.in_session desc, ce.created_at limit 1) as enrollment_id,
      (select max(ce.attempts) from current_enr ce where ce.guardian_id = g.id) as attempts,
      (select coalesce(jsonb_agg(jsonb_build_object(
                'id', i.id, 'student', ce.student_name, 'number', i.number, 'amount_cents', i.amount_cents,
                'due_date', i.due_date, 'status', i.status, 'method', i.method, 'paid_at', i.paid_at,
                'paid_amount_cents', i.paid_amount_cents, 'provider', i.provider)
              order by i.due_date, ce.student_name, i.number), '[]'::jsonb)
         from current_enr ce join public.installments i on i.enrollment_id = ce.id
        where ce.guardian_id = g.id and ce.signed_at is not null and i.status::text <> 'cancelado') as installments,
      cv.id as conversation_id,
      cv.handler::text as handler,
      cv.last_message_at,
      cv.last_message_preview,
      cv.unread_count,
      cv.ai_summary,
      greatest(s.updated_at, s.last_opened_at, cv.last_message_at,
               (select max(ce.updated_at) from current_enr ce where ce.guardian_id = g.id)) as last_activity_at
    from families f
    join public.guardians g on g.id = f.guardian_id
    left join sessions s on s.guardian_id = g.id
    left join convs cv on cv.guardian_id = g.id
  )
  ,
  -- Etapa movida à mão vale enquanto o sistema não alcançar (ou passar) a etapa
  -- escolhida; mover para trás vale até o sistema mudar de etapa.
  final_cards as (
    select cards.*,
           case when o.stage is not null and (o.auto_stage = cards.auto_stage or public.journey_stage_rank(cards.auto_stage) < public.journey_stage_rank(o.stage)) then o.stage else cards.auto_stage end as stage,
           (o.stage is not null and (o.auto_stage = cards.auto_stage or public.journey_stage_rank(cards.auto_stage) < public.journey_stage_rank(o.stage))) as manual,
           case when o.stage is not null and (o.auto_stage = cards.auto_stage or public.journey_stage_rank(cards.auto_stage) < public.journey_stage_rank(o.stage)) then
             jsonb_build_object('note', o.note, 'by', p.full_name, 'at', o.set_at) end as manual_info
      from cards
      left join public.journey_stage_overrides o on o.campaign_id = v_campaign.id and o.guardian_id = cards.guardian_id
      left join public.profiles p on p.id = o.set_by
  )
  select coalesce(jsonb_agg(to_jsonb(final_cards) order by final_cards.last_activity_at desc nulls last, final_cards.guardian_name), '[]'::jsonb)
    into v_cards from final_cards;

  -- Links abertos sem identificação: ainda não têm família para virar card.
  select count(*) into v_anonymous from public.enrollment_onboarding_sessions s
   where s.campaign_id = v_campaign.id and s.guardian_id is null and s.status <> 'cancelada';

  return jsonb_build_object(
    'campaign', jsonb_build_object('id', v_campaign.id, 'name', v_campaign.name, 'kind', v_campaign.kind, 'max_attempts', v_campaign.max_attempts),
    'cards', v_cards,
    'anonymous_sessions', v_anonymous
  );
end $function$;


revoke all on function public.staff_journey_board(text) from public, anon;
grant execute on function public.staff_journey_board(text) to authenticated;

-- Move a família de etapa no quadro (ou devolve ao automático com p_stage nulo).
create or replace function public.staff_set_journey_stage(p_kind text, p_guardian_id uuid, p_stage text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_campaign public.campaigns;
  v_auto text;
  v_label text;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe pode mover famílias' using errcode = '42501'; end if;
  select * into v_campaign from public.campaigns where kind::text = p_kind and status::text = 'ativa' order by starts_on desc limit 1;
  if not found then raise exception 'Campanha ativa não encontrada'; end if;

  -- Etapa que o sistema calcula hoje, sem a mudança manual.
  select c->>'auto_stage' into v_auto
    from jsonb_array_elements(public.staff_journey_board(p_kind)->'cards') c
   where (c->>'guardian_id')::uuid = p_guardian_id;
  if v_auto is null then raise exception 'Família não está nesta campanha'; end if;

  insert into public.journey_stage_overrides (campaign_id, guardian_id, stage, auto_stage, note, set_by, set_at)
  values (v_campaign.id, p_guardian_id, nullif(nullif(p_stage, ''), v_auto), v_auto, nullif(trim(p_note), ''), auth.uid(), now())
  on conflict (campaign_id, guardian_id) do update
    set stage = excluded.stage, auto_stage = excluded.auto_stage, note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at;

  v_label := case when nullif(nullif(p_stage, ''), v_auto) is null then 'Etapa voltou ao automático' else 'Etapa alterada manualmente para ' || p_stage end;
  insert into public.enrollment_events (enrollment_id, code, title, body, actor, metadata)
  select e.id, 'STAGE_MANUAL', v_label, nullif(trim(p_note), ''), 'equipe',
         jsonb_build_object('stage', p_stage, 'auto_stage', v_auto, 'staff_id', auth.uid())
    from public.enrollments e where e.campaign_id = v_campaign.id and e.guardian_id = p_guardian_id;

  return jsonb_build_object('stage', coalesce(nullif(nullif(p_stage, ''), v_auto), v_auto), 'auto_stage', v_auto, 'manual', nullif(nullif(p_stage, ''), v_auto) is not null);
end $function$;
revoke all on function public.staff_set_journey_stage(text, uuid, text, text) from public, anon;
grant execute on function public.staff_set_journey_stage(text, uuid, text, text) to authenticated;

-- Baixa manual (pagou na secretaria, Pix direto etc.) ou desfaz a baixa.
create or replace function public.staff_set_installment_paid(
  p_installment_id uuid, p_paid boolean, p_method text default null,
  p_paid_on date default null, p_amount_cents integer default null, p_notify boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_i public.installments;
  v_e public.enrollments;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe pode registrar pagamentos' using errcode = '42501'; end if;
  select * into v_i from public.installments where id = p_installment_id for update;
  if not found then raise exception 'Parcela não encontrada'; end if;
  select * into v_e from public.enrollments where id = v_i.enrollment_id;

  if p_paid then
    update public.installments
       set status = 'pago',
           method = coalesce(nullif(p_method, '')::public.payment_method, method),
           paid_at = coalesce(p_paid_on::timestamp at time zone 'America/Sao_Paulo' + interval '12 hours', now()),
           paid_amount_cents = coalesce(p_amount_cents, amount_cents)
     where id = v_i.id;
    insert into public.enrollment_events (enrollment_id, code, title, body, actor, metadata)
    values (v_i.enrollment_id, 'PAYMENT_MANUAL', 'Pagamento registrado pela equipe',
            'Parcela ' || v_i.number || ' · ' || public.format_brl(coalesce(p_amount_cents, v_i.amount_cents)) || coalesce(' · ' || p_method, ''),
            'equipe', jsonb_build_object('installment_id', v_i.id, 'staff_id', auth.uid()));
    if p_notify then
      insert into public.message_queue (campaign_id, guardian_id, enrollment_id, body)
      values (v_e.campaign_id, v_e.guardian_id, v_e.id,
              'Recebemos o pagamento de *' || public.format_brl(coalesce(p_amount_cents, v_i.amount_cents)) || '* ✅ Obrigado!');
    end if;
  else
    update public.installments set status = 'pendente', paid_at = null, paid_amount_cents = null where id = v_i.id;
    -- O recálculo não desfaz datas; sem nenhuma parcela paga, a matrícula volta a aguardar pagamento.
    if not exists (select 1 from public.installments where enrollment_id = v_i.enrollment_id and status = 'pago') then
      update public.enrollments set paid_at = null, completed_at = null where id = v_i.enrollment_id;
      perform public.recompute_enrollment_progress(v_i.enrollment_id);
    end if;
    insert into public.enrollment_events (enrollment_id, code, title, body, actor, metadata)
    values (v_i.enrollment_id, 'PAYMENT_MANUAL_UNDO', 'Pagamento desfeito pela equipe', 'Parcela ' || v_i.number || ' voltou para pendente',
            'equipe', jsonb_build_object('installment_id', v_i.id, 'staff_id', auth.uid()));
  end if;
  return (select to_jsonb(i) from public.installments i where i.id = v_i.id);
end $function$;
revoke all on function public.staff_set_installment_paid(uuid, boolean, text, date, integer, boolean) from public, anon;
grant execute on function public.staff_set_installment_paid(uuid, boolean, text, date, integer, boolean) to authenticated;
