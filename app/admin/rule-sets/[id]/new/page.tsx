import Link from "next/link";
import { notFound } from "next/navigation";
import RuleForm from "@/components/RuleForm";
import { requireAdmin, type Fact } from "@/lib/admin";

export const dynamic = "force-dynamic";

export default async function NewRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireAdmin();
  const { data: set } = await supabase.from("rule_sets").select("id, number, status").eq("id", id).maybeSingle();
  if (!set || set.status !== "draft") notFound();
  const { data: facts } = await supabase.from("fact_definitions").select("*").order("sort").returns<Fact[]>();
  return (
    <main className="narrow">
      <p>
        <Link href={`/admin/rule-sets/${id}`}>← Rule set v{set.number}</Link>
      </p>
      <h1>Add a rule</h1>
      <RuleForm ruleSetId={id} facts={facts ?? []} readOnly={false} />
    </main>
  );
}
