-- A jornada única registra só o aceite do contrato; o regimento não ganha
-- aceite próprio. Sem isso, recompute_enrollment_progress nunca considerava a
-- matrícula assinada e o pagamento não a concluía. O contrato assinado
-- (signed_at) passa a valer como assinatura.
create or replace function public.recompute_enrollment_progress(p_enrollment_id uuid)
 returns void
 language plpgsql
 set search_path to ''
as $function$
declare
  v_e             public.enrollments;
  v_required      integer;
  v_done          integer;
  v_pending_docs  integer;
  v_total         integer;
  v_paid          integer;
  v_overdue       integer;
  v_first_paid    timestamptz;
  v_signed        boolean;
  v_new           public.journey_status;
begin
  select * into v_e from public.enrollments where id = p_enrollment_id for update;
  if not found or v_e.status in ('sem_interesse', 'opt_out', 'fora_campanha') then
    return;
  end if;

  select count(*),
         count(*) filter (where exists (
           select 1
           from public.document_acceptances a
           join public.document_versions v on v.id = a.document_version_id
           where a.enrollment_id = v_e.id and v.document_id = d.id and a.status in ('assinado', 'aceito')))
    into v_required, v_done
  from public.campaign_documents cd
  join public.documents d on d.id = cd.document_id
  where cd.campaign_id = v_e.campaign_id
    and d.requirement in ('assinatura_obrigatoria', 'aceite_obrigatorio');

  select count(*) into v_pending_docs
  from public.document_acceptances a
  where a.enrollment_id = v_e.id and a.status in ('pendente', 'enviado');

  select count(*),
         count(*) filter (where i.status = 'pago'),
         count(*) filter (where i.status = 'vencido'),
         min(i.paid_at) filter (where i.status = 'pago')
    into v_total, v_paid, v_overdue, v_first_paid
  from public.installments i
  where i.enrollment_id = v_e.id and i.status <> 'cancelado';

  v_signed := v_e.signed_at is not null
           or (v_required > 0 and v_done = v_required)
           or (v_required = 0 and v_total > 0);

  v_new := case
    when v_signed and v_overdue > 0 then 'pagamento_vencido'::public.journey_status
    when v_signed and v_paid > 0    then 'concluida'::public.journey_status
    when v_signed                   then 'aguardando_pagamento'::public.journey_status
    when v_pending_docs > 0 and coalesce(public.journey_rank(v_e.status) <= 5, false)
                                    then 'aguardando_assinatura'::public.journey_status
    else v_e.status
  end;

  update public.enrollments
     set status       = v_new,
         paid_at      = coalesce(paid_at, v_first_paid),
         signed_at    = case when v_signed then coalesce(signed_at, now()) else signed_at end,
         completed_at = case when v_signed and v_paid > 0 then coalesce(completed_at, now()) else completed_at end
   where id = v_e.id
     and (status is distinct from v_new
          or (v_first_paid is not null and paid_at is null)
          or (v_signed and signed_at is null)
          or (v_signed and v_paid > 0 and completed_at is null));
end $function$;
