import Link from "next/link";
import { notFound } from "next/navigation";
import { discardDraft, publishDraft, saveDraftNotes } from "@/lib/actions/admin";
import { SEVERITIES, requireAdmin, type Rule, type RuleSet } from "@/lib/admin";
import { CHANNELS, SCHEMES } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function RuleSetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireAdmin();
  const { data: set } = await supabase.from("rule_sets").select("*").eq("id", id).maybeSingle<RuleSet>();
  if (!set) notFound();
  const { data: rules } = await supabase
    .from("rules")
    .select("*")
    .eq("rule_set_id", id)
    .order("sort")
    .order("code")
    .returns<Rule[]>();
  const isDraft = set.status === "draft";
  const unverified = (rules ?? []).filter((r) => r.active && !r.verified).length;

  return (
    <main>
      <p>
        <Link href="/admin">← Rule library</Link>
      </p>
      <h1>
        Rule set v{set.number} <span className="muted">· {isDraft ? "draft" : set.status}</span>
      </h1>
      {isDraft ? (
        <>
          <form action={saveDraftNotes} className="row">
            <input type="hidden" name="id" value={set.id} />
            <input type="text" name="notes" defaultValue={set.notes} placeholder="What changed in this version" style={{ flex: 1 }} />
            <button type="submit" className="secondary">Save note</button>
          </form>
          <div className="card">
            <p>
              Edit, add or switch off rules below. When you publish, this draft replaces v{set.number - 1 || 1} for all
              new validations.
              {unverified > 0 && ` ${unverified} active rule${unverified === 1 ? " is" : "s are"} not yet verified; reports will say so.`}
            </p>
            <div className="row">
              <Link href={`/admin/rule-sets/${set.id}/new`} className="button secondary">
                Add a rule
              </Link>
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
        <p className="lead">{set.notes || "Published rule sets cannot be changed. Start a new draft to make changes."}</p>
      )}

      {(Object.keys(SCHEMES) as (keyof typeof SCHEMES)[]).map((scheme) => {
        const mine = (rules ?? []).filter((r) => r.scheme === scheme);
        if (!mine.length) return null;
        return (
          <section key={scheme}>
            <h2>{SCHEMES[scheme]}</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Rule</th>
                    <th>Channels</th>
                    <th>Check</th>
                    <th>Severity</th>
                    <th>Weight</th>
                    <th>Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((r) => (
                    <tr key={r.id} className={r.active ? "" : "muted"}>
                      <td>
                        <Link href={`/admin/rules/${r.id}`}>{r.code}</Link>
                      </td>
                      <td>
                        {r.title}
                        {!r.active && " (switched off)"}
                        <div className="muted">{r.source_reference}</div>
                      </td>
                      <td>{r.channels.length === 3 ? "All" : r.channels.map((c) => CHANNELS[c]).join(", ")}</td>
                      <td>{r.check_type === "fact" ? r.fact_key : "AI judgement"}</td>
                      <td>{SEVERITIES[r.severity]}</td>
                      <td>{r.weight}</td>
                      <td>{r.verified ? "Yes" : <span className="error">No</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </main>
  );
}
