import Link from "next/link";
import { startDraft } from "@/lib/actions/admin";
import { requireAdmin, type RuleSet } from "@/lib/admin";
import { formatDate } from "@/lib/labels";

export const dynamic = "force-dynamic";

const STATUS = { draft: "Draft (being edited)", published: "Published (in use)", retired: "Retired" } as const;

export default async function AdminPage() {
  const { supabase } = await requireAdmin();
  const [{ data: sets }, { data: rules }] = await Promise.all([
    supabase.from("rule_sets").select("*").order("number", { ascending: false }).returns<RuleSet[]>(),
    supabase.from("rules").select("rule_set_id, verified, active"),
  ]);
  const stats = new Map<string, { total: number; verified: number }>();
  (rules ?? []).forEach((r) => {
    const s = stats.get(r.rule_set_id) ?? { total: 0, verified: 0 };
    if (r.active) {
      s.total += 1;
      if (r.verified) s.verified += 1;
    }
    stats.set(r.rule_set_id, s);
  });
  const draft = (sets ?? []).find((s) => s.status === "draft");

  return (
    <main>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Rule library</h1>
          <p className="lead">
            New submissions are checked against the published rule set. Changes are made in a draft, then published.
            Earlier results keep the rule set they were checked against.
          </p>
        </div>
        {draft ? (
          <Link href={`/admin/rule-sets/${draft.id}`} className="button">
            Continue editing the draft
          </Link>
        ) : (
          <form action={startDraft}>
            <button type="submit">Start a new draft</button>
          </form>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Rule set</th>
              <th>Status</th>
              <th>Active rules</th>
              <th>Verified</th>
              <th>Published</th>
            </tr>
          </thead>
          <tbody>
            {(sets ?? []).map((s) => {
              const st = stats.get(s.id) ?? { total: 0, verified: 0 };
              return (
                <tr key={s.id}>
                  <td>
                    <Link href={`/admin/rule-sets/${s.id}`}>v{s.number}</Link>
                    {s.notes && <div className="muted">{s.notes}</div>}
                  </td>
                  <td>
                    <span className="badge">{STATUS[s.status]}</span>
                  </td>
                  <td>{st.total}</td>
                  <td className={st.verified < st.total ? "error" : ""}>
                    {st.verified} of {st.total}
                  </td>
                  <td>{s.published_at ? formatDate(s.published_at) : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 24 }}>
        <Link href="/admin/facts">Questions the AI answers →</Link>
      </p>
    </main>
  );
}
