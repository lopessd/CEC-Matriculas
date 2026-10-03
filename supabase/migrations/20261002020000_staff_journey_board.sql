-- Quadro (kanban) da campanha: um card por família, na etapa real da jornada.
-- A etapa vem de onboarding_stage(); antes da jornada, a família fica em
-- "a_contatar" (base sem conversa) ou "conversa" (já falou no WhatsApp).
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
      end as stage,
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
  select coalesce(jsonb_agg(to_jsonb(cards) order by cards.last_activity_at desc nulls last, cards.guardian_name), '[]'::jsonb)
    into v_cards from cards;

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
