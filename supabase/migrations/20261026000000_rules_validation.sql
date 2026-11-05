-- Phase 3: rule library and automated validation.
--
--   * fact_definitions: the questions the AI answers about each submission's
--     masked screens and receipts ("Does the receipt show the exchange rate?").
--   * rule_sets / rules: a versioned library of Visa and Mastercard rules kept
--     by admins. Exactly one rule set is published at a time and is used for
--     new validations; editing happens in a single draft copy, which replaces
--     the published set when an admin publishes it. Published sets never change,
--     so every result can say exactly which rules it was checked against.
--   * submission_outputs: generated files for a submission (the PDF report now;
--     the draft Visa form and training packs later).
--
-- Only admins (profiles.role = 'admin', with 2FA) can see or change the rule
-- library. The validation worker uses the service role.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_mfa() and exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  )
$$;

grant execute on function private.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.fact_definitions (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  document text not null check (document in ('choice_screen', 'receipt', 'any')),
  question text not null check (char_length(question) between 5 and 500),
  kind text not null default 'yes_no' check (kind in ('yes_no', 'number')),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.rule_sets (
  id uuid primary key default gen_random_uuid(),
  number integer not null unique,
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  published_at timestamptz,
  published_by uuid references auth.users (id) on delete set null
);

-- At most one published set and one draft at any time.
create unique index rule_sets_one_published on public.rule_sets ((true)) where status = 'published';
create unique index rule_sets_one_draft on public.rule_sets ((true)) where status = 'draft';

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  rule_set_id uuid not null references public.rule_sets (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,30}$'),
  scheme text not null check (scheme in ('visa', 'mastercard')),
  channels text[] not null default array['pos', 'atm', 'ecommerce']
    check (cardinality(channels) > 0 and channels <@ array['pos', 'atm', 'ecommerce']::text[]),
  title text not null check (char_length(title) between 3 and 200),
  requirement text not null check (char_length(requirement) between 5 and 2000),
  source_reference text not null default '',
  -- 'fact': decided by code from one AI-answered fact. 'judgement': the AI
  -- reads the requirement and decides, giving its evidence.
  check_type text not null check (check_type in ('fact', 'judgement')),
  fact_key text references public.fact_definitions (key),
  expected text check (expected in ('yes', 'no', 'at_least', 'at_most')),
  threshold numeric,
  severity text not null default 'major' check (severity in ('critical', 'major', 'minor')),
  weight integer not null default 5 check (weight between 1 and 10),
  -- true once an admin has checked the wording against the official scheme document.
  verified boolean not null default false,
  active boolean not null default true,
  notes text not null default '',
  sort integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  unique (rule_set_id, code),
  check (
    (check_type = 'judgement' and fact_key is null and expected is null)
    or (check_type = 'fact' and fact_key is not null and expected is not null
        and ((expected in ('at_least', 'at_most')) = (threshold is not null)))
  )
);

create index rules_rule_set_idx on public.rules (rule_set_id, sort, code);

create table public.submission_outputs (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('report', 'visa_form', 'training_pack')),
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  created_at timestamptz not null default now(),
  unique (submission_id, kind)
);

-- The worker looks for submissions waiting to be validated.
create index submissions_uploaded_idx on public.submissions (updated_at) where status in ('uploaded', 'processing');

-- ---------------------------------------------------------------------------
-- Rules can only change while their rule set is the draft.
-- ---------------------------------------------------------------------------

create or replace function private.guard_rule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  set_id uuid := case when tg_op = 'DELETE' then old.rule_set_id else new.rule_set_id end;
begin
  if tg_op = 'UPDATE' and new.rule_set_id <> old.rule_set_id then
    raise exception 'a rule cannot move between rule sets';
  end if;
  if (select status from public.rule_sets where id = set_id) <> 'draft'
     and coalesce(current_setting('dcc.copying_rules', true), '') <> 'on' then
    raise exception 'published rule sets cannot be changed; edit the draft instead';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

create trigger rules_guard before insert or update or delete on public.rules
  for each row execute function private.guard_rule();

create trigger rules_audit after insert or update or delete on public.rules
  for each row execute function private.audit();
create trigger rule_sets_audit after insert or update on public.rule_sets
  for each row execute function private.audit();

-- Start a draft from the published rule set (or return the existing draft).
create or replace function public.start_rule_set_draft()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft_id uuid;
  source_id uuid;
begin
  if not private.is_admin() then
    raise exception 'only admins can edit the rule library';
  end if;
  select id into draft_id from public.rule_sets where status = 'draft';
  if draft_id is not null then
    return draft_id;
  end if;
  select id into source_id from public.rule_sets where status = 'published';
  insert into public.rule_sets (number, created_by, notes)
  values ((select coalesce(max(number), 0) + 1 from public.rule_sets), auth.uid(), '')
  returning id into draft_id;
  insert into public.rules (rule_set_id, code, scheme, channels, title, requirement, source_reference,
                            check_type, fact_key, expected, threshold, severity, weight, verified,
                            active, notes, sort)
  select draft_id, code, scheme, channels, title, requirement, source_reference,
         check_type, fact_key, expected, threshold, severity, weight, verified, active, notes, sort
  from public.rules where rule_set_id = source_id;
  return draft_id;
end;
$$;

-- Publish the draft: it becomes the rule set used for all new validations.
create or replace function public.publish_rule_set(draft uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'only admins can publish rule sets';
  end if;
  if not exists (select 1 from public.rule_sets where id = draft and status = 'draft') then
    raise exception 'only the draft rule set can be published';
  end if;
  if not exists (select 1 from public.rules where rule_set_id = draft and active) then
    raise exception 'a rule set needs at least one active rule';
  end if;
  update public.rule_sets set status = 'retired' where status = 'published';
  update public.rule_sets
  set status = 'published', published_at = now(), published_by = auth.uid()
  where id = draft;
end;
$$;

-- Throw away the draft.
create or replace function public.discard_rule_set_draft(draft uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'only admins can edit the rule library';
  end if;
  delete from public.rule_sets where id = draft and status = 'draft';
end;
$$;

revoke all on function public.start_rule_set_draft(), public.publish_rule_set(uuid),
  public.discard_rule_set_draft(uuid) from public, anon;
grant execute on function public.start_rule_set_draft(), public.publish_rule_set(uuid),
  public.discard_rule_set_draft(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges and row level security
-- ---------------------------------------------------------------------------

revoke all on public.fact_definitions, public.rule_sets, public.rules, public.submission_outputs
  from anon, authenticated;

grant select on public.fact_definitions, public.rule_sets, public.rules to authenticated;
grant insert (key, document, question, kind, sort) on public.fact_definitions to authenticated;
grant update (document, question, sort) on public.fact_definitions to authenticated;
grant update (notes) on public.rule_sets to authenticated;
grant insert (rule_set_id, code, scheme, channels, title, requirement, source_reference, check_type,
              fact_key, expected, threshold, severity, weight, verified, active, notes, sort)
  on public.rules to authenticated;
grant update (code, scheme, channels, title, requirement, source_reference, check_type, fact_key,
              expected, threshold, severity, weight, verified, active, notes, sort)
  on public.rules to authenticated;
grant delete on public.rules to authenticated;
grant select on public.submission_outputs to authenticated;

alter table public.fact_definitions enable row level security;
alter table public.rule_sets enable row level security;
alter table public.rules enable row level security;
alter table public.submission_outputs enable row level security;

create policy "facts: admins read" on public.fact_definitions
  for select to authenticated using (private.is_admin());
create policy "facts: admins add" on public.fact_definitions
  for insert to authenticated with check (private.is_admin());
create policy "facts: admins edit" on public.fact_definitions
  for update to authenticated using (private.is_admin()) with check (private.is_admin());

create policy "rule sets: admins read" on public.rule_sets
  for select to authenticated using (private.is_admin());
create policy "rule sets: admins edit draft notes" on public.rule_sets
  for update to authenticated
  using (private.is_admin() and status = 'draft')
  with check (private.is_admin() and status = 'draft');

create policy "rules: admins read" on public.rules
  for select to authenticated using (private.is_admin());
create policy "rules: admins add to draft" on public.rules
  for insert to authenticated with check (private.is_admin());
create policy "rules: admins edit draft" on public.rules
  for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy "rules: admins delete from draft" on public.rules
  for delete to authenticated using (private.is_admin());

create policy "outputs: owner or shared" on public.submission_outputs
  for select to authenticated
  using (private.can_read_submission(owner_id, submission_id));

-- Shared users can download a submission's generated files (owners already can).
create policy "storage: shared reads outputs" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'submissions'
    and private.is_mfa()
    and exists (
      select 1 from public.submission_outputs o
      where o.storage_path = name
        and private.can_read_submission(o.owner_id, o.submission_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Starter library. These are DRAFT rules written from general knowledge of
-- the Visa and Mastercard DCC requirements. None is marked verified: each must
-- be checked against the current official scheme documents before results are
-- relied on, and every report says so until they are.
-- ---------------------------------------------------------------------------

insert into public.fact_definitions (key, document, question, kind, sort) values
  ('dcc_offer_shown', 'any', 'Is the cardholder shown an offer to pay in their own (home) currency instead of the merchant''s local currency?', 'yes_no', 10),
  ('cs_local_amount', 'choice_screen', 'Does the currency choice screen show the transaction amount in the merchant''s local currency?', 'yes_no', 20),
  ('cs_cardholder_amount', 'choice_screen', 'Does the currency choice screen show the amount converted into the cardholder''s currency?', 'yes_no', 30),
  ('cs_currencies_identified', 'choice_screen', 'Does the currency choice screen clearly identify both currencies (currency codes, names or symbols)?', 'yes_no', 40),
  ('cs_exchange_rate', 'choice_screen', 'Does the currency choice screen show the exchange rate used for the conversion?', 'yes_no', 50),
  ('cs_markup_shown', 'choice_screen', 'Does the currency choice screen show the markup, commission or fee included in the conversion?', 'yes_no', 60),
  ('cs_markup_vs_ecb', 'choice_screen', 'Is the markup shown as a percentage over the latest European Central Bank euro foreign exchange reference rate?', 'yes_no', 70),
  ('cs_markup_percent', 'choice_screen', 'What markup percentage is shown on the currency choice screen? Give the number only.', 'number', 80),
  ('cs_both_options', 'choice_screen', 'Can the cardholder choose to pay either in the local currency or in their own currency?', 'yes_no', 90),
  ('cs_no_default', 'choice_screen', 'Are both options free of any preselection, so that neither is already selected or set as the default?', 'yes_no', 100),
  ('cs_equal_prominence', 'choice_screen', 'Are both options presented with equal prominence (similar size, colour and position)?', 'yes_no', 110),
  ('cs_neutral_wording', 'choice_screen', 'Is the wording neutral, without suggesting that one option is recommended, cheaper, safer or required?', 'yes_no', 120),
  ('cs_active_choice', 'choice_screen', 'Does the cardholder have to actively select a currency (no automatic acceptance or timeout into conversion)?', 'yes_no', 130),
  ('rc_local_amount', 'receipt', 'Does the receipt show the transaction amount in the merchant''s local currency?', 'yes_no', 200),
  ('rc_cardholder_amount', 'receipt', 'Does the receipt show the converted amount charged in the cardholder''s currency?', 'yes_no', 210),
  ('rc_currencies_identified', 'receipt', 'Does the receipt clearly identify both currencies (currency codes, names or symbols)?', 'yes_no', 220),
  ('rc_exchange_rate', 'receipt', 'Does the receipt show the exchange rate used?', 'yes_no', 230),
  ('rc_markup_shown', 'receipt', 'Does the receipt show the markup, commission or fee included in the conversion?', 'yes_no', 240),
  ('rc_choice_statement', 'receipt', 'Does the receipt state that the cardholder was offered a choice of currency and chose to pay in their own currency?', 'yes_no', 250),
  ('rc_rate_source', 'receipt', 'Does the receipt identify the source or basis of the exchange rate?', 'yes_no', 260),
  ('cs_local_currency_identified', 'choice_screen', 'Is the merchant''s local currency (or the currency dispensed) identified by a currency symbol or code next to its amount?', 'yes_no', 25),
  ('cs_dcc_currency_identified', 'choice_screen', 'Is the cardholder''s (conversion) currency identified by a currency symbol or code next to the converted amount?', 'yes_no', 35),
  ('cs_markup_numeric', 'choice_screen', 'Is the markup shown in numbers, as a percentage or a fixed fee amount (not only in words)?', 'yes_no', 65),
  ('cs_markup_position', 'choice_screen', 'Is the markup placed immediately below the exchange rate and above the converted total amount?', 'yes_no', 66),
  ('cs_disclosures_concurrent', 'choice_screen', 'Are all the amounts, currencies, the exchange rate and the markup shown together on the same screen at the time the choice is offered?', 'yes_no', 67),
  ('cs_electronic_screen', 'choice_screen', 'Are the disclosures and the currency choice presented on an electronic screen or PIN pad (rather than on paper)?', 'yes_no', 68),
  ('cs_disclosures_same_style', 'choice_screen', 'Are all the disclosures (both amounts and currencies, the exchange rate and the markup) in the same text size, colour and font?', 'yes_no', 115),
  ('cs_buttons_identical', 'choice_screen', 'Are the buttons or boxes for the two currency options identical in size, shape and colour?', 'yes_no', 116),
  ('any_not_scheme_service', 'any', 'Do the screens and receipts avoid presenting the currency conversion as a service provided by Visa, Mastercard or another card scheme?', 'yes_no', 140),
  ('rc_local_currency_identified', 'receipt', 'Does the receipt show the currency code or symbol of the merchant''s local currency (or the currency dispensed)?', 'yes_no', 205),
  ('rc_dcc_currency_identified', 'receipt', 'Does the receipt show the currency code or symbol of the currency charged to the cardholder?', 'yes_no', 215),
  ('rc_amount_label', 'receipt', 'Does the receipt show the words "Transaction Currency", "Transaction Amount", "Transaction Charged" or "Amount Charged" next to the total charged?', 'yes_no', 245),
  ('rc_provider_statement', 'receipt', 'Does the receipt state that the currency conversion is provided or conducted by the merchant, ATM operator, bank branch or acquirer?', 'yes_no', 255),
  ('rc_choice_confirmation', 'receipt', 'Does the receipt confirm that the cardholder accepted the conversion, such as a completed accept box or a statement that they were offered a choice including the local currency and agreed to pay in their own currency?', 'yes_no', 256),
  ('cs_right_to_choose', 'choice_screen', 'Does the screen tell the cardholder that they have the right to choose the currency the transaction is completed in?', 'yes_no', 95),
  ('cs_not_yes_no', 'choice_screen', 'Are the options presented as a choice between the two currencies, rather than as a YES or NO question about converting?', 'yes_no', 117),
  ('cs_no_red_green', 'choice_screen', 'Are the currency options shown without contrasting colours such as red and green that could favour one option?', 'yes_no', 118),
  ('cs_no_reconfirm', 'choice_screen', 'After the cardholder selects a currency, is there no extra prompt asking them to re-confirm or reconsider that choice?', 'yes_no', 119),
  ('cs_cost_warning', 'choice_screen', 'Before the currency is chosen, does the screen show this statement word for word: "Make sure you understand the costs of currency conversion as they may be different depending on whether you select your home currency or the transaction currency."?', 'yes_no', 125);

insert into public.rule_sets (id, number, status, notes, published_at)
values ('00000000-0000-4000-8000-000000000001', 1, 'published',
        'Starter draft library. Every rule needs checking against the official scheme documents.', now());

-- Seeding a published set: let the guard through for this one insert.
select set_config('dcc.copying_rules', 'on', false);

insert into public.rules (rule_set_id, code, scheme, title, requirement, source_reference, check_type,
                          fact_key, expected, threshold, severity, weight, active, notes, sort)
select '00000000-0000-4000-8000-000000000001', r.prefix || '-' || r.code, r.scheme, r.title, r.requirement,
       case r.scheme
         when 'visa' then 'Visa Core Rules and Visa Product and Service Rules, Dynamic Currency Conversion (section to confirm)'
         else 'Mastercard Transaction Processing Rules, POI Currency Conversion (section to confirm)'
       end || coalesce('; ' || r.extra_source, ''),
       r.check_type, r.fact_key, r.expected, r.threshold, r.severity, r.weight, r.active, r.notes, r.sort
from (
  select s.scheme, s.prefix, t.*
  from (values ('visa', 'V'), ('mastercard', 'M')) as s (scheme, prefix)
  cross join (values
    ('01', 'Cardholder is offered a choice of currency',
     'The cardholder must be offered the choice of paying in the merchant''s local currency or in their own currency.',
     'fact', 'cs_both_options', 'yes', null::numeric, 'critical', 10, true, '', null::text, 10),
    ('02', 'No option is preselected',
     'Neither currency option may be preselected or set as the default; the cardholder makes the choice.',
     'fact', 'cs_no_default', 'yes', null, 'critical', 10, true, '', null, 20),
    ('03', 'Cardholder actively chooses',
     'Conversion must only happen after the cardholder actively selects their own currency; it must not happen by timeout or automatic acceptance.',
     'fact', 'cs_active_choice', 'yes', null, 'critical', 10, true, '', null, 30),
    ('04', 'Choice screen shows the local currency amount',
     'Before the choice is made, the transaction amount in the merchant''s local currency must be shown.',
     'fact', 'cs_local_amount', 'yes', null, 'critical', 8, true, '', null, 40),
    ('05', 'Choice screen shows the converted amount',
     'Before the choice is made, the amount in the cardholder''s currency must be shown.',
     'fact', 'cs_cardholder_amount', 'yes', null, 'critical', 8, true, '', null, 50),
    ('06', 'Choice screen identifies both currencies',
     'Both currencies must be clearly identified.',
     'fact', 'cs_currencies_identified', 'yes', null, 'major', 5, true, '', null, 60),
    ('07', 'Choice screen shows the exchange rate',
     'The exchange rate used for the conversion must be disclosed before the choice is made.',
     'fact', 'cs_exchange_rate', 'yes', null, 'critical', 8, true, '', null, 70),
    ('08', 'Choice screen shows the markup',
     'Any markup, commission or fee included in the conversion must be disclosed before the choice is made.',
     'fact', 'cs_markup_shown', 'yes', null, 'major', 6, true, '', null, 80),
    ('09', 'Markup shown against the ECB reference rate (EEA)',
     'In the European Economic Area, the markup must be expressed as a percentage over the latest European Central Bank reference rate.',
     'fact', 'cs_markup_vs_ecb', 'yes', null, 'major', 6, false,
     'Applies to EEA merchants only, so switched off until submissions record the merchant''s country.',
     'Regulation (EU) 2019/518', 90),
    ('10', 'Options are equally prominent',
     'The two currency options should be presented with equal prominence.',
     'fact', 'cs_equal_prominence', 'yes', null, 'minor', 3, true, '', null, 100),
    ('11', 'Neutral, non-misleading wording',
     'The wording on the choice screen and receipt must not mislead the cardholder or steer them towards conversion, for example by implying it is recommended, cheaper, safer or required.',
     'judgement', null, null, null, 'major', 6, true, '', null, 110),
    ('12', 'Receipt shows the local currency amount',
     'The receipt must show the transaction amount in the merchant''s local currency.',
     'fact', 'rc_local_amount', 'yes', null, 'major', 6, true, '', null, 200),
    ('13', 'Receipt shows the converted amount',
     'The receipt must show the amount charged in the cardholder''s currency.',
     'fact', 'rc_cardholder_amount', 'yes', null, 'major', 6, true, '', null, 210),
    ('14', 'Receipt identifies both currencies',
     'The receipt must clearly identify both currencies.',
     'fact', 'rc_currencies_identified', 'yes', null, 'minor', 3, true, '', null, 220),
    ('15', 'Receipt shows the exchange rate',
     'The receipt must show the exchange rate used.',
     'fact', 'rc_exchange_rate', 'yes', null, 'major', 6, true, '', null, 230),
    ('16', 'Receipt shows the markup',
     'The receipt must show any markup, commission or fee included in the conversion.',
     'fact', 'rc_markup_shown', 'yes', null, 'major', 5, true, '', null, 240),
    ('17', 'Receipt confirms the cardholder''s choice',
     'The receipt must include a statement that the cardholder was offered a choice of currency and chose to pay in their own currency.',
     'fact', 'rc_choice_statement', 'yes', null, 'major', 6, true, '', null, 250),
    ('18', 'Receipt identifies the exchange rate source',
     'The receipt should identify the source or basis of the exchange rate.',
     'fact', 'rc_rate_source', 'yes', null, 'minor', 2, true, '', null, 260)
  ) as t (code, title, requirement, check_type, fact_key, expected, threshold, severity, weight, active,
          notes, extra_source, sort)
) as r;

select set_config('dcc.copying_rules', 'off', false);
