import { notFound } from "next/navigation";
import { allRules, requireAdmin, type RuleSet } from "@/lib/admin";
import { rebuildRulesetFile } from "@/lib/ruleset-file";

export const dynamic = "force-dynamic";

// Downloads the rule set in the same JSON shape it was imported in.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireAdmin();
  const { data: set } = await supabase.from("rule_sets").select("*").eq("id", id).maybeSingle<RuleSet>();
  if (!set) notFound();
  const body = JSON.stringify(rebuildRulesetFile(set, await allRules(supabase, id)), null, 2);
  const name = `dcc-ruleset-v${set.number}${set.as_of ? `-${set.as_of}` : ""}.json`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
