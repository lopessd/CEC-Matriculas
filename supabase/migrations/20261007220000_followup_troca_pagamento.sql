-- Follow-up: pedido aberto de troca da forma de pagamento vira categoria
-- própria ("troca_pagamento"), acima de todas. Linhas ao vivo também passam
-- a trazer o último envio da equipe pelo sistema (ícone de contatado).

do $migration$
declare d text; n text; prev text;
begin
  d := pg_get_functiondef('public.staff_debug_followup(text)'::regprocedure);
  n := d;
  prev := n;
  n := replace(n,
    $a$case when pa.v is not null then 'esperando_escola' else r.categoria end as categoria$a$,
    $b$case when pa.v->>'motivo' = 'troca_forma_pagamento' then 'troca_pagamento' when pa.v is not null then 'esperando_escola' else r.categoria end as categoria$b$);
  if n = prev then raise exception 'staff_debug_followup: trecho esperado não encontrado'; end if;
  prev := n;
  n := replace(n,
    $a$case y.categoria when 'esperando_escola' then 1$a$,
    $b$case y.categoria when 'troca_pagamento' then 0 when 'esperando_escola' then 1$b$);
  if n = prev then raise exception 'staff_debug_followup: trecho esperado não encontrado'; end if;
  prev := n;
  n := replace(n,
    $a$'categoria', 'esperando_escola',$a$,
    $b$'categoria', case when pa.v->>'motivo' = 'troca_forma_pagamento' then 'troca_pagamento' else 'esperando_escola' end,$b$);
  if n = prev then raise exception 'staff_debug_followup: trecho esperado não encontrado'; end if;
  prev := n;
  n := replace(n,
    $a$'ordem', 1,$a$,
    $b$'ordem', case when pa.v->>'motivo' = 'troca_forma_pagamento' then 0 else 1 end,$b$);
  if n = prev then raise exception 'staff_debug_followup: trecho esperado não encontrado'; end if;
  prev := n;
  n := replace(n,
    $a$'ultimo_envio_painel', null)$a$,
    $b$'ultimo_envio_painel', (select jsonb_build_object('at', m.created_at, 'by', sp.full_name, 'status', m.status::text)
           from public.messages m join public.conversations cv on cv.id = m.conversation_id
           left join public.profiles sp on sp.id = m.staff_id
          where cv.guardian_id = g.id and m.track_source = 'cec_staff' order by m.created_at desc limit 1))$b$);
  if n = prev then raise exception 'staff_debug_followup: trecho esperado não encontrado'; end if;
  execute n;
end
$migration$;
