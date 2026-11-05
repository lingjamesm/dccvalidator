import Link from "next/link";
import { notFound } from "next/navigation";
import { DataList } from "@/components/DataView";
import RuleForm from "@/components/RuleForm";
import RuleSettingsForm from "@/components/RuleSettingsForm";
import { deleteRule } from "@/lib/actions/admin";
import {
  RULE_STATUS,
  checkableFromUploads,
  environmentsLabel,
  requireAdmin,
  type Fact,
  type Rule,
} from "@/lib/admin";
import { RULE_TYPES, SCHEMES } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function RulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireAdmin();
  const { data: rule } = await supabase.from("rules").select("*").eq("id", id).maybeSingle<Rule>();
  if (!rule) notFound();
  const [{ data: set }, { data: facts }] = await Promise.all([
    supabase.from("rule_sets").select("number, status, origin").eq("id", rule.rule_set_id).single(),
    supabase.from("fact_definitions").select("*").order("sort").returns<Fact[]>(),
  ]);
  const isDraft = set?.status === "draft";
  const imported = set?.origin === "import";
  const sources = await supabase.from("rule_sets").select("document->sources").eq("id", rule.rule_set_id).single();
  const sourceNames = (sources.data as { sources?: Record<string, string> } | null)?.sources ?? {};
  const sourceKey = Object.keys(sourceNames).find((k) => rule.source_reference.startsWith(k));

  return (
    <main className={imported ? "" : "narrow"}>
      <p>
        <Link href={`/admin/rule-sets/${rule.rule_set_id}`}>← Rule set v{set?.number}</Link>
      </p>
      <h1>
        {rule.code} <span className="muted">· {SCHEMES[rule.scheme]}</span>
      </h1>
      {!isDraft && (
        <p className="notice">This rule set is {set?.status} and cannot be changed. Import a new file or start a draft to change it.</p>
      )}
      {imported ? (
        <>
          <p style={{ fontSize: "1.05rem" }}>{rule.requirement}</p>
          <div className="card">
            <DataList
              data={{
                type: RULE_TYPES[rule.rule_type],
                domain: rule.domain.replace(/_/g, " ").toLowerCase(),
                applies_to: environmentsLabel(rule.environments),
                except: rule.excluded_environments.length ? environmentsLabel(rule.excluded_environments) : "",
                checked_against: `${rule.evaluates}${checkableFromUploads(rule.evaluates) ? "" : " (not from screens or receipts: listed as not checked)"}`,
                status: RULE_STATUS[rule.rule_status],
                valid_from: rule.valid_from,
                valid_to: rule.valid_to,
                effective: rule.effective,
                region: rule.region_scope,
                group: rule.group_code,
                source: rule.source_reference,
                source_document: sourceKey ? sourceNames[sourceKey] : "",
                basis: rule.basis,
                notes_from_the_file: rule.source_notes,
              }}
            />
          </div>
          <h2>Settings in this app</h2>
          <RuleSettingsForm rule={rule} readOnly={!isDraft} />
        </>
      ) : (
        <>
          <RuleForm rule={rule} ruleSetId={rule.rule_set_id} facts={facts ?? []} readOnly={!isDraft} />
          {isDraft && (
            <form action={deleteRule} style={{ marginTop: 24 }}>
              <input type="hidden" name="id" value={rule.id} />
              <input type="hidden" name="rule_set_id" value={rule.rule_set_id} />
              <button type="submit" className="link">Delete this rule from the draft</button>
            </form>
          )}
        </>
      )}
    </main>
  );
}
