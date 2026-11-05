-- Rulesets imported from a JSON file.
--
-- The DCC ruleset is maintained outside the app as a JSON document (metadata,
-- engine notes, environments, sources, rules, change log, open issues, review
-- log, citation check) and uploaded by an admin from time to time. Each upload
-- becomes a new draft rule set; publishing it makes it the set used for new
-- validations. The whole document is kept with the rule set so admins can read
-- everything that came with it, and so it can be downloaded again.
--
-- Rules gain the fields the JSON carries (type, domain, environments, what the
-- rule evaluates, effective dates, region, group). Settings an admin makes in
-- the app (severity, weight, verified, active, internal notes) carry over to
-- the next import for any rule whose ID and wording are unchanged.
--
-- Submissions gain the full list of environments the ruleset distinguishes,
-- and an optional merchant country for region-specific rules.

-- Questions added to the phase 3 migration after it was first released. Adds
-- them if that earlier version was the one applied; does nothing otherwise.
insert into public.fact_definitions (key, document, question, kind, sort) values
  ('cs_right_to_choose', 'choice_screen', 'Does the screen tell the cardholder that they have the right to choose the currency the transaction is completed in?', 'yes_no', 95),
  ('cs_not_yes_no', 'choice_screen', 'Are the options presented as a choice between the two currencies, rather than as a YES or NO question about converting?', 'yes_no', 117),
  ('cs_no_red_green', 'choice_screen', 'Are the currency options shown without contrasting colours such as red and green that could favour one option?', 'yes_no', 118),
  ('cs_no_reconfirm', 'choice_screen', 'After the cardholder selects a currency, is there no extra prompt asking them to re-confirm or reconsider that choice?', 'yes_no', 119),
  ('cs_cost_warning', 'choice_screen', 'Before the currency is chosen, does the screen show this statement word for word: "Make sure you understand the costs of currency conversion as they may be different depending on whether you select your home currency or the transaction currency."?', 'yes_no', 125)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Submissions: environments and merchant country
-- ---------------------------------------------------------------------------

alter table public.submissions
  drop constraint submissions_channel_check,
  add constraint submissions_channel_check check (channel in (
    'pos', 'pos_unattended', 'atm', 'branch', 'ecommerce', 'mail', 'phone', 'priority', 'stored'
  )),
  add column merchant_country text check (char_length(merchant_country) <= 80);

grant insert (merchant_country) on public.submissions to authenticated;

-- ---------------------------------------------------------------------------
-- Rule sets: where they came from, and the imported document
-- ---------------------------------------------------------------------------

alter table public.rule_sets
  add column origin text not null default 'manual' check (origin in ('starter', 'manual', 'import')),
  add column title text not null default '',
  add column as_of date,
  add column file_name text,
  -- Everything in the imported JSON except the rules themselves.
  add column document jsonb;

update public.rule_sets set origin = 'starter', title = 'Starter rules' where number = 1 and origin = 'manual';

-- ---------------------------------------------------------------------------
-- Rules: the fields the JSON ruleset carries
-- ---------------------------------------------------------------------------

alter table public.rules
  drop constraint rules_code_check,
  add constraint rules_code_check check (code ~ '^[A-Z0-9][A-Z0-9.-]{0,39}$'),
  drop constraint rules_title_check,
  add constraint rules_title_check check (char_length(title) between 1 and 200),
  -- MUST / MUST_NOT are pass or fail; SHOULD is advisory; MAY and INFO give
  -- context (exemptions, consequences) and are never failed.
  add column rule_type text not null default 'MUST'
    check (rule_type in ('MUST', 'MUST_NOT', 'SHOULD', 'MAY', 'INFO')),
  add column domain text not null default '',
  add column environments text[] not null default array['ALL'],
  add column excluded_environments text[] not null default '{}',
  -- What the rule is checked against: SCREEN, RECEIPT, FLOW, AGREEMENT, ...
  add column evaluates text not null default 'SCREEN/RECEIPT',
  add column effective text not null default '',
  add column rule_status text not null default 'ACTIVE'
    check (rule_status in ('ACTIVE', 'FUTURE', 'EXPIRED', 'EXPIRED_PARTIAL')),
  add column valid_from date,
  add column valid_to date,
  add column region_scope text not null default 'Global',
  add column group_code text,
  add column source_notes text not null default '',
  add column basis text not null default '';

-- Environments replace the three coarse channels. Published rules are frozen,
-- so let this one-off conversion through the guard.
select set_config('dcc.copying_rules', 'on', false);
update public.rules set environments = case
  when channels @> array['pos', 'atm', 'ecommerce'] then array['ALL']
  else array_remove(array[
    case when 'pos' = any (channels) then 'POS_ATTENDED' end,
    case when 'pos' = any (channels) then 'POS_UNATTENDED' end,
    case when 'atm' = any (channels) then 'ATM' end,
    case when 'ecommerce' = any (channels) then 'ECOM' end
  ], null)
end;
select set_config('dcc.copying_rules', 'off', false);

alter table public.rules
  drop column channels,
  add constraint rules_environments_check check (cardinality(environments) > 0);

grant insert (rule_type, domain, environments, excluded_environments, evaluates, effective, rule_status,
              valid_from, valid_to, region_scope, group_code, source_notes, basis)
  on public.rules to authenticated;
grant update (rule_type, domain, environments, excluded_environments, evaluates, effective, rule_status,
              valid_from, valid_to, region_scope, group_code, source_notes, basis)
  on public.rules to authenticated;

-- ---------------------------------------------------------------------------
-- Drafts copy the new fields too
-- ---------------------------------------------------------------------------

create or replace function public.start_rule_set_draft()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft_id uuid;
  source_set public.rule_sets;
begin
  if not private.is_admin() then
    raise exception 'only admins can edit the rule library';
  end if;
  select id into draft_id from public.rule_sets where status = 'draft';
  if draft_id is not null then
    return draft_id;
  end if;
  select * into source_set from public.rule_sets where status = 'published';
  insert into public.rule_sets (number, created_by, notes, origin, title, as_of, file_name, document)
  values ((select coalesce(max(number), 0) + 1 from public.rule_sets), auth.uid(), '',
          case when source_set.origin = 'import' then 'import' else 'manual' end,
          coalesce(source_set.title, ''), source_set.as_of, source_set.file_name, source_set.document)
  returning id into draft_id;
  insert into public.rules (rule_set_id, code, scheme, title, requirement, source_reference, check_type, fact_key,
                            expected, threshold, severity, weight, verified, active, notes, sort, rule_type, domain,
                            environments, excluded_environments, evaluates, effective, rule_status, valid_from,
                            valid_to, region_scope, group_code, source_notes, basis)
  select draft_id, code, scheme, title, requirement, source_reference, check_type, fact_key,
         expected, threshold, severity, weight, verified, active, notes, sort, rule_type, domain,
         environments, excluded_environments, evaluates, effective, rule_status, valid_from,
         valid_to, region_scope, group_code, source_notes, basis
  from public.rules where rule_set_id = source_set.id;
  return draft_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Import: the uploaded JSON becomes the draft rule set
-- ---------------------------------------------------------------------------

-- Natural sort position for IDs like V-RCP-08.12: each number is zero padded.
create or replace function private.rule_sort_key(code text)
returns text
language sql
immutable
as $$
  select string_agg(case when part ~ '^\d+$' then lpad(part, 6, '0') else part end, '' order by n)
  from regexp_matches(code, '(\d+|\D+)', 'g') with ordinality as m(parts, n),
       lateral (select parts[1] as part) p
$$;

create or replace function public.import_rule_set(doc jsonb, file_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft_id uuid;
  published_id uuid;
  bad text;
begin
  if not private.is_admin() then
    raise exception 'only admins can import rule sets';
  end if;
  if jsonb_typeof(doc -> 'rules') <> 'array' or jsonb_array_length(doc -> 'rules') = 0 then
    raise exception 'the file has no "rules" list';
  end if;
  if jsonb_array_length(doc -> 'rules') > 5000 then
    raise exception 'the file has more than 5000 rules';
  end if;

  -- The app checks the file in detail first; these are the last line of defence.
  select r ->> 'id' into bad
  from jsonb_array_elements(doc -> 'rules') r
  where coalesce(r ->> 'id', '') = ''
     or r ->> 'network' not in ('VISA', 'MC')
     or r ->> 'type' not in ('MUST', 'MUST_NOT', 'SHOULD', 'MAY', 'INFO')
     or coalesce(r ->> 'assertion', '') = ''
     or jsonb_typeof(r -> 'environments') <> 'array'
  limit 1;
  if found then
    raise exception 'rule % is missing an id, network, type, assertion or environments', coalesce(bad, '(no id)');
  end if;

  delete from public.rule_sets where status = 'draft';
  select id into published_id from public.rule_sets where status = 'published';

  insert into public.rule_sets (number, status, created_by, origin, title, as_of, file_name, document, notes)
  values (
    (select coalesce(max(number), 0) + 1 from public.rule_sets), 'draft', auth.uid(), 'import',
    left(coalesce(doc #>> '{metadata,title}', 'Imported ruleset'), 300),
    case when doc #>> '{metadata,as_of}' ~ '^\d{4}-\d{2}-\d{2}$' then (doc #>> '{metadata,as_of}')::date end,
    left(file_name, 300),
    doc - 'rules',
    ''
  )
  returning id into draft_id;

  insert into public.rules (rule_set_id, code, scheme, title, requirement, source_reference, check_type,
                            severity, weight, verified, active, notes, sort, rule_type, domain, environments,
                            excluded_environments, evaluates, effective, rule_status, valid_from, valid_to,
                            region_scope, group_code, source_notes, basis)
  select draft_id,
         r ->> 'id',
         case r ->> 'network' when 'VISA' then 'visa' else 'mastercard' end,
         -- A short title: the first sentence of the assertion, or its first words.
         coalesce(nullif(substring(r ->> 'assertion' from '^(.{5,190}?[.;:])(\s|$)'), ''),
                  case when length(r ->> 'assertion') <= 190 then r ->> 'assertion'
                       else regexp_replace(left(r ->> 'assertion', 180), '\s+\S*$', '') || '…' end),
         left(r ->> 'assertion', 2000),
         coalesce(r ->> 'source', ''),
         'judgement',
         coalesce(prev.severity, case when r ->> 'type' = 'SHOULD' then 'minor' else 'critical' end),
         coalesce(prev.weight, 5),
         coalesce(prev.verified, false),
         coalesce(prev.active, true),
         coalesce(prev.notes, ''),
         0,
         r ->> 'type',
         coalesce(r ->> 'domain', ''),
         array(select jsonb_array_elements_text(r -> 'environments')),
         coalesce(array(select jsonb_array_elements_text(r -> 'excluded_environments')), '{}'),
         coalesce(nullif(r ->> 'evaluates', ''), 'SCREEN/RECEIPT'),
         coalesce(r ->> 'effective', ''),
         coalesce(nullif(r ->> 'status', ''), 'ACTIVE'),
         case when r ->> 'valid_from' ~ '^\d{4}-\d{2}-\d{2}$' then (r ->> 'valid_from')::date end,
         case when r ->> 'valid_to' ~ '^\d{4}-\d{2}-\d{2}$' then (r ->> 'valid_to')::date end,
         coalesce(nullif(r ->> 'region_scope', ''), 'Global'),
         nullif(r ->> 'group', ''),
         coalesce(r ->> 'notes', ''),
         coalesce(r ->> 'basis', '')
  from jsonb_array_elements(doc -> 'rules') r
  -- Admin settings carry over when the rule's ID and wording are unchanged.
  left join public.rules prev
    on prev.rule_set_id = published_id and prev.code = r ->> 'id' and prev.requirement = left(r ->> 'assertion', 2000);

  update public.rules set sort = s.n
  from (select id, row_number() over (order by private.rule_sort_key(code)) * 10 as n
        from public.rules where rule_set_id = draft_id) s
  where s.id = rules.id;

  return draft_id;
exception
  when unique_violation then
    raise exception 'two rules in the file share the same id';
end;
$$;

revoke all on function public.import_rule_set(jsonb, text) from public, anon;
grant execute on function public.import_rule_set(jsonb, text) to authenticated;
