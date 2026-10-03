-- Contrato 2027 com o layout novo (logo, quadro com rótulos e assinaturas
-- lado a lado), 3 páginas. O arquivo fica no Storage (contract-files/templates)
-- e o gerador o carrega pelo prefixo "storage:", sem depender do site.
-- O mesmo PDF está em public/contracts/contrato-cec-2027-v7.pdf.
-- Rascunhos v6 ainda não assinados são refeitos ao abrir a página do contrato.

update public.document_versions v set is_current = false
  from public.documents d
 where d.id = v.document_id and d.code = 'contrato_prestacao' and v.is_current;

insert into public.document_versions (document_id, version, pages, storage_path, sha256, is_current, published_at)
select d.id, 'v7-contrato-cec-2027-layout', 3, 'storage:templates/contrato-cec-2027-v7.pdf',
       '549a2d550dfdf763900a648a81333f760b6bc2025a3a73cbbdb83c128571bb81', true, now()
  from public.documents d where d.code = 'contrato_prestacao';
