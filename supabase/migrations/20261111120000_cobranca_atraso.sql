-- Cobrança em atraso: vencimento prorrogado + aviso.
--
-- A equipe prorroga o vencimento de um boleto vencido (asaas-admin, ação
-- `reschedule`): a cobrança no Asaas continua a mesma (mesmo link), só muda a
-- data e a linha digitável. `installments.rescheduled_from` guarda o
-- vencimento original. Na Automação (modo Cobrança), essas cobranças entram
-- com o modelo `cobranca_atraso` e um `charge_id` próprio (`<id>#atraso`),
-- para não se confundir com o aviso que já saiu antes do vencimento.
-- Depois do texto sai, como sempre, a 2ª mensagem com o código (já com a
-- data nova).
--
-- A automação é desligada aqui: a equipe confere a lista e liga pelo painel.

alter table public.installments add column if not exists rescheduled_from date;
comment on column public.installments.rescheduled_from is 'Vencimento original, quando a escola prorrogou a cobrança';

insert into public.automation_templates (key, label, sort, body) values
('cobranca_atraso', 'Cobrança em atraso: vencimento prorrogado', 14, $t$Oi, {{responsavel}}! Tudo bem? 😊

Aqui é da secretaria do CEC. Passando pra avisar que ainda não identificamos o pagamento do boleto da {{parcela}} da rematrícula 2027 de {{alunos}}, que venceu em {{vencimento_anterior}}.

Se você já pagou, pode desconsiderar. Se puder, me manda o comprovante por aqui que a gente confere 🙏

Se ainda não pagou, sem problema: prorrogamos o vencimento pra {{vencimento}}, no mesmo valor de {{valor}}. É só abrir o mesmo link de antes:
{{link}}

Logo abaixo te mando o código do boleto atualizado (o anterior não vale mais). Só um aviso importante: se o pagamento não for feito até {{vencimento}}, a rematrícula pode ser suspensa. Qualquer dúvida, é só me chamar aqui 💙
---
Olá, {{responsavel}}, tudo bem?

Aqui é do CEC. Até agora não consta o pagamento da {{parcela}} da rematrícula 2027 de {{alunos}}, no valor de {{valor}}, que vencia em {{vencimento_anterior}}.

Caso já tenha pago, é só me enviar o comprovante por aqui que a gente confere 😊

Se ainda não pagou, liberamos o pagamento até {{vencimento}}, pelo mesmo link:
{{link}}

Na próxima mensagem vai o código do boleto com a data nova. Importante: sem o pagamento até {{vencimento}}, a rematrícula pode ser suspensa. Qualquer dúvida, estou por aqui 💙$t$)
on conflict (key) do update set body = excluded.body, label = excluded.label, sort = excluded.sort, updated_at = now();

-- Mesma assinatura. Novidade: cobrança prorrogada vira `<id>#atraso` com o
-- modelo de atraso; o "já avisado" e o "tirada pela equipe" olham esse id.
create or replace function public.billing_candidates()
returns table (
  charge_id text, guardian_id uuid, guardian_name text, phone text, students text,
  due_date date, amount_cents bigint, method text, parcela text, school_chose boolean,
  media_url text, link text, template_key text, block text, body text)
language plpgsql stable security definer set search_path to '' as $$
#variable_conflict use_column
declare v_set public.automation_settings; v_today date := public.local_today();
begin
  select * into v_set from public.automation_settings where id = 1;
  return query
  with ins as (
    select i.provider_charge_id as cid, i.due_date as due, i.amount_cents as cents, i.method::text as m,
           i.number as n, i.boleto_line, i.pix_code, i.payment_url, i.rescheduled_from as prev,
           e.id as eid, e.guardian_id as gid, st.full_name as sname,
           exists (select 1 from public.enrollment_onboarding_items oi
                     join public.enrollment_onboarding_sessions s on s.id = oi.onboarding_session_id
                    where oi.enrollment_id = e.id and s.context->>'billing_chosen_by' = 'escola') as chose1,
           (select count(*) from public.installments i2 where i2.enrollment_id = e.id
              and i2.status <> 'cancelado' and i2.number < 1000) as total
      from public.installments i
      join public.enrollments e on e.id = i.enrollment_id
      join public.campaigns c on c.id = e.campaign_id
       and c.academic_year = (select max(c2.academic_year) from public.campaigns c2 where c2.status::text = 'ativa')
      join public.students st on st.id = e.student_id
     where i.status = 'pendente' and i.provider_charge_id is not null and i.number < 1000
       and coalesce(i.method::text, 'boleto') in ('boleto', 'pix')
       and i.due_date between v_today and v_today + v_set.billing_lead_days
  ),
  charges as (
    select cid, min(due) as due, sum(cents)::bigint as cents, min(m) as m, min(n) as n, max(total) as total,
           (array_agg(gid))[1] as gid, min(prev) as prev,
           max(boleto_line) as line, max(pix_code) as pix, max(payment_url) as url,
           public.pt_join(array_agg(distinct initcap(lower(split_part(sname, ' ', 1))))) as names,
           bool_or(chose1) as chose
      from ins group by cid
  ),
  keyed as (
    select ch.*, case when ch.prev is not null then ch.cid || '#atraso' else ch.cid end as ckey
      from charges ch
  ),
  judged as (
    select k.*, g.full_name as gname, g.phone as gphone,
      case when k.prev is not null then 'cobranca_atraso'
           when k.m = 'pix' then 'cobranca_pix' else 'cobranca_boleto' end as tkey,
      case when k.total <= 1 then 'parcela única' else k.n || 'ª parcela (de ' || k.total || ')' end as parc,
      case
        when g.phone is null or length(regexp_replace(g.phone, '\D', '', 'g')) < 12 then 'sem_telefone'
        when g.opted_out_at is not null then 'pediu_para_sair'
        when exists (select 1 from public.message_queue q where q.origin = 'cobranca' and q.ref = k.ckey
                      and q.status in ('enviada', 'processando', 'falhou')) then 'ja_avisado'
        when exists (select 1 from public.message_queue q where q.origin = 'cobranca' and q.ref = k.ckey
                      and q.status = 'cancelada') then 'tirada_pela_equipe'
        when k.url is null then 'sem_link'
        when k.m = 'pix' and k.pix is null then 'sem_pix'
        when k.m <> 'pix' and k.line is null then 'sem_boleto'
      end as why
      from keyed k join public.guardians g on g.id = k.gid
  )
  select j.ckey, j.gid, j.gname, j.gphone, j.names, j.due, j.cents, j.m, j.parc, j.chose,
         null::text, j.url, j.tkey, j.why,
         replace(
           public.billing_render(j.tkey, j.gid::text, public.automation_first_name(j.gname), j.names, j.parc, j.cents,
                                 j.due, j.line, j.pix, j.url, j.chose and j.prev is null),
           '{{vencimento_anterior}}', coalesce(to_char(j.prev, 'DD/MM'), ''))
    from judged j
   order by (j.why is null) desc, j.due, j.gname;
end $$;
revoke all on function public.billing_candidates() from public, anon, authenticated;

-- O código aceita o id com sufixo (`<id>#atraso`).
create or replace function public.billing_code(p_charge_id text)
returns text language sql stable security definer set search_path to '' as $$
  select case when bool_or(i.method::text = 'pix') then max(i.pix_code) else max(i.boleto_line) end
    from public.installments i where i.provider_charge_id = split_part(p_charge_id, '#', 1)
$$;
revoke all on function public.billing_code(text) from public, anon, authenticated;

create or replace function public.staff_billing_skip(p_charge_id text, p_skip boolean default true)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gid uuid;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe' using errcode = '42501'; end if;
  if p_skip then
    select e.guardian_id into v_gid from public.installments i join public.enrollments e on e.id = i.enrollment_id
     where i.provider_charge_id = split_part(p_charge_id, '#', 1) limit 1;
    if v_gid is null then raise exception 'Cobrança não encontrada'; end if;
    if not exists (select 1 from public.message_queue where origin = 'cobranca' and ref = p_charge_id and status = 'cancelada') then
      insert into public.message_queue (campaign_id, guardian_id, attempt_number, body, status, origin, ref, last_error, scheduled_for)
      values ((select id from public.campaigns where kind::text = 'rematricula' and status::text = 'ativa' order by starts_on desc limit 1),
              v_gid, 1, '(tirada da cobrança pela equipe)', 'cancelada', 'cobranca', p_charge_id, 'Tirada pela equipe', now());
    end if;
  else
    update public.message_queue set status = 'falhou', origin = 'cobranca_desfeita'
     where origin = 'cobranca' and ref = p_charge_id and status = 'cancelada';
  end if;
  return public.staff_billing_overview();
end $$;

-- Painel: passa a mandar o modelo de cada família e o vencimento original.
create or replace function public.staff_billing_overview()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_set public.automation_settings; v_counts record;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe' using errcode = '42501'; end if;
  select * into v_set from public.automation_settings where id = 1;
  select * into v_counts from public.automation_sent_counts();
  return (
    with cand as (select * from public.billing_candidates())
    select jsonb_build_object(
      'settings', to_jsonb(v_set) - 'cron_token',
      'in_window', public.automation_in_window(v_set),
      'today', public.local_today(),
      'counts', jsonb_build_object('today', v_counts.today, 'last_hour', v_counts.last_hour, 'failed_today', v_counts.failed_today),
      'templates', (select coalesce(jsonb_agg(to_jsonb(t) - 'updated_by' order by t.sort), '[]'::jsonb)
                      from public.automation_templates t where t.key like 'cobranca%'),
      'eligible', (select count(*) from cand where block is null),
      'by_block', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
          select coalesce(block, 'pode_receber') k, count(*) n from cand group by 1) x),
      'candidates', (select coalesce(jsonb_agg(jsonb_build_object(
          'charge_id', charge_id, 'guardian_id', guardian_id, 'name', guardian_name, 'phone', phone,
          'students', students, 'due_date', due_date, 'amount_cents', amount_cents, 'method', method,
          'parcela', parcela, 'school_chose', school_chose, 'link', link, 'template_key', template_key,
          'rescheduled_from', (select min(i.rescheduled_from) from public.installments i
                                where i.provider_charge_id = split_part(charge_id, '#', 1)),
          'code', public.billing_code(charge_id),
          'block', block, 'body', body)), '[]'::jsonb) from cand),
      'recent', (select coalesce(jsonb_agg(r order by r->>'at' desc), '[]'::jsonb) from (
          select jsonb_build_object(
            'queue_id', q.id, 'at', coalesce(q.sent_at, q.updated_at), 'status', q.status,
            'error', q.last_error, 'name', g.full_name, 'phone', g.phone, 'guardian_id', g.id, 'body', q.body,
            'code_status', (select q2.status from public.message_queue q2 where q2.origin = 'cobranca_codigo' and q2.ref = q.ref
                             order by q2.created_at desc limit 1),
            'replied', exists (select 1 from public.messages m join public.conversations cv on cv.id = m.conversation_id
                                where cv.guardian_id = g.id and m.direction = 'entrada' and m.created_at > q.sent_at)) as r
            from public.message_queue q join public.guardians g on g.id = q.guardian_id
           where q.origin = 'cobranca'
           order by coalesce(q.sent_at, q.updated_at) desc limit 120) rr)
    ) from (select 1) one
  );
end $$;

update public.automation_settings set enabled = false where id = 1;
