-- Phase 2: card number masking.
--
-- Uploads now land in a locked "quarantine" bucket that no user can read. The
-- masking worker (service role) reads each file, writes a masked copy to the
-- "submissions" bucket at the same path, and deletes the original. Users can
-- no longer write to "submissions" directly, so only masked files are ever
-- downloadable.

alter table public.submission_files
  drop constraint submission_files_status_check,
  add constraint submission_files_status_check
    check (status in ('quarantine', 'processing', 'masked', 'rejected')),
  add column rejection_reason text,
  add column masked_at timestamptz;

create index submission_files_pending_idx on public.submission_files (created_at)
  where status in ('quarantine', 'processing');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quarantine', 'quarantine', false, 20971520,
        array['image/png', 'image/jpeg', 'application/pdf'])
on conflict (id) do nothing;

drop policy "storage: owner uploads to own draft" on storage.objects;

create policy "storage: owner uploads to quarantine for own draft" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'quarantine'
    and private.is_mfa()
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.submissions s
      where s.id::text = (storage.foldername(name))[2]
        and s.owner_id = auth.uid()
        and s.status = 'draft'
    )
  );
-- No select, update or delete policy on "quarantine": once uploaded, an
-- unmasked file is reachable only by the masking worker.
