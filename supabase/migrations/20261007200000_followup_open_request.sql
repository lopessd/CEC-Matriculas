-- Follow-up: pedido de humano da IA ainda sem resposta da equipe, ao vivo.
-- O levantamento (debug_followup_review) é uma foto; este sinal vem do banco
-- agora. Conta como aberto o último HANDOFF_REQUESTED da IA para a família
-- quando nenhuma mensagem da equipe saiu depois dele.

create or replace function public.followup_open_request(p_guardian_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object('motivo', ev.body, 'em', ev.created_at)
    from public.enrollment_events ev
    join public.enrollments en on en.id = ev.enrollment_id
   where en.guardian_id = p_guardian_id
     and ev.code = 'HANDOFF_REQUESTED'
     and not exists (
       select 1 from public.messages m join public.conversations cv on cv.id = m.conversation_id
        where cv.guardian_id = p_guardian_id and m.sender = 'equipe' and m.created_at > ev.created_at)
   order by ev.created_at desc
   limit 1
$$;

revoke all on function public.followup_open_request(uuid) from public, anon, authenticated;

create or replace function public.staff_debug_followup(p_snapshot text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare v_snap text; v_rows jsonb; v_live jsonb;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe' using errcode = '42501'; end if;
  v_snap := coalesce(p_snapshot, (select snapshot from public.debug_followup_review order by gerado_em desc limit 1));

  select coalesce(jsonb_agg(to_jsonb(x) order by x.ordem, x.ultima_msg_em desc nulls last), '[]'::jsonb) into v_rows from (
    select y.*,
      case y.categoria when 'esperando_escola' then 1 when 'nao_identificado' then 2 when 'combinado' then 3 when 'link_parado' then 4
        when 'pai_sumiu' then 5 when 'adiou' then 6 when 'pagamento' then 7 when 'financeiro_2026' then 8 when 'concluido' then 9 else 10 end as ordem
    from (
      select r.id, r.snapshot, r.chat_id, r.phone, r.contato_whatsapp,
        case when pa.v is not null then 'esperando_escola' else r.categoria end as categoria,
        r.categoria as categoria_levantamento,
        r.identificacao,
        case when pa.v is not null then 'escola' else r.aguardando end as aguardando,
        r.alunos_hint, r.resumo, r.parou_em, r.pendencia, r.flags, r.ultima_msg_de, r.ultima_msg_em, r.ultima_msg_familia_em,
        r.msgs_familia, r.msgs_ia, r.msgs_equipe, r.transcript, r.gerado_em,
        pa.v as pedido_aberto, false as ao_vivo,
        g.id as guardian_id, g.full_name as responsavel,
        (select string_agg(st.full_name || coalesce(' · ' || cl.name, ''), ' | ' order by st.full_name)
           from public.student_guardians sg join public.students st on st.id = sg.student_id
           left join public.classes cl on cl.id = st.current_class_id where sg.guardian_id = g.id) as alunos_base,
        (select public.onboarding_stage(s.id) from public.enrollment_onboarding_sessions s
          where s.guardian_id = g.id and s.status <> 'cancelada' order by s.updated_at desc limit 1) as etapa_agora,
        (select cv.handler::text from public.conversations cv where cv.guardian_id = g.id order by cv.last_message_at desc nulls last limit 1) as atendimento_agora,
        coalesce(h.hidden, false) as oculto, coalesce(h.ai_off, false) as ia_desligada, h.reason as oculto_motivo, h.note as oculto_nota, h.set_at as oculto_em, p.full_name as oculto_por,
        (select jsonb_build_object('at', m.created_at, 'by', sp.full_name, 'status', m.status::text)
           from public.messages m join public.conversations cv on cv.id = m.conversation_id
           left join public.profiles sp on sp.id = m.staff_id
          where cv.guardian_id = g.id and m.track_source = 'cec_staff' order by m.created_at desc limit 1) as ultimo_envio_painel
      from public.debug_followup_review r
      left join public.guardians g on g.phone = r.phone
      left join public.followup_hidden h on h.phone = r.phone
      left join public.profiles p on p.id = h.set_by
      left join lateral (select public.followup_open_request(g.id) as v) pa on g.id is not null
      where r.snapshot = v_snap
    ) y
  ) x;

  -- Pedidos abertos de quem não está no levantamento: entram ao vivo, com
  -- as últimas mensagens gravadas no banco.
  select coalesce(jsonb_agg(z order by (z->>'ultima_msg_em') desc nulls last), '[]'::jsonb) into v_live from (
    select jsonb_build_object(
      'id', null, 'snapshot', v_snap, 'chat_id', regexp_replace(g.phone, '\D', '', 'g'), 'phone', g.phone,
      'contato_whatsapp', null, 'categoria', 'esperando_escola', 'categoria_levantamento', null,
      'identificacao', 'base', 'aguardando', 'escola', 'alunos_hint', null,
      'resumo', 'Fora do levantamento. A IA chamou a secretaria e ninguém da equipe respondeu depois.',
      'parou_em', to_char(((pa.v->>'em')::timestamptz) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || ' · IA chamou a secretaria',
      'pendencia', 'Responder a família pelo WhatsApp.', 'flags', '[]'::jsonb,
      'ultima_msg_de', lm.de, 'ultima_msg_em', lm.at, 'ultima_msg_familia_em', null,
      'msgs_familia', null, 'msgs_ia', null, 'msgs_equipe', null,
      'transcript', coalesce((
        select jsonb_agg(jsonb_build_object('t', t.created_at,
                 'de', case t.sender::text when 'ia' then 'ia' when 'equipe' then 'equipe' else 'familia' end,
                 'tipo', 'Conversation', 'texto', t.body) order by t.created_at)
          from (select m.* from public.messages m join public.conversations cv on cv.id = m.conversation_id
                 where cv.guardian_id = g.id and m.sender::text <> 'sistema' order by m.created_at desc limit 30) t), '[]'::jsonb),
      'gerado_em', now(), 'pedido_aberto', pa.v, 'ao_vivo', true, 'ordem', 1,
      'guardian_id', g.id, 'responsavel', g.full_name,
      'alunos_base', (select string_agg(st.full_name || coalesce(' · ' || cl.name, ''), ' | ' order by st.full_name)
           from public.student_guardians sg join public.students st on st.id = sg.student_id
           left join public.classes cl on cl.id = st.current_class_id where sg.guardian_id = g.id),
      'etapa_agora', (select public.onboarding_stage(s.id) from public.enrollment_onboarding_sessions s
          where s.guardian_id = g.id and s.status <> 'cancelada' order by s.updated_at desc limit 1),
      'atendimento_agora', (select cv.handler::text from public.conversations cv where cv.guardian_id = g.id order by cv.last_message_at desc nulls last limit 1),
      'oculto', coalesce(h.hidden, false), 'ia_desligada', coalesce(h.ai_off, false), 'oculto_motivo', h.reason, 'oculto_nota', h.note,
      'oculto_em', h.set_at, 'oculto_por', null, 'ultimo_envio_painel', null) as z
    from (select distinct en.guardian_id from public.enrollment_events ev
            join public.enrollments en on en.id = ev.enrollment_id where ev.code = 'HANDOFF_REQUESTED') gg
    join public.guardians g on g.id = gg.guardian_id
    cross join lateral (select public.followup_open_request(g.id) as v) pa
    left join public.followup_hidden h on h.phone = g.phone
    left join lateral (
      select m.created_at as at, case m.sender::text when 'ia' then 'ia' when 'equipe' then 'equipe' else 'familia' end as de
        from public.messages m join public.conversations cv on cv.id = m.conversation_id
       where cv.guardian_id = g.id order by m.created_at desc limit 1) lm on true
    where pa.v is not null
      and g.phone is not null
      and g.phone not in (select r.phone from public.debug_followup_review r where r.snapshot = v_snap and r.phone is not null)
  ) q(z);

  return jsonb_build_object('snapshot', v_snap,
    'snapshots', (select coalesce(jsonb_agg(distinct snapshot), '[]'::jsonb) from public.debug_followup_review),
    'rows', v_live || v_rows);
end $function$;
