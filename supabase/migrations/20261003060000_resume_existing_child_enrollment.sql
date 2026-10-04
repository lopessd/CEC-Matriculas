-- Retomada de matrícula nova: um aluno já salvo pelo formulário anterior não
-- pode criar uma segunda matrícula. Quando é o mesmo responsável, a matrícula
-- inacabada muda para a sessão aberta agora.

create or replace function public.onboarding_lookup_existing_family(
  p_token text,
  p_cpf text,
  p_phone text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.enrollment_onboarding_sessions;
  v_guardian public.guardians;
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
  v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  select * into v_session from public.enrollment_onboarding_sessions
   where token = p_token and flow = 'matricula_nova' and status <> 'cancelada' for update;
  if not found then raise exception 'Jornada inválida ou expirada' using errcode = 'P0002'; end if;

  if v_cpf !~ '^[0-9]{11}$' and length(v_phone) < 10 then
    return jsonb_build_object('found', false);
  end if;

  select * into v_guardian from public.guardians
   where (v_cpf ~ '^[0-9]{11}$' and cpf = v_cpf)
      or (length(v_phone) >= 10 and right(regexp_replace(phone, '\D', '', 'g'), 8) = right(v_phone, 8))
   order by case when v_cpf ~ '^[0-9]{11}$' and cpf = v_cpf then 0 else 1 end
   limit 1;
  if not found then return jsonb_build_object('found', false); end if;

  return jsonb_build_object(
    'found', true,
    'guardian', jsonb_build_object('name', v_guardian.full_name, 'cpf', v_guardian.cpf, 'phone', v_guardian.phone, 'email', v_guardian.email, 'address', v_guardian.address),
    'children', coalesce((
      select jsonb_agg(jsonb_build_object(
        'student_id', s.id,
        'name', s.full_name,
        'birth_date', s.birth_date,
        'previous_school', s.previous_school,
        'current_grade', current_grade.name,
        'target_grade_id', coalesce(current_enrollment.target_grade_id, target_grade.id),
        'target_grade', coalesce(enrollment_grade.name, target_grade.name)
      ) order by s.full_name)
        from public.student_guardians sg
        join public.students s on s.id = sg.student_id
        left join public.classes current_class on current_class.id = s.current_class_id
        left join public.grades current_grade on current_grade.id = current_class.grade_id
        left join public.grades target_grade on target_grade.id = current_grade.next_grade_id
        left join lateral (
          select e.target_grade_id
            from public.enrollments e
           where e.campaign_id = v_session.campaign_id and e.student_id = s.id
           order by e.updated_at desc
           limit 1
        ) current_enrollment on true
        left join public.grades enrollment_grade on enrollment_grade.id = current_enrollment.target_grade_id
       where sg.guardian_id = v_guardian.id
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.onboarding_create_matricula(
  p_token text, p_guardian_cpf text, p_guardian_name text, p_phone text,
  p_email text, p_address text, p_children jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.enrollment_onboarding_sessions;
  v_guardian public.guardians;
  v_child jsonb;
  v_student_id uuid;
  v_enrollment_id uuid;
  v_existing_enrollment public.enrollments;
  v_grade_id uuid;
  v_amount integer;
  v_cpf text := regexp_replace(coalesce(p_guardian_cpf, ''), '\D', '', 'g');
  v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_e164 text;
begin
  select * into v_session from public.enrollment_onboarding_sessions
   where token = p_token and flow = 'matricula_nova' and status <> 'cancelada' for update;
  if not found then raise exception 'Jornada inválida ou expirada' using errcode = 'P0002'; end if;
  perform public.onboarding_campaign('matricula_nova');
  if v_cpf !~ '^[0-9]{11}$' then raise exception 'Informe um CPF válido' using errcode = '22023'; end if;
  if nullif(trim(p_guardian_name), '') is null or nullif(trim(p_email), '') is null or nullif(trim(p_address), '') is null then raise exception 'Preencha nome, e-mail e endereço do responsável' using errcode = '22023'; end if;
  if v_phone !~ '^[0-9]{10,13}$' then raise exception 'Informe um WhatsApp válido' using errcode = '22023'; end if;
  if jsonb_typeof(p_children) <> 'array' or jsonb_array_length(p_children) = 0 then raise exception 'Informe pelo menos um aluno' using errcode = '22023'; end if;

  v_e164 := '+' || case when left(v_phone, 2) = '55' then v_phone else '55' || v_phone end;
  select * into v_guardian from public.guardians where cpf = v_cpf for update;
  if not found then
    select * into v_guardian from public.guardians
     where cpf is null and regexp_replace(coalesce(phone, ''), '\D', '', 'g') = substr(v_e164, 2)
     order by updated_at desc limit 1 for update;
  end if;
  if not found then
    insert into public.guardians(full_name, cpf, phone, email, address, whatsapp_consent_at)
    values(trim(p_guardian_name), v_cpf, v_e164, lower(trim(p_email)), trim(p_address), now()) returning * into v_guardian;
  else
    update public.guardians set full_name = trim(p_guardian_name), cpf = v_cpf, phone = v_e164,
      email = lower(trim(p_email)), address = trim(p_address), whatsapp_consent_at = coalesce(whatsapp_consent_at, now()), updated_at = now()
     where id = v_guardian.id returning * into v_guardian;
  end if;

  -- A mesma sessão pode ser enviada de novo sem criar vínculos repetidos.
  delete from public.enrollment_onboarding_items where onboarding_session_id = v_session.id;

  for v_child in select value from jsonb_array_elements(p_children) loop
    v_grade_id := nullif(v_child ->> 'gradeId', '')::uuid;
    if nullif(trim(v_child ->> 'name'), '') is null or v_grade_id is null then
      raise exception 'Cada aluno precisa de nome completo e série pretendida' using errcode = '22023';
    end if;
    select amount_cents into v_amount from public.grade_offerings
     where academic_year = (select academic_year from public.campaigns where id = v_session.campaign_id) and grade_id = v_grade_id;
    if v_amount is null then raise exception 'Uma das séries escolhidas não está disponível' using errcode = 'P0001'; end if;

    select s.id into v_student_id from public.students s join public.student_guardians sg on sg.student_id = s.id
     where sg.guardian_id = v_guardian.id and lower(s.full_name) = lower(trim(v_child ->> 'name'))
       and (nullif(v_child ->> 'birthDate', '') is null or s.birth_date = (v_child ->> 'birthDate')::date)
     limit 1;
    if v_student_id is null then
      insert into public.students(full_name, birth_date, previous_school)
      values(trim(v_child ->> 'name'), nullif(v_child ->> 'birthDate', '')::date, nullif(trim(v_child ->> 'previousSchool'), ''))
      returning id into v_student_id;
      insert into public.student_guardians(student_id, guardian_id, relationship, is_financial, is_primary_contact)
      values(v_student_id, v_guardian.id, 'responsável', true, true);
    end if;

    select * into v_existing_enrollment from public.enrollments
     where campaign_id = v_session.campaign_id and student_id = v_student_id for update;
    if found and v_existing_enrollment.guardian_id is distinct from v_guardian.id then
      raise exception 'Esta matrícula já está vinculada a outro responsável. Fale com a secretaria.' using errcode = 'P0001';
    end if;
    if found and v_existing_enrollment.signed_at is not null then
      raise exception 'A matrícula deste aluno já foi assinada. Use o link da matrícula já iniciada.' using errcode = 'P0001';
    end if;

    if not found then
      insert into public.enrollments(campaign_id, student_id, guardian_id, origin, target_grade_id, status, amount_cents, form_started_at)
      values(v_session.campaign_id, v_student_id, v_guardian.id, 'site', v_grade_id, 'aguardando_assinatura', v_amount, now())
      returning id into v_enrollment_id;
    else
      update public.enrollments set guardian_id = v_guardian.id, target_grade_id = v_grade_id,
        amount_cents = coalesce(amount_cents, v_amount), form_started_at = coalesce(form_started_at, now())
       where id = v_existing_enrollment.id returning id into v_enrollment_id;
    end if;

    -- O vínculo único do aluno sai da sessão anterior do mesmo responsável e
    -- passa para esta sessão. Assim a retomada não viola a restrição única.
    if exists (
      select 1 from public.enrollment_onboarding_items oi
      join public.enrollment_onboarding_sessions previous on previous.id = oi.onboarding_session_id
      where oi.enrollment_id = v_enrollment_id and previous.guardian_id is distinct from v_guardian.id
    ) then
      raise exception 'A matrícula deste aluno já está vinculada a outra família. Fale com a secretaria.' using errcode = 'P0001';
    end if;
    delete from public.enrollment_onboarding_items oi
      using public.enrollment_onboarding_sessions previous
     where oi.enrollment_id = v_enrollment_id
       and oi.onboarding_session_id = previous.id
       and previous.guardian_id = v_guardian.id;
    insert into public.enrollment_onboarding_items(onboarding_session_id, enrollment_id)
    values(v_session.id, v_enrollment_id);
  end loop;

  update public.enrollment_onboarding_sessions
     set guardian_id = v_guardian.id, status = 'contratos', current_step = 3,
         context = (context - 'values_confirmed_at' - 'plan_choice') || jsonb_build_object('identified_at', now()), last_opened_at = now()
   where id = v_session.id;
  return public.onboarding_open(p_token);
end $$;

revoke execute on function public.onboarding_lookup_existing_family(text, text, text), public.onboarding_create_matricula(text, text, text, text, text, text, jsonb) from public;
grant execute on function public.onboarding_lookup_existing_family(text, text, text), public.onboarding_create_matricula(text, text, text, text, text, text, jsonb) to anon, authenticated;
