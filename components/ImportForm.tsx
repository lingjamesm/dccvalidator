"use client";

import { useActionState } from "react";
import { importRuleset, type ImportState } from "@/lib/actions/admin";

export default function ImportForm({ hasDraft }: { hasDraft: boolean }) {
  const [state, formAction, pending] = useActionState<ImportState, FormData>(importRuleset, undefined);
  return (
    <form action={formAction} className="stack card">
      <h2 style={{ margin: 0 }}>Import a ruleset file</h2>
      <p className="muted" style={{ margin: 0 }}>
        Upload the latest DCC ruleset JSON. It is checked, then becomes a draft you can review and compare with the
        published set before publishing. Severity, weight, verified, active and notes you set here carry over for every
        rule whose ID and wording are unchanged.
        {hasDraft && " The current draft will be replaced."}
      </p>
      <label>
        Ruleset file (.json)
        <input type="file" name="file" accept=".json,application/json" required />
      </label>
      {state?.errors && state.errors.length > 0 && (
        <div className="error" role="alert">
          <p style={{ margin: 0 }}>The file was not imported:</p>
          <ul>
            {state.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {state?.warnings && state.warnings.length > 0 && (
        <ul className="notice">
          {state.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <div>
        <button type="submit" disabled={pending}>
          {pending ? "Checking and importing…" : "Check and import"}
        </button>
      </div>
    </form>
  );
}
