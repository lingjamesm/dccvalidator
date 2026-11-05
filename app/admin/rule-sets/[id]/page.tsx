import Link from "next/link";
import { notFound } from "next/navigation";
import { DataList, DataTable } from "@/components/DataView";
import { discardDraft, publishDraft, saveDraftNotes } from "@/lib/actions/admin";
import {
  ENVIRONMENTS,
  ORIGINS,
  RULE_STATUS,
  SEVERITIES,
  allRules,
  checkableFromUploads,
  environmentsLabel,
  requireAdmin,
  type Rule,
  type RuleSet,
} from "@/lib/admin";
import { RULE_TYPES, SCHEMES, formatDate } from "@/lib/labels";

export const dynamic = "force-dynamic";

type Search = Record<string, string | undefined>;

const TABS = {
  rules: "Rules",
  changes: "Changes",
  about: "About this file",
  sources: "Sources",
  change_log: "Change log",
  gaps_and_open_issues: "Open issues",
  review_log: "Review log",
  citation_check: "Citation check",
} as const;
type Tab = keyof typeof TABS;

// Fields that come from the ruleset itself; a change in any of them is a change of rule.
const CONTENT: (keyof Rule)[] = [
  "scheme", "requirement", "rule_type", "domain", "environments", "excluded_environments", "evaluates",
  "source_reference", "effective", "rule_status", "valid_from", "valid_to", "region_scope", "group_code",
  "source_notes", "check_type", "fact_key", "expected", "threshold",
];
const same = (a: Rule, b: Rule, k: keyof Rule) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null);

export default async function RuleSetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const { supabase } = await requireAdmin();
  const { data: set } = await supabase.from("rule_sets").select("*").eq("id", id).maybeSingle<RuleSet>();
  if (!set) notFound();
  const rules = await allRules(supabase, id);
  const doc = set.document ?? {};
  const isDraft = set.status === "draft";
  const imported = set.origin === "import";
  const tab: Tab = search.tab && search.tab in TABS ? (search.tab as Tab) : "rules";
  const unverified = rules.filter((r) => r.active && !r.verified).length;

  const { data: published } =
    set.status === "published"
      ? { data: null }
      : await supabase.from("rule_sets").select("*").eq("status", "published").maybeSingle<RuleSet>();
  const tabs = (Object.keys(TABS) as Tab[]).filter((t) => {
    if (t === "rules") return true;
    if (t === "changes") return !!published;
    if (t === "about") return !!(doc.metadata || doc.engine_notes || doc.environments);
    const v = doc[t];
    return v && (Array.isArray(v) ? v.length > 0 : Object.keys(v as object).length > 0);
  });
  const href = (t: Tab) => `/admin/rule-sets/${id}${t === "rules" ? "" : `?tab=${t}`}`;

  return (
    <main className="wide">
      <p>
        <Link href="/admin">← Rule library</Link>
      </p>
      <h1>
        Rule set v{set.number} {set.title && <>· {set.title}</>}{" "}
        <span className="muted">· {isDraft ? "draft" : set.status}</span>
      </h1>
      <p className="lead">
        {ORIGINS[set.origin]}
        {set.file_name && ` (${set.file_name})`}
        {set.as_of && ` · as of ${set.as_of}`} · {rules.length} rules
        {set.published_at && ` · published ${formatDate(set.published_at)}`} ·{" "}
        <a href={`/admin/rule-sets/${id}/export`}>Download as JSON</a>
      </p>

      {isDraft ? (
        <>
          <form action={saveDraftNotes} className="row">
            <input type="hidden" name="id" value={set.id} />
            <input type="text" name="notes" defaultValue={set.notes} placeholder="What changed in this version" style={{ flex: 1 }} />
            <button type="submit" className="secondary">Save note</button>
          </form>
          <div className="card" style={{ marginTop: 12 }}>
            <p>
              {imported
                ? "Check the rules and the changes against the published set. You can switch rules off and set severity, weight and verified for each; the wording comes from the file."
                : "Edit, add or switch off rules below."}{" "}
              When you publish, this draft is used for all new validations.
              {unverified > 0 && ` ${unverified} active rule${unverified === 1 ? " is" : "s are"} not yet marked as verified; reports will say so.`}
            </p>
            <div className="row">
              {!imported && (
                <Link href={`/admin/rule-sets/${set.id}/new`} className="button secondary">
                  Add a rule
                </Link>
              )}
              <form action={publishDraft}>
                <input type="hidden" name="id" value={set.id} />
                <button type="submit">Publish v{set.number}</button>
              </form>
              <form action={discardDraft}>
                <input type="hidden" name="id" value={set.id} />
                <button type="submit" className="link">Discard draft</button>
              </form>
            </div>
          </div>
        </>
      ) : (
        <p>{set.notes || "Published rule sets cannot be changed. Import a new file or start a new draft to make changes."}</p>
      )}

      {tabs.length > 1 && (
        <nav className="tabs" aria-label="Sections">
          {tabs.map((t) => (
            <Link key={t} href={href(t)} aria-current={t === tab ? "page" : undefined}>
              {TABS[t]}
            </Link>
          ))}
        </nav>
      )}

      {tab === "rules" && <RulesTab rules={rules} search={search} id={id} />}
      {tab === "changes" && published && (
        <ChangesTab rules={rules} published={published} publishedRules={await allRules(supabase, published.id)} />
      )}
      {tab === "about" && (
        <>
          {doc.metadata && (
            <section>
              <h2>About this ruleset</h2>
              <DataList data={doc.metadata} />
            </section>
          )}
          {doc.environments && (
            <section>
              <h2>Environments</h2>
              <DataList data={doc.environments} />
            </section>
          )}
          {doc.engine_notes && (
            <section>
              <h2>Notes for the checking engine</h2>
              <p className="muted">These notes are given to the AI with every validation.</p>
              <DataList data={doc.engine_notes} />
            </section>
          )}
        </>
      )}
      {tab === "sources" && doc.sources && (
        <DataTable rows={Object.entries(doc.sources).map(([code, source]) => ({ code, source }))} />
      )}
      {(tab === "change_log" || tab === "gaps_and_open_issues" || tab === "review_log" || tab === "citation_check") && (
        <DataTable rows={(doc[tab] as Record<string, unknown>[]) ?? []} />
      )}
    </main>
  );
}

function RulesTab({ rules, search, id }: { rules: Rule[]; search: Search; id: string }) {
  const domains = [...new Set(rules.map((r) => r.domain).filter(Boolean))].sort();
  const q = (search.q ?? "").trim().toLowerCase();
  const shown = rules.filter(
    (r) =>
      (!search.scheme || r.scheme === search.scheme) &&
      (!search.domain || r.domain === search.domain) &&
      (!search.type || r.rule_type === search.type) &&
      (!search.status || r.rule_status === search.status) &&
      (!search.env || r.environments.includes("ALL") || r.environments.includes(search.env)) &&
      (!search.env || !r.excluded_environments.includes(search.env)) &&
      (!search.check ||
        (search.check === "uploads") === checkableFromUploads(r.evaluates)) &&
      (!search.off || !r.active) &&
      (!q || `${r.code} ${r.requirement} ${r.source_reference} ${r.source_notes}`.toLowerCase().includes(q)),
  );
  const pick = (name: string, all: string, options: Record<string, string>) => (
    <label>
      {all}
      <select name={name} defaultValue={search[name] ?? ""}>
        <option value="">Any</option>
        {Object.entries(options).map(([k, v]) => (
          <option key={k} value={k}>{v}</option>
        ))}
      </select>
    </label>
  );
  const envs = Object.fromEntries(Object.entries(ENVIRONMENTS).filter(([k]) => k !== "ALL"));

  return (
    <section>
      <form method="get" className="filters">
        {pick("scheme", "Network", SCHEMES)}
        {pick("domain", "Domain", Object.fromEntries(domains.map((d) => [d, d.replace(/_/g, " ").toLowerCase()])))}
        {pick("type", "Type", RULE_TYPES)}
        {pick("env", "Environment", envs)}
        {pick("status", "Status", RULE_STATUS)}
        {pick("check", "Checked from", { uploads: "Screens and receipts", other: "Other evidence" })}
        <label>
          Search
          <input type="text" name="q" defaultValue={search.q} placeholder="ID or words" />
        </label>
        <label className="inline">
          <input type="checkbox" name="off" value="1" defaultChecked={!!search.off} /> Switched off only
        </label>
        <div className="row">
          <button type="submit" className="secondary">Filter</button>
          <Link href={`/admin/rule-sets/${id}`}>Clear</Link>
        </div>
      </form>
      <p className="muted">
        Showing {shown.length} of {rules.length} rules. Rules checked against other evidence (registration,
        certification, message data, disputes) apply but cannot be judged from screens and receipts; reports list them
        separately.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Rule</th>
              <th>Type</th>
              <th>Applies to</th>
              <th>Checked against</th>
              <th>Status</th>
              <th>Counts as</th>
              <th>Verified</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={r.active ? "" : "muted"}>
                <td style={{ whiteSpace: "nowrap" }}>
                  <Link href={`/admin/rules/${r.id}`}>{r.code}</Link>
                  <div className="muted">{SCHEMES[r.scheme]}</div>
                </td>
                <td>
                  {r.title}
                  {!r.active && " (switched off)"}
                  <div className="muted">
                    {r.source_reference}
                    {r.region_scope && r.region_scope !== "Global" && ` · ${r.region_scope}`}
                  </div>
                </td>
                <td>{RULE_TYPES[r.rule_type]}</td>
                <td>
                  {environmentsLabel(r.environments)}
                  {r.excluded_environments.length > 0 && (
                    <div className="muted">not {environmentsLabel(r.excluded_environments)}</div>
                  )}
                </td>
                <td>
                  {r.evaluates}
                  {!checkableFromUploads(r.evaluates) && <div className="muted">not from uploads</div>}
                </td>
                <td>
                  {RULE_STATUS[r.rule_status]}
                  {(r.valid_from || r.valid_to) && (
                    <div className="muted">
                      {r.valid_from && `from ${r.valid_from}`} {r.valid_to && `to ${r.valid_to}`}
                    </div>
                  )}
                </td>
                <td>
                  {r.rule_type === "MUST" || r.rule_type === "MUST_NOT"
                    ? `${SEVERITIES[r.severity]} · ${r.weight}`
                    : r.rule_type === "SHOULD"
                      ? "Advisory"
                      : "Context"}
                </td>
                <td>{r.verified ? "Yes" : <span className="error">No</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ChangesTab({ rules, published, publishedRules }: { rules: Rule[]; published: RuleSet; publishedRules: Rule[] }) {
  const before = new Map(publishedRules.map((r) => [r.code, r]));
  const now = new Map(rules.map((r) => [r.code, r]));
  const added = rules.filter((r) => !before.has(r.code));
  const removed = publishedRules.filter((r) => !now.has(r.code));
  const changed = rules
    .filter((r) => before.has(r.code))
    .map((r) => ({ rule: r, old: before.get(r.code)!, fields: CONTENT.filter((k) => !same(r, before.get(r.code)!, k)) }))
    .filter((c) => c.fields.length > 0);
  const settings = rules.filter((r) => {
    const o = before.get(r.code);
    return o && !changed.some((c) => c.rule.id === r.id) &&
      (["severity", "weight", "verified", "active", "notes"] as const).some((k) => !same(r, o, k));
  });

  return (
    <section>
      <p>
        Compared with the published set, v{published.number}
        {published.title && ` (${published.title})`}: {added.length} added, {removed.length} removed, {changed.length}{" "}
        changed, {settings.length} with only app settings changed.
      </p>
      {added.length > 0 && (
        <>
          <h2>Added</h2>
          <ul>
            {added.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/rules/${r.id}`}>{r.code}</Link> {r.title}
              </li>
            ))}
          </ul>
        </>
      )}
      {removed.length > 0 && (
        <>
          <h2>Removed</h2>
          <ul>
            {removed.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/rules/${r.id}`}>{r.code}</Link> {r.title}
              </li>
            ))}
          </ul>
        </>
      )}
      {changed.length > 0 && (
        <>
          <h2>Changed</h2>
          <p className="muted">
            Changed wording means the rule&apos;s severity, weight, verified and notes start again from the defaults.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>What changed</th>
                  <th>Before</th>
                  <th>Now</th>
                </tr>
              </thead>
              <tbody>
                {changed.map(({ rule, old, fields }) => (
                  <tr key={rule.id}>
                    <td>
                      <Link href={`/admin/rules/${rule.id}`}>{rule.code}</Link>
                    </td>
                    <td>{fields.map((f) => f.replace(/_/g, " ")).join(", ")}</td>
                    <td>
                      {fields.map((f) => (
                        <div key={f}>{show(old[f])}</div>
                      ))}
                    </td>
                    <td>
                      {fields.map((f) => (
                        <div key={f}>{show(rule[f])}</div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {settings.length > 0 && (
        <>
          <h2>App settings changed</h2>
          <ul>
            {settings.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/rules/${r.id}`}>{r.code}</Link> {r.title}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const show = (v: unknown) =>
  v === null || v === undefined || v === "" ? "–" : Array.isArray(v) ? v.join(", ") : String(v);
