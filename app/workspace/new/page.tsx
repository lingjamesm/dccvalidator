import Link from "next/link";
import NewSubmissionForm from "@/components/NewSubmissionForm";
import { createClient } from "@/lib/supabase/server";

export default async function NewSubmissionPage({ searchParams }: { searchParams: Promise<{ entry?: string }> }) {
  const { entry } = await searchParams;
  let defaults: { entryId?: string; title?: string; channel?: string; schemes?: string[] } = {};

  if (entry) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data } = await supabase
      .from("submissions")
      .select("entry_id, title, channel, schemes, owner_id")
      .eq("id", entry)
      .maybeSingle();
    if (data && data.owner_id === user?.id) {
      defaults = { entryId: data.entry_id, title: data.title, channel: data.channel, schemes: data.schemes };
    }
  }

  return (
    <main className="narrow">
      <p>
        <Link href="/workspace">← Workspace</Link>
      </p>
      <h1>{defaults.entryId ? "Submit a new version" : "New DCC validation"}</h1>
      <p className="lead">
        {defaults.entryId
          ? "Upload your updated screens and receipts. The earlier version stays in your history."
          : "Upload the DCC screens and receipts you want checked."}
      </p>
      <div className="card">
        <NewSubmissionForm defaults={defaults} />
      </div>
    </main>
  );
}
