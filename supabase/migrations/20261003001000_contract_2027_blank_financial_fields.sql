-- A versão v7 usa o mesmo modelo visual de 2027, mas o gerador deixa em
-- branco anuidade, 1ª parcela, vencimento e plano de pagamento. Uma nova
-- versão força a regeneração dos rascunhos ainda não assinados; os aceites
-- assinados das versões anteriores permanecem preservados.
update public.document_versions v set is_current = false
  from public.documents d
 where d.id = v.document_id and d.code = 'contrato_prestacao' and v.is_current;

insert into public.document_versions (document_id, version, pages, storage_path, sha256, is_current, published_at)
select d.id, 'v7-contrato-cec-2027-campos-financeiros-em-branco', 2,
       '/contracts/contrato-cec-2027.pdf',
       '1b7bd029787c49955681ee1cc439f5e905afc1880495aa791c7e07a498eb109c',
       true, now()
  from public.documents d where d.code = 'contrato_prestacao';
