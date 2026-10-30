-- Promoção da rematrícula prorrogada: 31/10 → 06/11/2026.
-- Os dados (early_amount_until, payment_plans.available_until, automation_settings.deadline)
-- já foram trocados via REST em 30/10. Aqui só a regra padrão da função.
CREATE OR REPLACE FUNCTION public.payment_plan_for_closing(p_campaign_id uuid, p_closed_on date DEFAULT local_today())
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_installments smallint;
  v_plan_id uuid;
  v_campaign_kind public.campaign_kind;
begin
  select c.kind into v_campaign_kind from public.campaigns c where c.id = p_campaign_id;
  v_installments := case
    when v_campaign_kind = 'rematricula'::public.campaign_kind and p_closed_on <= '2026-11-06'::date then 3
    when v_campaign_kind = 'rematricula'::public.campaign_kind and p_closed_on <= '2027-01-10'::date then 1
    when v_campaign_kind <> 'rematricula'::public.campaign_kind and p_closed_on <= '2026-11-10'::date then 3
    when v_campaign_kind <> 'rematricula'::public.campaign_kind and p_closed_on <= '2026-12-10'::date then 2
    when v_campaign_kind <> 'rematricula'::public.campaign_kind and p_closed_on <= '2027-01-10'::date then 1
    else null
  end;
  if v_installments is null then
    raise exception 'O prazo de pagamento desta campanha terminou em 10/01/2027' using errcode = 'P0001';
  end if;
  select p.id into v_plan_id
    from public.payment_plans p
   where p.campaign_id = p_campaign_id
     and p.installments = v_installments
     and p.active
   order by p.sort_order
   limit 1;
  if v_plan_id is null then
    raise exception 'A condição de pagamento desta campanha não está configurada' using errcode = 'P0001';
  end if;
  return v_plan_id;
end $function$;
