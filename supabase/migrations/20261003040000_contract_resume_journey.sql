-- "Ir para o pagamento" na página do contrato: links de assinatura gerados
-- pelo painel não vêm de uma jornada. A partir do token do contrato, acha (ou
-- cria) a jornada da família com os alunos do contrato, para a família
-- escolher a forma de pagamento e pagar pelo Asaas.

create or replace function public.contract_resume_journey(p_token text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_contract public.contract_sessions;
  v_kind public.campaign_kind;
  v_session public.enrollment_onboarding_sessions;
begin
  select * into v_contract from public.contract_sessions where token = trim(p_token);
  if not found or v_contract.status in ('cancelada', 'expirada') then
    raise exception 'Link de contrato inválido ou expirado' using errcode = 'P0002';
  end if;
  select kind into v_kind from public.campaigns where id = v_contract.campaign_id;

  -- A jornada que já tem alunos deste contrato; senão a mais recente da família.
  select s.* into v_session
    from public.enrollment_onboarding_sessions s
    left join public.enrollment_onboarding_items oi on oi.onboarding_session_id = s.id
     and oi.enrollment_id in (select enrollment_id from public.contract_session_enrollments where contract_session_id = v_contract.id)
   where s.guardian_id = v_contract.guardian_id and s.campaign_id = v_contract.campaign_id and s.status <> 'cancelada'
   group by s.id
   order by count(oi.enrollment_id) desc, s.updated_at desc
   limit 1;

  if not found then
    insert into public.enrollment_onboarding_sessions (campaign_id, flow, guardian_id, status, current_step, context)
    values (v_contract.campaign_id, v_kind, v_contract.guardian_id, 'contratos', 3,
            jsonb_build_object('identified_at', now(), 'from_contract_session', v_contract.id, 'values_confirmed_at', now()))
    returning * into v_session;
  end if;

  -- Alunos do contrato passam para esta jornada (cada matrícula fica em uma só).
  update public.enrollment_onboarding_items oi set onboarding_session_id = v_session.id
   where oi.enrollment_id in (select enrollment_id from public.contract_session_enrollments where contract_session_id = v_contract.id)
     and oi.onboarding_session_id <> v_session.id;
  insert into public.enrollment_onboarding_items (onboarding_session_id, enrollment_id)
  select v_session.id, cse.enrollment_id
    from public.contract_session_enrollments cse
   where cse.contract_session_id = v_contract.id
     and not exists (select 1 from public.enrollment_onboarding_items oi where oi.enrollment_id = cse.enrollment_id);

  update public.enrollment_onboarding_sessions
     set status = case when status in ('filhos', 'dados', 'identificacao') then 'contratos' else status end,
         context = case when context ? 'values_confirmed_at' then context else context || jsonb_build_object('values_confirmed_at', now()) end,
         last_opened_at = now()
   where id = v_session.id
   returning * into v_session;

  return jsonb_build_object('token', v_session.token, 'flow', v_session.flow, 'stage', public.onboarding_stage(v_session.id));
end $$;

grant execute on function public.contract_resume_journey(text) to anon, authenticated;
