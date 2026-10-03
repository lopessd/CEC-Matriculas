-- Rematrícula feita pela secretaria: buscar a família (responsável, CPF,
-- telefone ou nome do aluno) e abrir a jornada da família já identificada.
-- Depois disso o painel usa as mesmas funções da jornada (selecionar filhos,
-- adicionar irmão novo, escolher o plano), então a família continua do mesmo
-- ponto pelo link.

create or replace function public.staff_fold(p_text text)
returns text language sql immutable set search_path to '' as $$
  select lower(translate(coalesce(p_text, ''),
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇç',
    'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc'))
$$;

create or replace function public.staff_search_rematricula_families(p_term text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_campaign public.campaigns;
  v_term text := public.staff_fold(trim(coalesce(p_term, '')));
  v_digits text := regexp_replace(coalesce(p_term, ''), '\D', '', 'g');
begin
  if not public.is_staff() then raise exception 'Apenas a equipe pode buscar famílias' using errcode = '42501'; end if;
  if length(v_term) < 3 and length(v_digits) < 4 then return '[]'::jsonb; end if;
  select * into v_campaign from public.campaigns where kind = 'rematricula' and status = 'ativa' order by starts_on desc limit 1;
  if not found then raise exception 'Não há campanha de rematrícula ativa' using errcode = 'P0001'; end if;

  return coalesce((
    with hits as (
      select distinct g.id
        from public.guardians g
        left join public.student_guardians sg on sg.guardian_id = g.id
        left join public.students s on s.id = sg.student_id
       where (length(v_term) >= 3 and (public.staff_fold(g.full_name) like '%' || v_term || '%' or public.staff_fold(s.full_name) like '%' || v_term || '%'))
          or (length(v_digits) >= 4 and (g.cpf like '%' || v_digits || '%' or regexp_replace(coalesce(g.phone, ''), '\D', '', 'g') like '%' || v_digits || '%'))
       limit 25
    )
    select jsonb_agg(jsonb_build_object(
      'guardian_id', g.id, 'full_name', g.full_name, 'cpf', g.cpf, 'phone', g.phone, 'email', g.email,
      'session', (select jsonb_build_object('token', os.token, 'stage', public.onboarding_stage(os.id))
                    from public.enrollment_onboarding_sessions os
                   where os.guardian_id = g.id and os.campaign_id = v_campaign.id and os.status not in ('cancelada', 'concluida')
                   order by os.updated_at desc limit 1),
      'children', coalesce((
        select jsonb_agg(jsonb_build_object(
          'student_id', s.id, 'name', s.full_name, 'class_name', cl.name, 'current_grade', cg.name,
          'next_grade_id', ng.id, 'next_grade', ng.name,
          'amount_cents', case when ng.id is not null then public.enrollment_amount_for_date(v_campaign.id, ng.id, false) end,
          'enrollment_id', e.id, 'is_new_student', coalesce(e.is_new_student, false),
          'target_grade', tg.name, 'enrollment_amount_cents', e.amount_cents,
          'signed_at', e.signed_at, 'status', e.status)
          order by s.full_name)
          from public.student_guardians sg
          join public.students s on s.id = sg.student_id
          left join public.classes cl on cl.id = s.current_class_id
          left join public.grades cg on cg.id = cl.grade_id
          left join public.grades ng on ng.id = cg.next_grade_id
          left join public.enrollments e on e.student_id = s.id and e.campaign_id = v_campaign.id
          left join public.grades tg on tg.id = e.target_grade_id
         where sg.guardian_id = g.id), '[]'::jsonb)
    ) order by g.full_name)
    from public.guardians g where g.id in (select id from hits)
  ), '[]'::jsonb);
end $$;

grant execute on function public.staff_search_rematricula_families(text) to authenticated;

-- Jornada da família já identificada (reaproveita a que estiver aberta).
create or replace function public.staff_start_rematricula(p_guardian_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_campaign public.campaigns;
  v_session public.enrollment_onboarding_sessions;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe pode iniciar a rematrícula' using errcode = '42501'; end if;
  if not exists (select 1 from public.guardians where id = p_guardian_id) then raise exception 'Responsável não encontrado' using errcode = 'P0002'; end if;
  v_campaign := public.onboarding_campaign('rematricula');
  select * into v_session from public.enrollment_onboarding_sessions
   where guardian_id = p_guardian_id and campaign_id = v_campaign.id and status not in ('cancelada', 'concluida')
   order by updated_at desc limit 1 for update;
  if not found then
    insert into public.enrollment_onboarding_sessions (campaign_id, flow, guardian_id, status, current_step, context)
    values (v_campaign.id, 'rematricula', p_guardian_id, 'filhos', 2,
            jsonb_build_object('identified_at', now(), 'started_by_staff', auth.uid()))
    returning * into v_session;
  end if;
  return jsonb_build_object('token', v_session.token, 'flow', v_session.flow, 'stage', public.onboarding_stage(v_session.id));
end $$;

grant execute on function public.staff_start_rematricula(uuid) to authenticated;
