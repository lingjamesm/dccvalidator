import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import { CHANNELS, SCHEMES, STATUS, formatDate, type Submission } from "@/lib/labels";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type FileRow = {
  id: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  status: "quarantine" | "processing" | "masked" | "rejected";
  pan_masked_count: number | null;
  rejection_reason: string | null;
};

function maskingLabel(f: FileRow) {
  if (f.status === "masked") {
    const n = f.pan_masked_count ?? 0;
    return n === 0 ? "No card numbers found" : `${n} card number${n === 1 ? "" : "s"} masked`;
  }
  if (f.status === "rejected") return `Removed: ${f.rejection_reason ?? "could not be checked"}`;
  return "Checking for card numbers…";
}

export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Not owned and not shared means row level security returns nothing: a plain 404.
  const { data: submission } = await supabase
    .from("submissions")
    .select("id, owner_id, entry_id, version, title, channel, schemes, status, created_at")
    .eq("id", id)
    .maybeSingle<Submission>();
  if (!submission) notFound();

  const isOwner = submission.owner_id === user.id;
  const [{ data: files }, { data: versions }] = await Promise.all([
    supabase
      .from("submission_files")
      .select("id, storage_path, original_name, mime_type, size_bytes, status, pan_masked_count, rejection_reason")
      .eq("submission_id", id)
      .order("created_at")
      .returns<FileRow[]>(),
    supabase
      .from("submissions")
      .select("id, version, status, created_at")
      .eq("entry_id", submission.entry_id)
      .order("version", { ascending: false }),
  ]);

  // Short-lived download links for masked files only, issued after the access check above.
  const links = new Map<string, string>();
  const masked = (files ?? []).filter((f) => f.status === "masked");
  const pending = (files ?? []).some((f) => f.status === "quarantine" || f.status === "processing");
  if (masked.length) {
    const { data: signed } = await supabase.storage
      .from("submissions")
      .createSignedUrls(masked.map((f) => f.storage_path), 300);
    signed?.forEach((s) => s.signedUrl && s.path && links.set(s.path, s.signedUrl));
  }

  return (
    <main>
      {pending && <AutoRefresh />}
      <p>
        <Link href="/workspace">← Workspace</Link>
      </p>
      <h1>
        {submission.title} {submission.version > 1 && <span className="muted">· version {submission.version}</span>}
      </h1>
      <p className="lead">
        {CHANNELS[submission.channel]} · {submission.schemes.map((k) => SCHEMES[k]).join(", ")} · submitted{" "}
        {formatDate(submission.created_at)}
        {!isOwner && " · shared with you (read-only)"}
      </p>

      <div className="card">
        <p>
          Status: <span className="badge">{STATUS[submission.status]}</span>
        </p>
        <p className="muted">
          Automated validation against Visa and Mastercard rules is being built next. Your files are
          stored safely in your workspace and will be checked once it is ready.
        </p>
      </div>

      <h2>Files</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Card numbers</th>
              <th>Type</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {(files ?? []).map((f) => (
              <tr key={f.id}>
                <td>
                  {links.get(f.storage_path) ? (
                    <a href={links.get(f.storage_path)} target="_blank" rel="noreferrer">
                      {f.original_name}
                    </a>
                  ) : (
                    f.original_name
                  )}
                </td>
                <td className={f.status === "rejected" ? "error" : f.status === "masked" ? "" : "muted"}>
                  {maskingLabel(f)}
                </td>
                <td>{f.mime_type === "application/pdf" ? "PDF" : "Image"}</td>
                <td>{(f.size_bytes / 1024 / 1024).toFixed(1)} MB</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {versions && versions.length > 1 && (
        <>
          <h2>Versions</h2>
          <ul>
            {versions.map((v) => (
              <li key={v.id}>
                {v.id === submission.id ? (
                  <strong>Version {v.version}</strong>
                ) : (
                  <Link href={`/workspace/${v.id}`}>Version {v.version}</Link>
                )}{" "}
                <span className="muted">· {formatDate(v.created_at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {isOwner && (
        <p style={{ marginTop: 32 }}>
          <Link href={`/workspace/new?entry=${submission.id}`} className="button secondary">
            Submit a new version
          </Link>
        </p>
      )}
    </main>
  );
}
