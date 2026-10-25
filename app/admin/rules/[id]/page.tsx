import Link from "next/link";
import { notFound } from "next/navigation";
import RuleForm from "@/components/RuleForm";
import { deleteRule } from "@/lib/actions/admin";
import { requireAdmin, type Fact, type Rule } from "@/lib/admin";

export const dynamic = "force-dynamic";

export default async function RulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireAdmin();
  const { data: rule } = await supabase.from("rules").select("*").eq("id", id).maybeSingle<Rule>();
  if (!rule) notFound();
  const [{ data: set }, { data: facts }] = await Promise.all([
    supabase.from("rule_sets").select("number, status").eq("id", rule.rule_set_id).single(),
    supabase.from("fact_definitions").select("*").order("sort").returns<Fact[]>(),
  ]);
  const isDraft = set?.status === "draft";

  return (
    <main className="narrow">
      <p>
        <Link href={`/admin/rule-sets/${rule.rule_set_id}`}>← Rule set v{set?.number}</Link>
      </p>
      <h1>{rule.code}</h1>
      {!isDraft && (
        <p className="notice">This rule set is {set?.status} and cannot be changed. Start a new draft to edit it.</p>
      )}
      <RuleForm rule={rule} ruleSetId={rule.rule_set_id} facts={facts ?? []} readOnly={!isDraft} />
      {isDraft && (
        <form action={deleteRule} style={{ marginTop: 24 }}>
          <input type="hidden" name="id" value={rule.id} />
          <input type="hidden" name="rule_set_id" value={rule.rule_set_id} />
          <button type="submit" className="link">Delete this rule from the draft</button>
        </form>
      )}
    </main>
  );
}
