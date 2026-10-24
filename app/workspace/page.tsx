import Link from "next/link";
import { redirect } from "next/navigation";
import SubmissionTable from "@/components/SubmissionTable";
import type { Submission } from "@/lib/labels";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Row level security returns only what this user owns or has been granted.
  const [{ data: submissions, error }, { data: shares }] = await Promise.all([
    supabase
      .from("submissions")
      .select("id, owner_id, entry_id, version, title, channel, schemes, status, created_at")
      .order("created_at", { ascending: false }),
    supabase.from("shares").select("owner_id, owner_label").eq("recipient_id", user.id).eq("status", "active"),
  ]);

  const all = (submissions ?? []) as Submission[];
  const mine = all.filter((s) => s.owner_id === user.id);
  const shared = all.filter((s) => s.owner_id !== user.id);
  const owners = new Map((shares ?? []).map((s) => [s.owner_id as string, s.owner_label as string]));

  return (
    <main>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Your workspace</h1>
          <p className="lead">Every submission and its results, newest first. Only you can see these.</p>
        </div>
        <Link href="/workspace/new" className="button">
          New DCC validation
        </Link>
      </div>

      {error && <p className="error">Could not load your workspace: {error.message}</p>}

      {mine.length ? (
        <SubmissionTable rows={mine} />
      ) : (
        <div className="card">
          <p>No submissions yet.</p>
          <p className="muted">Start a DCC validation to upload your screens and receipts.</p>
        </div>
      )}

      {shared.length > 0 && (
        <>
          <h2>Shared with me</h2>
          <p className="muted">Read-only. The owner can withdraw access at any time.</p>
          <SubmissionTable rows={shared} owners={owners} />
        </>
      )}
    </main>
  );
}
