"use client";

import { useActionState } from "react";
import { saveRuleSettings, type AdminState } from "@/lib/actions/admin";
import { SEVERITIES, type Rule } from "@/lib/rules";

// Rules from an imported file keep the file's wording; the app only sets how
// each one counts and whether it has been checked.
export default function RuleSettingsForm({ rule, readOnly }: { rule: Rule; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<AdminState, FormData>(saveRuleSettings, undefined);
  return (
    <form action={formAction} className="stack card">
      <fieldset disabled={readOnly} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <input type="hidden" name="id" value={rule.id} />
        <input type="hidden" name="rule_set_id" value={rule.rule_set_id} />
        <div className="row">
          <label>
            Severity
            <select name="severity" defaultValue={rule.severity}>
              {Object.entries(SEVERITIES).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Weight (1 to 10)
            <select name="weight" defaultValue={rule.weight}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">
          Only Must and Must not rules are scored. A failed critical rule makes the scheme result Not compliant whatever
          the score.
        </p>
        <label className="inline">
          <input type="checkbox" name="verified" defaultChecked={rule.verified} /> Verified against the official scheme
          document
        </label>
        <label className="inline">
          <input type="checkbox" name="active" defaultChecked={rule.active} /> Active (switched-off rules are not checked)
        </label>
        <label>
          Internal notes
          <textarea name="notes" defaultValue={rule.notes} rows={2} />
        </label>
        <p className="muted">These settings carry over to the next import if the rule&apos;s ID and wording are unchanged.</p>
        {state?.error && <p className="error" role="alert">{state.error}</p>}
        {state?.saved && <p className="success">Saved.</p>}
        {!readOnly && (
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save settings"}
          </button>
        )}
      </fieldset>
    </form>
  );
}
