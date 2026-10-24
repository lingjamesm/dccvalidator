-- Phase 1 foundation: profiles, submissions (versioned workspace log), files,
-- shares, audit log, and the private storage bucket.
--
-- Isolation model
--   * Every user-facing table has row level security on.
--   * Nothing is readable unless the session has passed 2FA (JWT aal = aal2).
--   * A submission (and its files) is readable by its owner, or by a user holding
--     an active share that covers it: one submission, or the owner's whole
--     workspace (which includes submissions made after the share).
--   * Only owners can write, and only while a submission is still a draft or
--     freshly uploaded. Scores and results are written by the service role.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- True when the caller's session has completed 2FA.
create or replace function private.is_mfa()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  company text,
  role text not null default 'submitter' check (role in ('submitter', 'admin')),
  created_at timestamptz not null default now()
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- entry_id groups the versions of one logged entry; the first version's id.
  entry_id uuid,
  version integer not null default 1,
  title text not null check (char_length(title) between 1 and 200),
  channel text not null check (channel in ('pos', 'atm', 'ecommerce')),
  schemes text[] not null check (
    cardinality(schemes) > 0 and schemes <@ array['visa', 'mastercard']::text[]
  ),
  status text not null default 'draft'
    check (status in ('draft', 'uploaded', 'processing', 'complete', 'failed')),
  rule_set_version text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index submissions_owner_idx on public.submissions (owner_id, created_at desc);
create index submissions_entry_idx on public.submissions (entry_id, version);

create table public.submission_files (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null
    check (mime_type in ('image/png', 'image/jpeg', 'application/pdf')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
  -- Phase 2 (PAN masking) moves files from quarantine to masked or rejected.
  status text not null default 'quarantine'
    check (status in ('quarantine', 'masked', 'rejected')),
  pan_masked_count integer,
  created_at timestamptz not null default now()
);

create index submission_files_submission_idx on public.submission_files (submission_id);

create table public.shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  owner_label text not null default '',
  invited_email text not null check (invited_email = lower(invited_email)),
  recipient_id uuid references auth.users (id) on delete cascade,
  scope text not null check (scope in ('submission', 'workspace')),
  submission_id uuid references public.submissions (id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'active', 'revoked')),
  -- sha256 of the emailed invite token; cleared once the invite is accepted.
  token_hash text unique,
  invite_expires_at timestamptz not null default now() + interval '7 days',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  check ((scope = 'submission') = (submission_id is not null))
);

create index shares_recipient_idx on public.shares (recipient_id) where status = 'active';
create index shares_owner_idx on public.shares (owner_id);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  target_type text not null,
  target_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_actor_idx on public.audit_log (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Access check used by the policies. SECURITY DEFINER so it can consult
-- shares without recursing through the shares policies.
-- ---------------------------------------------------------------------------

create or replace function private.can_read_submission(sub_owner uuid, sub_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_mfa() and (
    sub_owner = auth.uid()
    or exists (
      select 1
      from public.shares s
      where s.recipient_id = auth.uid()
        and s.owner_id = sub_owner
        and s.status = 'active'
        and (s.expires_at is null or s.expires_at > now())
        and (s.scope = 'workspace' or s.submission_id = sub_id)
    )
  )
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Profile row for every new account.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, company)
  values (
    new.id,
    lower(new.email),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'company'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- New submissions start as drafts; a resubmission joins its entry as the next version.
create or replace function private.prepare_submission()
returns trigger
language plpgsql
as $$
begin
  new.status := 'draft';
  new.result := null;
  new.rule_set_version := null;
  if new.entry_id is null then
    new.entry_id := new.id;
    new.version := 1;
  else
    select coalesce(max(version), 0) + 1 into new.version
    from public.submissions
    where entry_id = new.entry_id;
  end if;
  return new;
end;
$$;

create trigger submissions_prepare
  before insert on public.submissions
  for each row execute function private.prepare_submission();

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger submissions_touch
  before update on public.submissions
  for each row execute function private.touch_updated_at();

-- Audit trail for user-visible actions.
create or replace function private.audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec record;
  detail jsonb := '{}'::jsonb;
begin
  if tg_op = 'DELETE' then
    rec := old;
  else
    rec := new;
  end if;
  if tg_table_name = 'shares' then
    detail := jsonb_build_object(
      'scope', rec.scope,
      'status', rec.status,
      'invited_email', rec.invited_email,
      'submission_id', rec.submission_id
    );
  elsif tg_table_name = 'submissions' then
    detail := jsonb_build_object('status', rec.status, 'version', rec.version);
  elsif tg_table_name = 'submission_files' then
    detail := jsonb_build_object('submission_id', rec.submission_id, 'name', rec.original_name);
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, detail)
  values (auth.uid(), lower(tg_op), tg_table_name, rec.id, detail);
  return rec;
end;
$$;

create trigger submissions_audit after insert or update or delete on public.submissions
  for each row execute function private.audit();
create trigger submission_files_audit after insert or delete on public.submission_files
  for each row execute function private.audit();
create trigger shares_audit after insert or update on public.shares
  for each row execute function private.audit();

-- The name a recipient sees on a share comes from the owner's profile, not
-- from anything the owner types.
create or replace function private.label_share()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select coalesce(nullif(p.full_name, ''), p.email)
         || coalesce(' (' || nullif(p.company, '') || ')', '')
  into new.owner_label
  from public.profiles p
  where p.id = new.owner_id;
  new.invited_email := lower(new.invited_email);
  new.status := 'invited';
  new.recipient_id := null;
  return new;
end;
$$;

create trigger shares_label
  before insert on public.shares
  for each row execute function private.label_share();

-- ---------------------------------------------------------------------------
-- Accepting a share invite. The emailed token alone grants nothing: the
-- caller must be signed in with 2FA, and their verified email must match the
-- invited address.
-- ---------------------------------------------------------------------------

create or replace function public.accept_share(invite_token text)
returns table (share_id uuid, scope text, submission_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.shares;
  caller_email text;
begin
  if not private.is_mfa() then
    raise exception 'Two-factor authentication required' using errcode = '42501';
  end if;

  select lower(u.email) into caller_email
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;

  if caller_email is null then
    raise exception 'A verified email address is required' using errcode = '42501';
  end if;

  select * into s
  from public.shares sh
  where sh.token_hash = encode(sha256(convert_to(invite_token, 'UTF8')), 'hex')
  for update;

  if s.id is null
     or s.status <> 'invited'
     or s.invite_expires_at <= now()
     or s.invited_email <> caller_email
     or s.owner_id = auth.uid() then
    raise exception 'This invitation is not valid for your account' using errcode = '42501';
  end if;

  update public.shares sh
  set status = 'active', recipient_id = auth.uid(), accepted_at = now(), token_hash = null
  where sh.id = s.id;

  return query select s.id, s.scope, s.submission_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: explicit, least privilege. anon gets nothing.
-- ---------------------------------------------------------------------------

grant usage on schema private to authenticated;
grant execute on function private.is_mfa() to authenticated;
grant execute on function private.can_read_submission(uuid, uuid) to authenticated;
revoke all on function public.accept_share(text) from public, anon;
grant execute on function public.accept_share(text) to authenticated;

revoke all on public.profiles, public.submissions, public.submission_files,
  public.shares, public.audit_log from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, company) on public.profiles to authenticated;

grant select, delete on public.submissions to authenticated;
grant insert (title, channel, schemes, entry_id) on public.submissions to authenticated;
grant update (title, status) on public.submissions to authenticated;

grant select, delete on public.submission_files to authenticated;
grant insert (submission_id, storage_path, original_name, mime_type, size_bytes)
  on public.submission_files to authenticated;

grant select on public.shares to authenticated;
grant insert (invited_email, scope, submission_id, token_hash, expires_at)
  on public.shares to authenticated;
grant update (status, revoked_at) on public.shares to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.submissions enable row level security;
alter table public.submission_files enable row level security;
alter table public.shares enable row level security;
alter table public.audit_log enable row level security;
-- audit_log: no policies, so only the service role (admin tools) can read it.

create policy "profiles: read own" on public.profiles
  for select to authenticated
  using (private.is_mfa() and id = auth.uid());

create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (private.is_mfa() and id = auth.uid())
  with check (id = auth.uid());

create policy "submissions: owner or shared" on public.submissions
  for select to authenticated
  using (private.can_read_submission(owner_id, id));

create policy "submissions: owner creates" on public.submissions
  for insert to authenticated
  with check (
    private.is_mfa()
    and owner_id = auth.uid()
    and (
      -- a new entry (the trigger sets entry_id to the row's own id) ...
      entry_id = id
      -- ... or a new version of an entry the caller owns
      or exists (
        select 1 from public.submissions prev
        where prev.id = entry_id and prev.entry_id = prev.id and prev.owner_id = auth.uid()
      )
    )
  );

create policy "submissions: owner edits before processing" on public.submissions
  for update to authenticated
  using (private.is_mfa() and owner_id = auth.uid() and status in ('draft', 'uploaded'))
  with check (owner_id = auth.uid() and status in ('draft', 'uploaded'));

create policy "submissions: owner deletes" on public.submissions
  for delete to authenticated
  using (private.is_mfa() and owner_id = auth.uid());

create policy "files: owner or shared" on public.submission_files
  for select to authenticated
  using (private.can_read_submission(owner_id, submission_id));

create policy "files: owner adds to own draft" on public.submission_files
  for insert to authenticated
  with check (
    private.is_mfa()
    and owner_id = auth.uid()
    and storage_path like auth.uid()::text || '/' || submission_id::text || '/%'
    and exists (
      select 1 from public.submissions s
      where s.id = submission_id and s.owner_id = auth.uid() and s.status = 'draft'
    )
  );

create policy "files: owner removes from own draft" on public.submission_files
  for delete to authenticated
  using (
    private.is_mfa()
    and owner_id = auth.uid()
    and exists (
      select 1 from public.submissions s
      where s.id = submission_id and s.owner_id = auth.uid() and s.status = 'draft'
    )
  );

create policy "shares: owner or recipient reads" on public.shares
  for select to authenticated
  using (private.is_mfa() and (owner_id = auth.uid() or recipient_id = auth.uid()));

create policy "shares: owner invites" on public.shares
  for insert to authenticated
  with check (
    private.is_mfa()
    and owner_id = auth.uid()
    and token_hash is not null
    and (
      scope = 'workspace'
      or exists (
        select 1 from public.submissions s
        where s.id = submission_id and s.owner_id = auth.uid()
      )
    )
  );

create policy "shares: owner revokes" on public.shares
  for update to authenticated
  using (private.is_mfa() and owner_id = auth.uid())
  with check (owner_id = auth.uid() and status = 'revoked');

-- ---------------------------------------------------------------------------
-- Storage: one private bucket, a folder per user: <user id>/<submission id>/<file>
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('submissions', 'submissions', false, 20971520,
        array['image/png', 'image/jpeg', 'application/pdf'])
on conflict (id) do nothing;

create policy "storage: owner uploads to own draft" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'submissions'
    and private.is_mfa()
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.submissions s
      where s.id::text = (storage.foldername(name))[2]
        and s.owner_id = auth.uid()
        and s.status = 'draft'
    )
  );

create policy "storage: owner or shared reads" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'submissions'
    and private.is_mfa()
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.submission_files f
        where f.storage_path = name
          and private.can_read_submission(f.owner_id, f.submission_id)
      )
    )
  );

create policy "storage: owner deletes from own draft" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'submissions'
    and private.is_mfa()
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.submissions s
      where s.id::text = (storage.foldername(name))[2]
        and s.owner_id = auth.uid()
        and s.status = 'draft'
    )
  );
