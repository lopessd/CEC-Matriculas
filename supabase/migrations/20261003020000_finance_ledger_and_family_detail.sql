-- Financeiro: livro de movimentações (recebimentos, estornos, vínculos com o
-- Asaas, caixa físico), parcelas com o estado do Asaas, lista de parcelas para
-- o painel e a ficha completa da família.

-- Estado da cobrança no Asaas e origem da baixa.
alter table public.installments
  add column if not exists asaas_status text,
  add column if not exists asaas_synced_at timestamptz,
  add column if not exists paid_source text;

comment on column public.installments.paid_source is 'manual (secretaria), asaas (webhook/sync) ou asaas_manual (secretaria e registrado no Asaas)';

create table if not exists public.finance_ledger (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  kind text not null check (kind in ('recebimento', 'estorno', 'status', 'vinculo', 'caixa_entrada', 'caixa_saida', 'caixa_deposito', 'ajuste')),
  source text not null default 'manual' check (source in ('manual', 'asaas', 'asaas_sync', 'asaas_webhook', 'sistema')),
  amount_cents integer,
  method text,
  installment_id uuid,
  enrollment_id uuid,
  guardian_id uuid,
  provider_charge_id text,
  from_status text,
  to_status text,
  description text,
  actor_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists finance_ledger_occurred_idx on public.finance_ledger (occurred_at desc);
create index if not exists finance_ledger_guardian_idx on public.finance_ledger (guardian_id);
create index if not exists finance_ledger_installment_idx on public.finance_ledger (installment_id);

alter table public.finance_ledger enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_ledger' and policyname = 'equipe lê o financeiro') then
    create policy "equipe lê o financeiro" on public.finance_ledger for select to authenticated using ((select public.is_staff()));
  end if;
end $$;

-- Origem da baixa: quem chama finance_apply_installment informa; uma
-- atualização do serviço (webhook) conta como Asaas; o resto é a secretaria.
create or replace function public.finance_current_source()
returns text language sql stable set search_path to '' as $$
  select coalesce(nullif(current_setting('app.finance_source', true), ''),
                  case when coalesce(auth.role(), '') = 'service_role' then 'asaas' else 'manual' end)
$$;

create or replace function public.installments_before()
returns trigger language plpgsql set search_path to '' as $$
begin
  if new.status = 'pago' then
    new.paid_at           := coalesce(new.paid_at, now());
    new.paid_amount_cents := coalesce(new.paid_amount_cents, new.amount_cents);
    if tg_op = 'INSERT' or old.status is distinct from 'pago' then
      new.paid_source := coalesce(nullif(current_setting('app.finance_paid_source', true), ''),
                                  case public.finance_current_source() when 'manual' then 'manual' else 'asaas' end);
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'pago' then
    new.paid_source := null;
  end if;
  -- Forma de pagamento escolhida antes da assinatura vale para as parcelas novas.
  if tg_op = 'INSERT' and new.method is null then
    select e.preferred_payment_method into new.method from public.enrollments e where e.id = new.enrollment_id;
  end if;
  return new;
end $$;

-- Toda mudança de status ou de vínculo com o Asaas vira uma linha no livro.
create or replace function public.installments_ledger()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  v_guardian uuid;
  v_kind text;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then return null; end if;
  if new.status is not distinct from old.status
     and new.provider_charge_id is not distinct from old.provider_charge_id then
    return null;
  end if;
  select guardian_id into v_guardian from public.enrollments where id = new.enrollment_id;
  begin v_actor := nullif(current_setting('app.finance_actor', true), '')::uuid; exception when others then v_actor := null; end;
  v_actor := coalesce(v_actor, auth.uid());

  if new.status is distinct from old.status then
    v_kind := case
      when new.status = 'pago' then 'recebimento'
      when old.status = 'pago' then 'estorno'
      else 'status' end;
    insert into public.finance_ledger (kind, source, amount_cents, method, installment_id, enrollment_id, guardian_id,
                                       provider_charge_id, from_status, to_status, description, actor_id, occurred_at)
    values (v_kind, public.finance_current_source(),
            case when v_kind = 'estorno' then coalesce(old.paid_amount_cents, old.amount_cents) else coalesce(new.paid_amount_cents, new.amount_cents) end,
            coalesce(new.method, old.method)::text, new.id, new.enrollment_id, v_guardian, new.provider_charge_id,
            old.status::text, new.status::text, nullif(current_setting('app.finance_note', true), ''), v_actor,
            case when new.status = 'pago' then coalesce(new.paid_at, now()) else now() end);
  end if;

  if new.provider_charge_id is distinct from old.provider_charge_id then
    insert into public.finance_ledger (kind, source, amount_cents, installment_id, enrollment_id, guardian_id,
                                       provider_charge_id, description, actor_id)
    values ('vinculo', public.finance_current_source(), new.amount_cents, new.id, new.enrollment_id, v_guardian,
            coalesce(new.provider_charge_id, old.provider_charge_id),
            case when new.provider_charge_id is null then 'Cobrança desvinculada (' || old.provider_charge_id || ')'
                 else 'Cobrança do Asaas vinculada' end,
            v_actor);
  end if;
  return null;
end $$;

create or replace trigger installments_ledger after update on public.installments
  for each row execute function public.installments_ledger();

-- Usada pelas Edge Functions (service role): aplica a mudança na parcela com a
-- origem e o autor certos no livro.
create or replace function public.finance_apply_installment(
  p_installment_id uuid, p_patch jsonb, p_source text, p_actor uuid default null, p_note text default null)
returns public.installments language plpgsql security definer set search_path to '' as $$
declare v_row public.installments;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Uso interno' using errcode = '42501'; end if;
  perform set_config('app.finance_source', coalesce(p_source, 'sistema'), true);
  perform set_config('app.finance_actor', coalesce(p_actor::text, ''), true);
  perform set_config('app.finance_note', coalesce(p_note, ''), true);
  perform set_config('app.finance_paid_source', coalesce(p_patch->>'paid_source', ''), true);
  update public.installments i set
    status            = coalesce((p_patch->>'status')::public.installment_status, i.status),
    method            = case when p_patch ? 'method' then (p_patch->>'method')::public.payment_method else i.method end,
    paid_at           = case when p_patch ? 'paid_at' then (p_patch->>'paid_at')::timestamptz else i.paid_at end,
    paid_amount_cents = case when p_patch ? 'paid_amount_cents' then (p_patch->>'paid_amount_cents')::integer else i.paid_amount_cents end,
    provider          = case when p_patch ? 'provider' then p_patch->>'provider' else i.provider end,
    provider_charge_id= case when p_patch ? 'provider_charge_id' then p_patch->>'provider_charge_id' else i.provider_charge_id end,
    payment_url       = case when p_patch ? 'payment_url' then p_patch->>'payment_url' else i.payment_url end,
    bank_slip_url     = case when p_patch ? 'bank_slip_url' then p_patch->>'bank_slip_url' else i.bank_slip_url end,
    boleto_line       = case when p_patch ? 'boleto_line' then p_patch->>'boleto_line' else i.boleto_line end,
    pix_code          = case when p_patch ? 'pix_code' then p_patch->>'pix_code' else i.pix_code end,
    asaas_status      = case when p_patch ? 'asaas_status' then p_patch->>'asaas_status' else i.asaas_status end,
    asaas_synced_at   = case when p_patch ? 'asaas_synced_at' then (p_patch->>'asaas_synced_at')::timestamptz else i.asaas_synced_at end
  where i.id = p_installment_id
  returning * into v_row;
  if not found then raise exception 'Parcela não encontrada' using errcode = 'P0002'; end if;
  return v_row;
end $$;

revoke all on function public.finance_apply_installment(uuid, jsonb, text, uuid, text) from public, anon, authenticated;
grant execute on function public.finance_apply_installment(uuid, jsonb, text, uuid, text) to service_role;

-- Caixa físico: entrada, saída ou depósito no banco feitos pela secretaria.
create or replace function public.staff_add_cash_movement(
  p_kind text, p_amount_cents integer, p_description text, p_occurred_on date default null, p_guardian_id uuid default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_id uuid;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe registra o caixa' using errcode = '42501'; end if;
  if p_kind not in ('caixa_entrada', 'caixa_saida', 'caixa_deposito', 'ajuste') then raise exception 'Tipo de movimento inválido' using errcode = '22023'; end if;
  if coalesce(p_amount_cents, 0) <= 0 then raise exception 'Informe um valor maior que zero' using errcode = '22023'; end if;
  if length(trim(coalesce(p_description, ''))) < 3 then raise exception 'Descreva o movimento' using errcode = '22023'; end if;
  insert into public.finance_ledger (kind, source, amount_cents, method, guardian_id, description, actor_id, occurred_at)
  values (p_kind, 'manual', p_amount_cents, 'dinheiro', p_guardian_id, trim(p_description), auth.uid(),
          coalesce(p_occurred_on::timestamp at time zone 'America/Sao_Paulo' + interval '12 hours', now()))
  returning id into v_id;
  return v_id;
end $$;

grant execute on function public.staff_add_cash_movement(text, integer, text, date, uuid) to authenticated;

create or replace view public.v_finance_ledger with (security_invoker = true) as
select l.*,
       g.full_name as guardian_name,
       st.full_name as student_name,
       i.number as installment_number,
       i.due_date,
       p.full_name as actor_name
  from public.finance_ledger l
  left join public.guardians g on g.id = l.guardian_id
  left join public.enrollments e on e.id = l.enrollment_id
  left join public.students st on st.id = e.student_id
  left join public.installments i on i.id = l.installment_id
  left join public.profiles p on p.id = l.actor_id;

grant select on public.v_finance_ledger to authenticated;

-- Parcelas com família, aluno e campanha (Pagamentos e Matriculados).
create or replace view public.v_installment_list with (security_invoker = true) as
select i.*,
       e.guardian_id,
       g.full_name as guardian_name,
       g.phone as guardian_phone,
       g.cpf as guardian_cpf,
       g.asaas_customer_id,
       e.student_id,
       st.full_name as student_name,
       gr.name as grade_name,
       e.campaign_id,
       c.name as campaign_name,
       c.kind::text as campaign_kind,
       pp.name as payment_plan_name,
       e.signed_at as enrollment_signed_at
  from public.installments i
  join public.enrollments e on e.id = i.enrollment_id
  join public.students st on st.id = e.student_id
  left join public.guardians g on g.id = e.guardian_id
  left join public.grades gr on gr.id = e.target_grade_id
  left join public.campaigns c on c.id = e.campaign_id
  left join public.payment_plans pp on pp.id = e.payment_plan_id;

grant select on public.v_installment_list to authenticated;

-- Forma de pagamento da família (antes ou depois da assinatura).
create or replace function public.staff_set_family_billing(p_guardian_id uuid, p_method text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_count integer;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe define a forma de pagamento' using errcode = '42501'; end if;
  if p_method not in ('boleto', 'pix', 'cartao', 'dinheiro') then raise exception 'Forma de pagamento inválida' using errcode = '22023'; end if;
  update public.enrollments e set preferred_payment_method = p_method::public.payment_method
   where e.guardian_id = p_guardian_id
     and e.campaign_id in (select id from public.campaigns where status = 'ativa');
  get diagnostics v_count = row_count;
  update public.installments i set method = p_method::public.payment_method
   where i.status in ('pendente', 'vencido') and i.provider_charge_id is null
     and i.enrollment_id in (select e.id from public.enrollments e where e.guardian_id = p_guardian_id
                               and e.campaign_id in (select id from public.campaigns where status = 'ativa'));
  update public.enrollment_onboarding_sessions s set context = s.context || jsonb_build_object('billing_method', p_method)
   where s.guardian_id = p_guardian_id and s.status <> 'cancelada'
     and s.campaign_id in (select id from public.campaigns where status = 'ativa');
  insert into public.enrollment_events (enrollment_id, code, title, body, actor, actor_id)
  select e.id, 'BILLING_SET', 'Forma de pagamento definida', 'Definida pela equipe: ' || p_method, 'equipe', auth.uid()
    from public.enrollments e where e.guardian_id = p_guardian_id
     and e.campaign_id in (select id from public.campaigns where status = 'ativa');
  return jsonb_build_object('ok', true, 'enrollments', v_count);
end $$;

grant execute on function public.staff_set_family_billing(uuid, text) to authenticated;

-- Ficha da família: aceita o id do responsável ou de qualquer matrícula dele.
create or replace function public.staff_family_detail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_guardian public.guardians;
  v_enrollment_ids uuid[];
begin
  if not public.is_staff() then raise exception 'Apenas a equipe pode ver a família' using errcode = '42501'; end if;
  select * into v_guardian from public.guardians where id = p_id;
  if not found then
    select g.* into v_guardian from public.guardians g join public.enrollments e on e.guardian_id = g.id where e.id = p_id;
  end if;
  if not found then return null; end if;
  select coalesce(array_agg(id), '{}') into v_enrollment_ids from public.enrollments where guardian_id = v_guardian.id;

  return jsonb_build_object(
    'guardian', jsonb_build_object(
      'id', v_guardian.id, 'full_name', v_guardian.full_name, 'phone', v_guardian.phone, 'email', v_guardian.email,
      'cpf', v_guardian.cpf, 'rg', v_guardian.rg, 'address', v_guardian.address, 'notes', v_guardian.notes,
      'asaas_customer_id', v_guardian.asaas_customer_id, 'opted_out_at', v_guardian.opted_out_at, 'created_at', v_guardian.created_at),
    'enrollments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'campaign_id', e.campaign_id, 'campaign_name', c.name, 'campaign_kind', c.kind, 'campaign_active', c.status = 'ativa',
        'academic_year', c.academic_year, 'status', e.status, 'student_id', st.id, 'student_name', st.full_name,
        'birth_date', st.birth_date, 'grade_name', gr.name, 'from_class_name', fc.name, 'amount_cents', e.amount_cents,
        'discount_pct', e.discount_pct, 'payment_plan_id', e.payment_plan_id, 'payment_plan_name', pp.name,
        'preferred_payment_method', e.preferred_payment_method, 'is_new_student', e.is_new_student,
        'signed_at', e.signed_at, 'paid_at', e.paid_at, 'completed_at', e.completed_at, 'lost_at', e.lost_at,
        'created_at', e.created_at, 'updated_at', e.updated_at)
        order by c.academic_year desc, st.full_name)
        from public.enrollments e
        join public.campaigns c on c.id = e.campaign_id
        join public.students st on st.id = e.student_id
        left join public.grades gr on gr.id = e.target_grade_id
        left join public.classes fc on fc.id = e.from_class_id
        left join public.payment_plans pp on pp.id = e.payment_plan_id
       where e.guardian_id = v_guardian.id), '[]'::jsonb),
    'installments', coalesce((
      select jsonb_agg(to_jsonb(i) || jsonb_build_object('student_name', st.full_name) order by i.due_date, st.full_name, i.number)
        from public.installments i
        join public.enrollments e on e.id = i.enrollment_id
        join public.students st on st.id = e.student_id
       where i.enrollment_id = any(v_enrollment_ids)), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', da.id, 'enrollment_id', da.enrollment_id, 'student_name', st.full_name, 'status', da.status,
        'provider', da.provider, 'version', dv.version, 'title', d.title, 'signer_full_name', da.signer_full_name,
        'signer_email', da.signer_email, 'completed_at', da.completed_at, 'generated_at', da.generated_at,
        'signed_storage_path', da.signed_storage_path, 'generated_storage_path', da.generated_storage_path,
        'legacy', coalesce((da.generation_data->>'legado')::boolean, false))
        order by da.generated_at desc nulls last, da.created_at desc)
        from public.document_acceptances da
        join public.document_versions dv on dv.id = da.document_version_id
        join public.documents d on d.id = dv.document_id
        join public.enrollments e on e.id = da.enrollment_id
        join public.students st on st.id = e.student_id
       where da.enrollment_id = any(v_enrollment_ids)), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(x order by x->>'created_at' desc) from (
        select jsonb_build_object('id', ev.id, 'code', ev.code, 'title', ev.title, 'body', ev.body, 'actor', ev.actor,
                                  'created_at', ev.created_at, 'student_name', st.full_name) as x
          from public.enrollment_events ev
          join public.enrollments e on e.id = ev.enrollment_id
          join public.students st on st.id = e.student_id
         where ev.enrollment_id = any(v_enrollment_ids)
         order by ev.created_at desc limit 150) t), '[]'::jsonb),
    'journeys', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'token', s.token, 'flow', s.flow, 'status', s.status, 'stage', public.onboarding_stage(s.id),
        'campaign_id', s.campaign_id, 'plan_name', s.context->'plan_choice'->>'name', 'billing_method', s.context->>'billing_method',
        'last_opened_at', s.last_opened_at, 'updated_at', s.updated_at) order by s.updated_at desc)
        from public.enrollment_onboarding_sessions s
        join public.campaigns c on c.id = s.campaign_id and c.status = 'ativa'
       where s.guardian_id = v_guardian.id and s.status <> 'cancelada'), '[]'::jsonb),
    'contracts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', cs.id, 'token', cs.token, 'status', cs.status, 'confirmation_email', cs.confirmation_email,
        'created_at', cs.created_at, 'expires_at', cs.expires_at, 'signed_at', cs.signed_at, 'open_count', cs.open_count,
        'students', (select jsonb_agg(st.full_name order by st.full_name) from public.contract_session_enrollments cse
                       join public.enrollments e on e.id = cse.enrollment_id join public.students st on st.id = e.student_id
                      where cse.contract_session_id = cs.id)) order by cs.created_at desc)
        from public.contract_sessions cs where cs.guardian_id = v_guardian.id), '[]'::jsonb),
    'conversation', (
      select jsonb_build_object('id', cv.id, 'handler', cv.handler, 'last_message_at', cv.last_message_at,
                                'last_message_preview', cv.last_message_preview, 'ai_summary', cv.ai_summary, 'unread_count', cv.unread_count)
        from public.conversations cv where cv.guardian_id = v_guardian.id order by cv.last_message_at desc nulls last limit 1),
    'ledger', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.occurred_at desc) from public.v_finance_ledger l where l.guardian_id = v_guardian.id), '[]'::jsonb)
  );
end $$;

grant execute on function public.staff_family_detail(uuid) to authenticated;
