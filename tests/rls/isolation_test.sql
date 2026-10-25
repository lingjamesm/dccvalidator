-- Isolation tests: prove that one user can never read or change another
-- user's submissions, files or stored objects unless the owner has shared them,
-- and that nothing is reachable without 2FA.
--
-- Run with tests/rls/run.sh. Any failed check stops the run with an error.

\set ON_ERROR_STOP on
\set QUIET on

create schema tests;
grant usage on schema tests to anon, authenticated;

-- Act as a signed-in user at the given assurance level (aal1 = password only,
-- aal2 = password + authenticator code).
create function tests.login(uid uuid, email text, aal text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', uid, 'email', email, 'role', 'authenticated', 'aal', aal)::text, false);
$$;

create function tests.ok(passed boolean, what text) returns void language plpgsql as $$
begin
  if passed is distinct from true then
    raise exception 'FAIL: %', what;
  end if;
  raise notice 'ok - %', what;
end
$$;

grant execute on all functions in schema tests to anon, authenticated;

create function tests.token_hash(t text) returns text language sql immutable as $$
  select encode(sha256(convert_to(t, 'UTF8')), 'hex')
$$;
grant execute on function tests.token_hash(text) to authenticated;

-- Fixed ids keep the script readable.
\set alice '''aaaaaaaa-0000-0000-0000-000000000001'''
\set bob   '''bbbbbbbb-0000-0000-0000-000000000002'''
\set carol '''cccccccc-0000-0000-0000-000000000003'''
\set a1    '''a1a1a1a1-0000-0000-0000-000000000001'''
\set a2    '''a2a2a2a2-0000-0000-0000-000000000002'''

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  (:alice, 'alice@example.com', now(), '{"full_name":"Alice Example","company":"Acme Payments"}'),
  (:bob,   'Bob@Example.com',   now(), '{"full_name":"Bob Example"}'),
  (:carol, 'carol@example.com', now(), '{}');

select tests.ok((select count(*) = 3 from public.profiles), 'a profile is created for every new account');

-- ---------------------------------------------------------------------------
-- Without 2FA nothing is reachable
-- ---------------------------------------------------------------------------
set role authenticated;
select tests.login(:alice, 'alice@example.com', 'aal1');

select tests.ok((select count(*) = 0 from public.profiles), 'aal1: own profile is hidden until 2FA');

do $$
begin
  insert into public.submissions (title, channel, schemes) values ('x', 'pos', array['visa']);
  raise exception 'FAIL: aal1 user created a submission';
exception when insufficient_privilege then
  raise notice 'ok - aal1: cannot create a submission';
end $$;

-- ---------------------------------------------------------------------------
-- Alice works in her own workspace
-- ---------------------------------------------------------------------------
select tests.login(:alice, 'alice@example.com', 'aal2');

insert into public.submissions (title, channel, schemes)
values ('Terminal screens v1', 'pos', array['visa', 'mastercard']);

-- Pin fixed ids so later steps can refer to them.
reset role;
update public.submissions set id = 'a1a1a1a1-0000-0000-0000-000000000001', entry_id = 'a1a1a1a1-0000-0000-0000-000000000001'
  where title = 'Terminal screens v1';
set role authenticated;

select tests.ok((select count(*) = 1 from public.submissions), 'alice sees her submission');
select tests.ok((select status = 'draft' and version = 1 from public.submissions where id = :a1),
  'a new submission starts as draft version 1');

insert into public.submission_files (submission_id, storage_path, original_name, mime_type, size_bytes)
values (:a1, 'aaaaaaaa-0000-0000-0000-000000000001/a1a1a1a1-0000-0000-0000-000000000001/screen.png',
        'screen.png', 'image/png', 1000);
insert into storage.objects (bucket_id, name)
values ('quarantine', 'aaaaaaaa-0000-0000-0000-000000000001/a1a1a1a1-0000-0000-0000-000000000001/screen.png');
select tests.ok(true, 'alice uploads a file into quarantine under her own folder');

select tests.ok((select count(*) = 0 from storage.objects where bucket_id = 'quarantine'),
  'an unmasked upload in quarantine is unreadable, even to its owner');

do $$
begin
  insert into storage.objects (bucket_id, name)
  values ('submissions', 'aaaaaaaa-0000-0000-0000-000000000001/a1a1a1a1-0000-0000-0000-000000000001/direct.png');
  raise exception 'FAIL: alice wrote straight to the masked files bucket';
exception when insufficient_privilege then
  raise notice 'ok - users cannot bypass masking by writing to the masked files bucket';
end $$;

-- The masking worker (service role) stores the masked copy.
reset role;
insert into storage.objects (bucket_id, name)
values ('submissions', 'aaaaaaaa-0000-0000-0000-000000000001/a1a1a1a1-0000-0000-0000-000000000001/screen.png');
update public.submission_files set status = 'masked', pan_masked_count = 1, masked_at = now();
set role authenticated;
select tests.ok((select count(*) = 1 from storage.objects where bucket_id = 'submissions'),
  'alice can read her masked file');

do $$
begin
  insert into public.submission_files (submission_id, storage_path, original_name, mime_type, size_bytes)
  values ('a1a1a1a1-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002/a1a1a1a1-0000-0000-0000-000000000001/x.png',
          'x.png', 'image/png', 10);
  raise exception 'FAIL: file row pointed outside the owner folder';
exception when insufficient_privilege then
  raise notice 'ok - a file row cannot point outside the owner''s folder';
end $$;

do $$
begin
  update public.submissions set status = 'complete' where id = 'a1a1a1a1-0000-0000-0000-000000000001';
  raise exception 'FAIL: owner marked her own submission complete';
exception when insufficient_privilege then
  raise notice 'ok - an owner cannot mark results complete (only the worker can)';
end $$;

do $$
begin
  update public.submissions set result = '{"score":100}' where id = 'a1a1a1a1-0000-0000-0000-000000000001';
  raise exception 'FAIL: owner wrote her own score';
exception when insufficient_privilege then
  raise notice 'ok - an owner cannot write her own score';
end $$;

insert into public.submissions (title, channel, schemes) values ('ATM screens', 'atm', array['visa']);
reset role;
update public.submissions set id = 'a2a2a2a2-0000-0000-0000-000000000002', entry_id = 'a2a2a2a2-0000-0000-0000-000000000002'
  where title = 'ATM screens';
set role authenticated;

-- ---------------------------------------------------------------------------
-- Bob cannot see or touch anything of Alice's
-- ---------------------------------------------------------------------------
select tests.login(:bob, 'bob@example.com', 'aal2');

select tests.ok((select count(*) = 0 from public.submissions), 'bob sees none of alice''s submissions');
select tests.ok((select count(*) = 0 from public.submission_files), 'bob sees none of alice''s files');
select tests.ok((select count(*) = 0 from storage.objects), 'bob sees none of alice''s stored objects');
select tests.ok((select count(*) = 1 from public.profiles), 'bob sees only his own profile');

do $$
declare n int;
begin
  update public.submissions set title = 'hijacked' where id = 'a1a1a1a1-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  perform tests.ok(n = 0, 'bob cannot rename alice''s submission');
  delete from public.submissions where id = 'a1a1a1a1-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  perform tests.ok(n = 0, 'bob cannot delete alice''s submission');
  delete from storage.objects;
  get diagnostics n = row_count;
  perform tests.ok(n = 0, 'bob cannot delete alice''s stored objects');
end $$;

do $$
begin
  insert into public.submission_files (submission_id, storage_path, original_name, mime_type, size_bytes)
  values ('a1a1a1a1-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001/a1a1a1a1-0000-0000-0000-000000000001/evil.png',
          'evil.png', 'image/png', 10);
  raise exception 'FAIL: bob added a file to alice''s submission';
exception when insufficient_privilege then
  raise notice 'ok - bob cannot add a file to alice''s submission';
end $$;

do $$
begin
  insert into storage.objects (bucket_id, name)
  values ('quarantine', 'aaaaaaaa-0000-0000-0000-000000000001/a1a1a1a1-0000-0000-0000-000000000001/evil.png');
  raise exception 'FAIL: bob uploaded into alice''s folder';
exception when insufficient_privilege then
  raise notice 'ok - bob cannot upload into alice''s folder';
end $$;

do $$
begin
  insert into public.submissions (title, channel, schemes, entry_id)
  values ('fake version', 'pos', array['visa'], 'a1a1a1a1-0000-0000-0000-000000000001');
  raise exception 'FAIL: bob added a version to alice''s entry';
exception when insufficient_privilege then
  raise notice 'ok - bob cannot add a version to alice''s entry';
end $$;

do $$
begin
  execute 'insert into public.submissions (owner_id, title, channel, schemes) values ($1, $2, $3, $4)'
    using 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'planted', 'pos', array['visa'];
  raise exception 'FAIL: bob created a submission owned by alice';
exception when insufficient_privilege then
  raise notice 'ok - bob cannot create a submission in alice''s name';
end $$;

do $$
begin
  perform count(*) from public.audit_log;
  raise exception 'FAIL: a user read the audit log';
exception when insufficient_privilege then
  raise notice 'ok - users cannot read the audit log';
end $$;

-- ---------------------------------------------------------------------------
-- Sharing one submission
-- ---------------------------------------------------------------------------
select tests.login(:alice, 'alice@example.com', 'aal2');
insert into public.shares (invited_email, scope, submission_id, token_hash)
values ('BOB@example.com', 'submission', :a1, tests.token_hash('tok-one'));
select tests.ok((select owner_label = 'Alice Example (Acme Payments)' and invited_email = 'bob@example.com'
                 from public.shares), 'the share is labelled from alice''s profile, email normalised');

select tests.login(:bob, 'bob@example.com', 'aal2');
select tests.ok((select count(*) = 0 from public.submissions), 'an unaccepted invite grants nothing');

select tests.login(:carol, 'carol@example.com', 'aal2');
do $$
begin
  perform public.accept_share('tok-one');
  raise exception 'FAIL: carol accepted an invite sent to bob';
exception when insufficient_privilege then
  raise notice 'ok - a forwarded invite link does not work for another account';
end $$;

select tests.login(:bob, 'bob@example.com', 'aal1');
do $$
begin
  perform public.accept_share('tok-one');
  raise exception 'FAIL: invite accepted without 2FA';
exception when insufficient_privilege then
  raise notice 'ok - accepting an invite needs 2FA';
end $$;

select tests.login(:bob, 'bob@example.com', 'aal2');
select tests.ok((select scope = 'submission' from public.accept_share('tok-one')), 'bob accepts the invite');
select tests.ok((select count(*) = 1 and bool_and(id = :a1) from public.submissions),
  'bob now sees exactly the shared submission');
select tests.ok((select count(*) = 1 from public.submission_files), 'bob sees the shared submission''s file');
select tests.ok((select count(*) = 1 from storage.objects where bucket_id = 'submissions'), 'bob can download the shared masked file');

do $$
declare n int;
begin
  update public.submissions set title = 'edited by bob' where id = 'a1a1a1a1-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  perform tests.ok(n = 0, 'a shared submission is read-only for the recipient');
end $$;

do $$
begin
  perform public.accept_share('tok-one');
  raise exception 'FAIL: an invite link worked twice';
exception when insufficient_privilege then
  raise notice 'ok - an invite link works only once';
end $$;

do $$
begin
  insert into public.shares (invited_email, scope, submission_id, token_hash)
  values ('carol@example.com', 'submission', 'a1a1a1a1-0000-0000-0000-000000000001', 'x');
  raise exception 'FAIL: recipient reshared';
exception when insufficient_privilege then
  raise notice 'ok - a recipient cannot reshare';
end $$;

select tests.login(:alice, 'alice@example.com', 'aal2');
update public.shares set status = 'revoked', revoked_at = now() where scope = 'submission';

select tests.login(:bob, 'bob@example.com', 'aal2');
select tests.ok((select count(*) = 0 from public.submissions), 'revoking removes access immediately');
select tests.ok((select count(*) = 0 from storage.objects), 'revoking removes file access immediately');

-- ---------------------------------------------------------------------------
-- Sharing the whole workspace, including later submissions
-- ---------------------------------------------------------------------------
select tests.login(:alice, 'alice@example.com', 'aal2');
insert into public.shares (invited_email, scope, token_hash)
values ('bob@example.com', 'workspace', tests.token_hash('tok-all'));

select tests.login(:bob, 'bob@example.com', 'aal2');
select tests.ok((select scope = 'workspace' from public.accept_share('tok-all')), 'bob accepts the workspace invite');
select tests.ok((select count(*) = 2 from public.submissions), 'workspace share shows all of alice''s submissions');

select tests.login(:alice, 'alice@example.com', 'aal2');
insert into public.submissions (title, channel, schemes) values ('E-commerce checkout', 'ecommerce', array['mastercard']);
insert into public.submissions (title, channel, schemes, entry_id) values ('Terminal screens v2', 'pos', array['visa'], :a1);
select tests.ok((select version = 2 from public.submissions where title = 'Terminal screens v2'),
  'a resubmission becomes version 2 of the same entry');

select tests.login(:bob, 'bob@example.com', 'aal2');
select tests.ok((select count(*) = 4 from public.submissions), 'workspace share includes submissions made later');

select tests.login(:carol, 'carol@example.com', 'aal2');
select tests.ok((select count(*) = 0 from public.submissions), 'carol still sees nothing');

reset role;
update public.shares set expires_at = now() - interval '1 minute' where scope = 'workspace';
set role authenticated;
select tests.login(:bob, 'bob@example.com', 'aal2');
select tests.ok((select count(*) = 0 from public.submissions), 'an expired share grants nothing');

-- ---------------------------------------------------------------------------
-- Rule library: admins only, published sets are frozen
-- ---------------------------------------------------------------------------
reset role;
update public.profiles set role = 'admin' where id = :carol;
select tests.ok((select count(*) = 36 from public.rules), 'the starter library is seeded for both schemes');

set role authenticated;
select tests.login(:alice, 'alice@example.com', 'aal2');
select tests.ok((select count(*) = 0 from public.rules), 'submitters cannot see the rule library');
select tests.ok((select count(*) = 0 from public.fact_definitions), 'submitters cannot see the fact questions');
do $$
begin
  perform public.start_rule_set_draft();
  raise exception 'FAIL: a submitter started a draft';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok - submitters cannot start a rule set draft';
end $$;
do $$
begin
  update public.profiles set role = 'admin' where id = auth.uid();
  raise exception 'FAIL: a submitter made themselves admin';
exception when insufficient_privilege then
  raise notice 'ok - submitters cannot make themselves admin';
end $$;

select tests.login(:carol, 'carol@example.com', 'aal1');
select tests.ok((select count(*) = 0 from public.rules), 'admins without 2FA see nothing');

select tests.login(:carol, 'carol@example.com', 'aal2');
select tests.ok((select count(*) = 36 from public.rules), 'admins see the rule library');
do $$
begin
  update public.rules set weight = 1 where code = 'V-01';
  raise exception 'FAIL: a published rule was changed';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok - published rules cannot be changed';
end $$;

create temp table draft as select public.start_rule_set_draft() as id;
select tests.ok((select count(*) = 36 from public.rules where rule_set_id = (select id from draft)),
  'a draft starts as a copy of the published rules');
select tests.ok((select public.start_rule_set_draft() = (select id from draft)), 'there is only one draft');
update public.rules set weight = 2, verified = true where code = 'V-01' and rule_set_id = (select id from draft);
select public.publish_rule_set((select id from draft));
select tests.ok((select number = 2 and status = 'published' from public.rule_sets where id = (select id from draft)),
  'publishing makes the draft the rule set in use');
select tests.ok((select count(*) = 1 from public.rule_sets where status = 'published'), 'only one rule set is published');
select tests.ok((select weight = 10 from public.rules r join public.rule_sets s on s.id = r.rule_set_id
                 where r.code = 'V-01' and s.number = 1), 'earlier rule sets keep their rules unchanged');

-- ---------------------------------------------------------------------------
-- Generated reports follow the submission's sharing
-- ---------------------------------------------------------------------------
reset role;
insert into public.submission_outputs (submission_id, owner_id, kind, storage_path, file_name, mime_type)
select id, owner_id, 'report', owner_id || '/' || id || '/report.pdf', 'report.pdf', 'application/pdf'
from public.submissions where id = :a1;
insert into storage.objects (bucket_id, name)
select 'submissions', storage_path from public.submission_outputs;

set role authenticated;
select tests.login(:alice, 'alice@example.com', 'aal2');
select tests.ok((select count(*) = 1 from public.submission_outputs), 'owners see their report');
select tests.login(:carol, 'carol@example.com', 'aal2');
select tests.ok((select count(*) = 0 from public.submission_outputs), 'others cannot see the report');
select tests.ok((select count(*) = 0 from storage.objects where name like '%report.pdf'),
  'others cannot download the report');

-- ---------------------------------------------------------------------------
-- Signed-out visitors get nothing
-- ---------------------------------------------------------------------------
reset role;
set role anon;
select set_config('request.jwt.claims', '', false);
do $$
begin
  perform count(*) from public.submissions;
  raise exception 'FAIL: anon read submissions';
exception when insufficient_privilege then
  raise notice 'ok - signed-out visitors cannot read anything';
end $$;

reset role;
select tests.ok((select count(*) > 0 from public.audit_log where target_type = 'shares'),
  'sharing actions are recorded in the audit log');

\echo 'All isolation tests passed.'
