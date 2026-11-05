import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

import type { Rule } from "@/lib/rules";

export * from "@/lib/rules";

// The rule library is for admins only. Row level security enforces this in the
// database; this check just turns everyone else away with a plain 404.
export async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profile?.role !== "admin") notFound();
  return { supabase, user };
}

type Client = Awaited<ReturnType<typeof createClient>>;

// Every rule in a set, read in pages: the API returns at most 1000 rows at a time.
export async function allRules(supabase: Client, ruleSetId: string): Promise<Rule[]> {
  const out: Rule[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("rules")
      .select("*")
      .eq("rule_set_id", ruleSetId)
      .order("sort")
      .order("code")
      .range(out.length, out.length + 999)
      .returns<Rule[]>();
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}
