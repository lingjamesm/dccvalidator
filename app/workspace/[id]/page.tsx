import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import {
  CHANNELS,
  OUTCOMES,
  SCHEMES,
  STATUS,
  VERDICTS,
  formatDate,
  type Finding,
  type Submission,
  type ValidationResult,
} from "@/lib/labels";
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
    .select("id, owner_id, entry_id, version, title, channel, schemes, status, created_at, result")
    .eq("id", id)
    .maybeSingle<Submission & { result: ValidationResult | null }>();
  if (!submission) notFound();

  const isOwner = submission.owner_id === user.id;
  const [{ data: files }, { data: versions }, { data: outputs }] = await Promise.all([
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
    supabase.from("submission_outputs").select("kind, storage_path, file_name").eq("submission_id", id),
  ]);

  // Short-lived download links for masked files only, issued after the access check above.
  const links = new Map<string, string>();
  const masked = (files ?? []).filter((f) => f.status === "masked");
  const pending =
    (files ?? []).some((f) => f.status === "quarantine" || f.status === "processing") ||
    submission.status === "uploaded" ||
    submission.status === "processing";
  const report = (outputs ?? []).find((o) => o.kind === "report");
  const toSign = [...masked.map((f) => f.storage_path), ...(report ? [report.storage_path] : [])];
  if (toSign.length) {
    const { data: signed } = await supabase.storage.from("submissions").createSignedUrls(toSign, 300);
    signed?.forEach((s) => s.signedUrl && s.path && links.set(s.path, s.signedUrl));
  }
  const result = submission.result;

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
        {submission.status === "uploaded" && (
          <p className="muted">Waiting for card numbers to be masked, then the check starts automatically.</p>
        )}
        {submission.status === "processing" && (
          <p className="muted">Checking against the Visa and Mastercard rules. This usually takes a minute or two.</p>
        )}
        {submission.status === "failed" && <p className="error">{result?.error ?? "Validation could not be completed."}</p>}
        {submission.status === "complete" && result?.validated_at && (
          <p className="muted">
            Checked {formatDate(result.validated_at)} against rule set v{result.rule_set?.number}.{" "}
            {report && links.get(report.storage_path) && (
              <a href={links.get(report.storage_path)} target="_blank" rel="noreferrer">
                Download the PDF report
              </a>
            )}
          </p>
        )}
      </div>

      {submission.status === "complete" && result?.schemes && <Results submission={submission} result={result} />}

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

const ORDER = { fail: 0, needs_review: 1, pass: 2 } as const;

function Results({ submission, result }: { submission: Submission; result: ValidationResult }) {
  const findings = result.findings ?? [];
  const unverified = findings.filter((f) => !f.verified).length;
  const docName = (f: Finding) =>
    f.document !== null && result.documents?.[f.document] ? ` (${result.documents[f.document].name})` : "";
  return (
    <>
      <h2>Results</h2>
      {unverified > 0 && (
        <p className="notice">
          {unverified} of the {findings.length} rules used are still drafts that have not been verified against the
          official scheme documents, so treat this result as indicative.
        </p>
      )}
      <div className="scores" style={{ marginTop: 12 }}>
        {submission.schemes.map((k) => {
          const s = result.schemes?.[k];
          if (!s) return null;
          return (
            <div key={k} className="card">
              <div className="muted">{SCHEMES[k]}</div>
              <div className="score">{s.score === null ? "–" : `${s.score}%`}</div>
              <div className={s.verdict === "compliant" ? "outcome-pass" : s.verdict === "not_compliant" ? "outcome-fail" : "outcome-needs_review"}>
                {VERDICTS[s.verdict]}
              </div>
              <div className="muted">
                {s.passed} passed · {s.failed} failed · {s.needs_review} to review
              </div>
            </div>
          );
        })}
      </div>
      {result.overview && <p>{result.overview}</p>}

      {submission.schemes.map((k) => {
        const mine = findings.filter((f) => f.scheme === k).sort((a, b) => ORDER[a.outcome] - ORDER[b.outcome]);
        if (!mine.length) return null;
        return (
          <section key={k}>
            <h3>{SCHEMES[k]} findings</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Result</th>
                    <th>What was found</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((f) => (
                    <tr key={f.rule_id}>
                      <td>
                        <strong>{f.code}</strong> {f.title}
                        <div className="muted">
                          {f.severity === "critical" ? "Critical · " : ""}
                          {f.source}
                          {!f.verified && " · draft rule"}
                        </div>
                      </td>
                      <td className={`outcome-${f.outcome}`}>{OUTCOMES[f.outcome]}</td>
                      <td>
                        {f.evidence}
                        {docName(f)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <p className="muted">
        How this works: an AI model reads your masked files and answers fixed questions about them; the published rule
        set then decides each pass or fail. A failed critical rule means not compliant, whatever the score. The score
        is the weighted share of rules that passed.
      </p>
    </>
  );
}
