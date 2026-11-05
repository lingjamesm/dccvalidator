// Shows whatever an imported ruleset file carries (text, lists, objects, tables)
// without the app needing to know each section's columns in advance.

type Value = unknown;

const label = (key: string) => key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function DataValue({ value }: { value: Value }) {
  if (value === null || value === undefined || value === "") return <span className="muted">–</span>;
  if (typeof value !== "object") return <>{String(value)}</>;
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null)) {
      return value.length > 3 ? (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {value.map((v, i) => (
            <li key={i}>{String(v)}</li>
          ))}
        </ul>
      ) : (
        <>{value.join(", ")}</>
      );
    }
    if (value.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      return <DataTable rows={value as Record<string, Value>[]} />;
    }
    return <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(value, null, 2)}</pre>;
  }
  return <DataList data={value as Record<string, Value>} />;
}

export function DataList({ data }: { data: Record<string, Value> }) {
  return (
    <dl className="data-list">
      {Object.entries(data).map(([k, v]) => (
        <div key={k}>
          <dt>{label(k)}</dt>
          <dd>
            <DataValue value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DataTable({ rows }: { rows: Record<string, Value>[] }) {
  if (!rows.length) return <p className="muted">Nothing listed.</p>;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{label(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>
                  <DataValue value={r[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
