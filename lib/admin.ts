import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
