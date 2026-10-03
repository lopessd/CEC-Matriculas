-- Dashboard: alunos de famílias fechadas à mão contam como rematriculados.
create or replace function public.staff_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_remat public.campaigns;
  v_nova public.campaigns;
  v_board_remat jsonb;
  v_board_nova jsonb;
  v_early_until date;
  v_tz constant text := 'America/Sao_Paulo';
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
  v_manual uuid[];
begin
  if not public.is_staff() then raise exception 'Apenas a equipe pode ver o dashboard' using errcode = '42501'; end if;

  select * into v_remat from public.campaigns where kind::text = 'rematricula' and status::text = 'ativa' order by starts_on desc limit 1;
  select * into v_nova from public.campaigns where kind::text = 'matricula_nova' and status::text = 'ativa' order by starts_on desc limit 1;
  v_board_remat := public.staff_journey_board('rematricula');
  v_board_nova := public.staff_journey_board('matricula_nova');
  -- Famílias fechadas à mão no quadro contam como assinadas (ex.: contrato em papel).
  v_manual := array(select (c->>'guardian_id')::uuid from jsonb_array_elements(v_board_remat->'cards') c
                     where (c->>'manual')::boolean and c->>'stage' in ('cobranca', 'pagamento', 'concluida'));
  select max(o.early_amount_until) into v_early_until from public.v_grade_offerings o where o.academic_year = v_remat.academic_year;

  with base as (
    -- Alunos de 2026 e a série que cursam em 2027 (quem não tem oferta conclui o ciclo).
    select distinct on (e.student_id)
           e.student_id, e.guardian_id, g.id as grade_id, g.name as grade_name, g.sort_order,
           o.current_amount_cents as next_amount_cents, o.grade_name as next_grade_name
      from public.enrollments e
      join public.campaigns c on c.id = e.campaign_id
      join public.students st on st.id = e.student_id
      left join public.classes cl on cl.id = coalesce(e.target_class_id, st.current_class_id)
      left join public.grades g on g.id = cl.grade_id
      left join public.v_grade_offerings o on o.grade_id = g.next_grade_id and o.academic_year = v_remat.academic_year
     where c.academic_year = v_remat.academic_year - 1 and c.kind::text = 'rematricula'
     order by e.student_id, e.created_at desc
  ),
  current_enr as (
    select e.*, c.kind::text as kind
      from public.enrollments e join public.campaigns c on c.id = e.campaign_id
     where c.id in (v_remat.id, v_nova.id)
  ),
  by_grade as (
    select b.grade_name, b.sort_order, b.next_grade_name,
           count(*) as alunos,
           count(*) filter (where b.next_amount_cents is not null) as elegiveis,
           count(*) filter (where (ce.id is not null and ce.lost_at is null) or (b.guardian_id = any(v_manual) and b.next_amount_cents is not null)) as em_jornada,
           count(*) filter (where ce.signed_at is not null or (b.guardian_id = any(v_manual) and b.next_amount_cents is not null)) as assinados,
           count(ce.id) filter (where ce.completed_at is not null) as concluidos
      from base b
      left join current_enr ce on ce.student_id = b.student_id and ce.kind = 'rematricula'
     group by 1, 2, 3
  ),
  days as (
    select d::date as day from generate_series(v_today - 20, v_today, interval '1 day') d
  ),
  daily as (
    select dd.day,
           (select count(*) from public.enrollment_onboarding_sessions s
             where s.campaign_id in (v_remat.id, v_nova.id) and s.guardian_id is not null
               and (s.created_at at time zone v_tz)::date = dd.day) as jornadas,
           (select count(*) from current_enr ce where (ce.signed_at at time zone v_tz)::date = dd.day) as assinados,
           (select count(*) from public.messages m where m.direction::text = 'entrada' and (m.created_at at time zone v_tz)::date = dd.day) as msgs_entrada,
           (select count(*) from public.messages m where m.direction::text = 'saida' and (m.created_at at time zone v_tz)::date = dd.day) as msgs_saida
      from days dd
  ),
  signed as (
    select ce.*, pp.installments as plan_installments
      from current_enr ce left join public.payment_plans pp on pp.id = ce.payment_plan_id
     where ce.signed_at is not null
  ),
  billing as (
    select s.context->>'billing_method' as method, count(*) as familias
      from public.enrollment_onboarding_sessions s
     where s.campaign_id in (v_remat.id, v_nova.id) and s.context ? 'billing_method' and s.status <> 'cancelada'
     group by 1
  )
  select jsonb_build_object(
    'campaign', jsonb_build_object('id', v_remat.id, 'name', v_remat.name, 'academic_year', v_remat.academic_year),
    'today', v_today,
    'early_until', v_early_until,
    'remat_board', jsonb_build_object(
      'stages', (select jsonb_object_agg(stage, n) from (select c->>'stage' as stage, count(*) as n from jsonb_array_elements(v_board_remat->'cards') c group by 1) x),
      'families', jsonb_array_length(v_board_remat->'cards'),
      'needs_human', (select count(*) from jsonb_array_elements(v_board_remat->'cards') c where (c->>'needs_human')::boolean),
      'anonymous', v_board_remat->'anonymous_sessions'),
    'nova_board', jsonb_build_object(
      'stages', (select jsonb_object_agg(stage, n) from (select c->>'stage' as stage, count(*) as n from jsonb_array_elements(v_board_nova->'cards') c group by 1) x),
      'families', jsonb_array_length(v_board_nova->'cards'),
      'needs_human', (select count(*) from jsonb_array_elements(v_board_nova->'cards') c where (c->>'needs_human')::boolean),
      'anonymous', v_board_nova->'anonymous_sessions',
      'pre_matriculas', (select count(*) from public.pre_enrollment_submissions p where p.campaign_id = v_nova.id)),
    'students', jsonb_build_object(
      'base', (select count(*) from base),
      'elegiveis', (select count(*) from base where next_amount_cents is not null),
      'concluem_ciclo', (select count(*) from base where next_amount_cents is null),
      'em_jornada', (select count(*) from current_enr where kind = 'rematricula' and lost_at is null and signed_at is null),
      'assinados', (select count(*) from signed where kind = 'rematricula'),
      'novos_assinados', (select count(*) from signed where kind = 'matricula_nova' or coalesce(is_new_student, false)),
      'concluidos', (select count(*) from current_enr where completed_at is not null)),
    'by_grade', (select coalesce(jsonb_agg(to_jsonb(g) order by g.sort_order nulls last, g.grade_name), '[]'::jsonb) from by_grade g),
    'daily', (select jsonb_agg(to_jsonb(d) order by d.day) from daily d),
    'plans', (select coalesce(jsonb_object_agg(coalesce(plan_installments::text, 'sem'), n), '{}'::jsonb)
                from (select plan_installments, count(*) as n from signed group by 1) x),
    'billing', (select coalesce(jsonb_object_agg(method, familias), '{}'::jsonb) from billing),
    'finance', jsonb_build_object(
      'potencial_cents', (select coalesce(sum(next_amount_cents), 0) from base),
      'contratado_cents', (select coalesce(sum(amount_cents), 0) from signed),
      'em_jornada_cents', (select coalesce(sum(amount_cents), 0) from current_enr where signed_at is null and lost_at is null),
      'recebido_cents', (select coalesce(sum(coalesce(i.paid_amount_cents, i.amount_cents)), 0) from public.installments i join signed s on s.id = i.enrollment_id where i.status::text = 'pago'),
      'em_aberto_cents', (select coalesce(sum(i.amount_cents), 0) from public.installments i join signed s on s.id = i.enrollment_id where i.status::text = 'pendente'),
      'vencido_cents', (select coalesce(sum(i.amount_cents), 0) from public.installments i join signed s on s.id = i.enrollment_id where i.status::text = 'vencido'),
      'next_due', (select jsonb_agg(jsonb_build_object('due_date', due_date, 'amount_cents', total, 'parcelas', n) order by due_date)
                     from (select i.due_date, sum(i.amount_cents) as total, count(*) as n
                             from public.installments i join signed s on s.id = i.enrollment_id
                            where i.status::text in ('pendente', 'vencido') group by 1) x)),
    'whatsapp', jsonb_build_object(
      'conversas', (select count(*) from public.conversations),
      'com_ia', (select count(*) from public.conversations where handler::text = 'ia' and closed_at is null),
      'com_equipe', (select count(*) from public.conversations where handler::text = 'humano' and closed_at is null),
      'nao_lidas', (select coalesce(sum(unread_count), 0) from public.conversations),
      'hoje_entrada', (select count(*) from public.messages m where m.direction::text = 'entrada' and (m.created_at at time zone v_tz)::date = v_today),
      'hoje_ia', (select count(*) from public.messages m where m.sender::text = 'ia' and (m.created_at at time zone v_tz)::date = v_today),
      'hoje_equipe', (select count(*) from public.messages m where m.sender::text = 'equipe' and (m.created_at at time zone v_tz)::date = v_today),
      'total_ia', (select count(*) from public.messages m where m.sender::text = 'ia'),
      'total_equipe', (select count(*) from public.messages m where m.sender::text = 'equipe'),
      'fila', (select count(*) from public.message_queue q where q.status::text in ('pendente', 'processando')),
      'falhas', (select count(*) from public.message_queue q where q.status::text = 'falhou'),
      'ultimo_envio', (select max(sent_at) from public.message_queue))
  ) into v_result;

  return v_result;
end $function$;

revoke all on function public.staff_dashboard() from public, anon;
grant execute on function public.staff_dashboard() to authenticated;
