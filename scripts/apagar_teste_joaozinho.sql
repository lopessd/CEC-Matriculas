-- Apaga o teste de matrícula nova do Davi (aluno Joaozinho, 06/10/2026).
-- Rodar no SQL Editor do Supabase DEPOIS de excluir no Asaas a cobrança
-- pay_pjbokr49n6vzylya (e, se quiser, o cliente cus_000205140515).
--
-- O cadastro 0852c382 foi aberto pelo WhatsApp quando a secretaria escreveu
-- para o Davi, por isso ficou com o nome da escola ("Centro Ed. Cristão").
-- Apaga tudo: cadastro, conversa, aluno, contrato, parcelas e jornada.
--
-- Um bloco só (DO): se qualquer passo falhar, nada é apagado.

do $$
declare
  v_guardian constant uuid := '0852c382-c43a-4787-8ac4-500055abfc49';
  v_enrollments uuid[];
  v_installments uuid[];
  v_students uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_enrollments
    from public.enrollments where guardian_id = v_guardian;
  select coalesce(array_agg(id), '{}') into v_installments
    from public.installments where enrollment_id = any (v_enrollments);

  -- Alunos que só esse cadastro tem (o Joaozinho)
  select coalesce(array_agg(sg.student_id), '{}') into v_students
    from public.student_guardians sg
   where sg.guardian_id = v_guardian
     and not exists (select 1 from public.student_guardians other
                      where other.student_id = sg.student_id and other.guardian_id <> v_guardian);

  delete from public.enrollment_onboarding_items where enrollment_id = any (v_enrollments);
  delete from public.enrollment_onboarding_sessions where guardian_id = v_guardian;
  delete from public.contract_session_enrollments where enrollment_id = any (v_enrollments);
  delete from public.contract_sessions where guardian_id = v_guardian;
  delete from public.document_acceptances where enrollment_id = any (v_enrollments);
  delete from public.installments where id = any (v_installments);
  delete from public.finance_ledger
   where installment_id = any (v_installments) or enrollment_id = any (v_enrollments) or guardian_id = v_guardian;
  delete from public.message_queue where guardian_id = v_guardian;
  delete from public.journey_stage_overrides where guardian_id = v_guardian;
  delete from public.enrollments where id = any (v_enrollments);

  -- Conversa do WhatsApp (as mensagens vão junto), cadastro e aluno
  delete from public.conversations where guardian_id = v_guardian;
  delete from public.guardians where id = v_guardian;
  delete from public.students where id = any (v_students);

  raise notice 'Apagados: % matrícula(s), % parcela(s), % aluno(s)',
    cardinality(v_enrollments), cardinality(v_installments), cardinality(v_students);
end $$;

-- Conferência: tudo zero
select
  (select count(*) from public.guardians where id = '0852c382-c43a-4787-8ac4-500055abfc49')            as cadastro,
  (select count(*) from public.enrollments where id = '7a229cf0-a2d2-4620-968e-f24b4293d871')          as matricula,
  (select count(*) from public.installments where provider_charge_id = 'pay_pjbokr49n6vzylya')         as parcela_asaas,
  (select count(*) from public.finance_ledger where installment_id = '114273b1-705e-48dd-ac40-1904568424b9') as extrato;
