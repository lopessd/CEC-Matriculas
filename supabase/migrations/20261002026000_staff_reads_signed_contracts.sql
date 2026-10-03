-- Contratos privados: somente usuários da equipe autenticada podem abrir os PDFs.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'equipe lê contratos privados'
  ) then
    create policy "equipe lê contratos privados"
    on storage.objects for select to authenticated
    using (bucket_id = 'contract-files' and (select public.is_staff()));
  end if;
end $$;
