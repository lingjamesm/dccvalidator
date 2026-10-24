import Link from "next/link";
import { CHANNELS, SCHEMES, STATUS, formatDate, type Submission } from "@/lib/labels";

export default function SubmissionTable({ rows, owners }: { rows: Submission[]; owners?: Map<string, string> }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Submission</th>
            {owners && <th>Shared by</th>}
            <th>Channel</th>
            <th>Schemes</th>
            <th>Status</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td>
                <Link href={`/workspace/${s.id}`}>{s.title}</Link>
                {s.version > 1 && <span className="muted"> · version {s.version}</span>}
              </td>
              {owners && <td>{owners.get(s.owner_id) ?? "Another user"}</td>}
              <td>{CHANNELS[s.channel]}</td>
              <td>{s.schemes.map((k) => SCHEMES[k]).join(", ")}</td>
              <td>
                <span className="badge">{STATUS[s.status]}</span>
              </td>
              <td>{formatDate(s.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
