import Link from "next/link";
import ImportForm from "@/components/ImportForm";
import { startDraft } from "@/lib/actions/admin";
import { ORIGINS, requireAdmin, type RuleSet } from "@/lib/admin";
import { formatDate } from "@/lib/labels";

export const dynamic = "force-dynamic";

const STATUS = { draft: "Draft (being edited)", published: "Published (in use)", retired: "Retired" } as const;

export default async function AdminPage() {
  const { supabase } = await requireAdmin();
  const { data: sets } = await supabase
    .from("rule_sets")
    .select("id, number, status, notes, created_at, published_at, origin, title, as_of, file_name")
    .order("number", { ascending: false })
    .returns<RuleSet[]>();
  // Counted in the database: a full rule list would pass the 1000-row page limit.
  const count = async (id: string, verifiedOnly: boolean) => {
    let q = supabase.from("rules").select("id", { count: "exact", head: true }).eq("rule_set_id", id).eq("active", true);
    if (verifiedOnly) q = q.eq("verified", true);
    return (await q).count ?? 0;
  };
  const stats = new Map(
    await Promise.all(
      (sets ?? []).map(async (s) => [s.id, { total: await count(s.id, false), verified: await count(s.id, true) }] as const),
    ),
  );
  const draft = (sets ?? []).find((s) => s.status === "draft");

  return (
    <main>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Rule library</h1>
          <p className="lead">
            New submissions are checked against the published rule set. Import the latest ruleset file, or edit a
            draft, then publish. Earlier results keep the rule set they were checked against.
          </p>
        </div>
        {draft ? (
          <Link href={`/admin/rule-sets/${draft.id}`} className="button">
            Continue editing the draft
          </Link>
        ) : (
          <form action={startDraft}>
            <button type="submit" className="secondary">Edit a copy of the published set</button>
          </form>
        )}
      </div>

      <ImportForm hasDraft={!!draft} />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Rule set</th>
              <th>Source</th>
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
                    <Link href={`/admin/rule-sets/${s.id}`}>v{s.number}</Link> {s.title}
                    {s.notes && <div className="muted">{s.notes}</div>}
                  </td>
                  <td>
                    {ORIGINS[s.origin]}
                    {s.as_of && <div className="muted">as of {s.as_of}</div>}
                    {s.file_name && <div className="muted">{s.file_name}</div>}
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
