-- Etapa Cobrança: a família escolhe em quantas vezes e como pagar juntos.
-- À vista libera o Pix; parcelado é só boleto ou cartão. Se o número de vezes
-- mudar depois de assinar (o contrato deixa plano e vencimento em branco), as
-- parcelas são refeitas — só enquanto não existe cobrança nem pagamento.

create or replace function public.onboarding_choose_billing_plan(p_token text, p_installments smallint, p_method public.payment_method)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_session public.enrollment_onboarding_sessions;
  v_choice jsonb;
  v_plan public.payment_plans;
  v_enrollment public.enrollments;
  v_base integer;
  v_max integer;
  i integer;
begin
  select * into v_session from public.enrollment_onboarding_sessions
   where token = trim(p_token) and guardian_id is not null and status <> 'cancelada' for update;
  if not found then raise exception 'Jornada inválida ou expirada' using errcode = 'P0002'; end if;
  if p_method not in ('boleto', 'pix', 'cartao') then raise exception 'Forma de pagamento inválida' using errcode = '22023'; end if;
  if p_method = 'pix' and p_installments > 1 then raise exception 'O Pix é só à vista. Parcelado, escolha boleto ou cartão.' using errcode = '22023'; end if;
  if exists (select 1 from public.enrollment_onboarding_items oi join public.enrollments e on e.id = oi.enrollment_id
              where oi.onboarding_session_id = v_session.id and e.signed_at is null) then
    raise exception 'Assine os contratos antes de escolher a forma de pagamento' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.enrollment_onboarding_items oi join public.installments it on it.enrollment_id = oi.enrollment_id
              where oi.onboarding_session_id = v_session.id and it.status <> 'cancelado'
                and (it.provider_charge_id is not null or it.status = 'pago')) then
    raise exception 'As cobranças já foram geradas. Use os links de pagamento.' using errcode = 'P0001';
  end if;

  select o into v_choice from jsonb_array_elements(public.payment_plan_choices(v_session.campaign_id, public.local_today())) o
   where (o ->> 'installments')::int = p_installments;
  if v_choice is null then raise exception 'Esta condição de pagamento não está disponível hoje' using errcode = '22023'; end if;
  select * into v_plan from public.payment_plans where id = (v_choice ->> 'payment_plan_id')::uuid;

  for v_enrollment in
    select e.* from public.enrollment_onboarding_items oi join public.enrollments e on e.id = oi.enrollment_id
     where oi.onboarding_session_id = v_session.id for update of e
  loop
    if v_enrollment.payment_plan_id is distinct from v_plan.id
       or (select count(*) from public.installments where enrollment_id = v_enrollment.id and status <> 'cancelado') <> v_plan.installments then
      -- Parcelas antigas saem do caminho (canceladas e renumeradas acima de 1000).
      select coalesce(max(number), 0) into v_max from public.installments where enrollment_id = v_enrollment.id;
      update public.installments set status = 'cancelado', number = number + v_max + 1000
       where enrollment_id = v_enrollment.id and status in ('pendente', 'vencido') and number < 1000;
      update public.enrollments set payment_plan_id = v_plan.id where id = v_enrollment.id;
      v_base := v_enrollment.amount_cents / v_plan.installments;
      for i in 1 .. v_plan.installments loop
        insert into public.installments (enrollment_id, number, amount_cents, due_date, method)
        values (v_enrollment.id, i, v_base + case when i = 1 then v_enrollment.amount_cents - v_base * v_plan.installments else 0 end,
                v_plan.due_dates[i], p_method);
      end loop;
      insert into public.enrollment_events(enrollment_id, code, title, body, actor, metadata)
      values (v_enrollment.id, 'PAYMENT_PLAN_CHOSEN', 'Condição de pagamento escolhida',
              'Família escolheu ' || v_plan.installments || 'x depois de assinar.', 'responsavel', v_choice);
    end if;
    update public.enrollments set preferred_payment_method = p_method, status = 'aguardando_pagamento' where id = v_enrollment.id;
    update public.installments set method = p_method where enrollment_id = v_enrollment.id and status = 'pendente';
    insert into public.enrollment_events(enrollment_id, code, title, body, actor, metadata)
    values (v_enrollment.id, 'PAYMENT_CHOICE_CONFIRMED', 'Forma de pagamento escolhida', 'Família escolheu como pagar depois de assinar.', 'responsavel',
            jsonb_build_object('method', p_method, 'installments', v_plan.installments));
  end loop;

  update public.enrollment_onboarding_sessions
     set context = context || jsonb_build_object('plan_choice', v_choice || jsonb_build_object('chosen_at', now()),
                                                 'billing_method', p_method, 'billing_chosen_at', now()),
         last_opened_at = now()
   where id = v_session.id;
  return public.onboarding_open(v_session.token);
end $$;

grant execute on function public.onboarding_choose_billing_plan(text, smallint, public.payment_method) to anon, authenticated;
