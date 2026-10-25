"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";

export type AdminState = { error?: string; saved?: boolean } | undefined;

const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function startDraft() {
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase.rpc("start_rule_set_draft");
  if (error) throw new Error(error.message);
  redirect(`/admin/rule-sets/${data}`);
}

export async function publishDraft(formData: FormData) {
  const { supabase } = await requireAdmin();
  const { error } = await supabase.rpc("publish_rule_set", { draft: text(formData, "id") });
  if (error) throw new Error(error.message);
  revalidatePath("/admin");
  redirect("/admin");
}

export async function discardDraft(formData: FormData) {
  const { supabase } = await requireAdmin();
  const { error } = await supabase.rpc("discard_rule_set_draft", { draft: text(formData, "id") });
  if (error) throw new Error(error.message);
  redirect("/admin");
}

export async function saveDraftNotes(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = text(formData, "id");
  await supabase.from("rule_sets").update({ notes: text(formData, "notes") }).eq("id", id);
  revalidatePath(`/admin/rule-sets/${id}`);
}

export async function saveRule(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { supabase } = await requireAdmin();
  const id = text(formData, "id");
  const ruleSetId = text(formData, "rule_set_id");
  const checkType = text(formData, "check_type");
  const expected = text(formData, "expected");
  const thresholdText = text(formData, "threshold");
  const channels = formData.getAll("channels").map(String);

  if (!channels.length) return { error: "Pick at least one channel." };
  const usesThreshold = checkType === "fact" && (expected === "at_least" || expected === "at_most");
  const threshold = usesThreshold ? Number(thresholdText) : null;
  if (usesThreshold && (thresholdText === "" || Number.isNaN(threshold))) {
    return { error: "Enter the number to compare against." };
  }

  const fields = {
    code: text(formData, "code").toUpperCase(),
    scheme: text(formData, "scheme"),
    channels,
    title: text(formData, "title"),
    requirement: text(formData, "requirement"),
    source_reference: text(formData, "source_reference"),
    check_type: checkType,
    fact_key: checkType === "fact" ? text(formData, "fact_key") || null : null,
    expected: checkType === "fact" ? expected || null : null,
    threshold,
    severity: text(formData, "severity"),
    weight: Number(text(formData, "weight")),
    verified: formData.get("verified") === "on",
    active: formData.get("active") === "on",
    notes: text(formData, "notes"),
    sort: Number(text(formData, "sort") || 0),
  };
  if (checkType === "fact" && !fields.fact_key) return { error: "Pick the question this rule checks." };

  const { error } = id
    ? await supabase.from("rules").update(fields).eq("id", id)
    : await supabase.from("rules").insert({ ...fields, rule_set_id: ruleSetId });
  if (error) {
    if (error.code === "23505") return { error: "Another rule in this set already uses that code." };
    if (error.code === "23514") return { error: "Please check the code (capital letters, digits and dashes) and the other fields." };
    return { error: error.message };
  }
  revalidatePath(`/admin/rule-sets/${ruleSetId}`);
  redirect(`/admin/rule-sets/${ruleSetId}`);
}

export async function deleteRule(formData: FormData) {
  const { supabase } = await requireAdmin();
  const ruleSetId = text(formData, "rule_set_id");
  const { error } = await supabase.from("rules").delete().eq("id", text(formData, "id"));
  if (error) throw new Error(error.message);
  redirect(`/admin/rule-sets/${ruleSetId}`);
}

export async function saveFact(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { supabase } = await requireAdmin();
  const isNew = formData.get("is_new") === "1";
  const fields = {
    document: text(formData, "document"),
    question: text(formData, "question"),
    sort: Number(text(formData, "sort") || 0),
  };
  const { error } = isNew
    ? await supabase.from("fact_definitions").insert({
        ...fields,
        key: text(formData, "key").toLowerCase(),
        kind: text(formData, "kind"),
      })
    : await supabase.from("fact_definitions").update(fields).eq("key", text(formData, "key"));
  if (error) {
    if (error.code === "23505") return { error: "That key is already used." };
    if (error.code === "23514") return { error: "Keys use lower-case letters, digits and underscores; questions need at least 5 characters." };
    return { error: error.message };
  }
  revalidatePath("/admin/facts");
  return { saved: true };
}
