-- Convite de rematrícula pela secretaria, direto do quadro de jornadas.
--
-- Abre (ou reaproveita) a jornada da família, como staff_start_rematricula, e
-- devolve o que a mensagem para o pai precisa: o link e, por filho, a série de
-- 2027 e o valor vigente. O valor segue a mesma regra do agente: na
-- rematrícula vale o valor antecipado de outubro até early_amount_until; depois,
-- a tabela da série.

create or replace function public.staff_rematricula_invite(p_guardian_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_start jsonb;
  v_campaign public.campaigns;
  v_guardian public.guardians;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_students jsonb;
begin
  -- Confere a equipe e abre a jornada.
  v_start := public.staff_start_rematricula(p_guardian_id);
  v_campaign := public.onboarding_campaign('rematricula');
  select * into v_guardian from public.guardians where id = p_guardian_id;

  with kids as (
    select s.id, s.full_name, s.current_class_id,
           e.target_grade_id, e.amount_cents as enrollment_amount, e.status::text as enrollment_status
      from public.student_guardians sg
      join public.students s on s.id = sg.student_id
      left join public.enrollments e on e.campaign_id = v_campaign.id and e.student_id = s.id
     where sg.guardian_id = p_guardian_id
  ),
  priced as (
    select k.full_name,
           cl.name as current_class,
           coalesce(tg.name, ng.name) as next_grade,
           o.amount_cents as table_cents,
           case when o.early_amount_cents is not null and o.early_amount_until is not null and v_today <= o.early_amount_until
                then o.early_amount_cents end as early_cents,
           o.early_amount_until,
           k.enrollment_amount
      from kids k
      left join public.classes cl on cl.id = k.current_class_id
      left join public.grades cg on cg.id = cl.grade_id
      left join public.grades ng on ng.id = cg.next_grade_id
      left join public.grades tg on tg.id = k.target_grade_id
      left join public.grade_offerings o
        on o.academic_year = v_campaign.academic_year and o.grade_id = coalesce(k.target_grade_id, ng.id)
     -- Fora: quem já disse que não (ou saiu da lista) e formando sem próxima série.
     where coalesce(k.enrollment_status, '') not in ('sem_interesse', 'opt_out', 'fora_campanha')
       and coalesce(k.target_grade_id, ng.id) is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', full_name,
           'current_class', current_class,
           'next_grade', next_grade,
           'amount_cents', coalesce(early_cents, enrollment_amount, table_cents),
           'table_amount_cents', table_cents,
           'early_until', case when early_cents is not null then early_amount_until end
         ) order by full_name), '[]'::jsonb)
    into v_students from priced;

  return v_start || jsonb_build_object(
    'guardian_name', v_guardian.full_name,
    'guardian_phone', v_guardian.phone,
    'academic_year', v_campaign.academic_year,
    'students', v_students
  );
end $function$;

revoke all on function public.staff_rematricula_invite(uuid) from public, anon;
grant execute on function public.staff_rematricula_invite(uuid) to authenticated;
