import Link from "next/link";
import FactForm from "@/components/FactForm";
import { DOCUMENTS, requireAdmin, type Fact } from "@/lib/admin";

export const dynamic = "force-dynamic";

export default async function FactsPage() {
  const { supabase } = await requireAdmin();
  const { data: facts } = await supabase.from("fact_definitions").select("*").order("sort").returns<Fact[]>();

  return (
    <main className="narrow">
      <p>
        <Link href="/admin">← Rule library</Link>
      </p>
      <h1>Questions the AI answers</h1>
      <p className="lead">
        The AI answers these about each submission&apos;s screens and receipts, quoting what it sees. Rules then decide
        pass or fail from the answers. A question&apos;s key cannot change, because rules refer to it.
      </p>

      <h2>Add a question</h2>
      <div className="card">
        <FactForm />
      </div>

      {(Object.keys(DOCUMENTS) as Fact["document"][]).map((doc) => (
        <section key={doc}>
          <h2>{DOCUMENTS[doc]}</h2>
          {(facts ?? [])
            .filter((f) => f.document === doc)
            .map((f) => (
              <details key={f.key} className="card">
                <summary>
                  <code>{f.key}</code> {f.question} {f.kind === "number" && <span className="badge">number</span>}
                </summary>
                <FactForm fact={f} />
              </details>
            ))}
        </section>
      ))}
    </main>
  );
}
