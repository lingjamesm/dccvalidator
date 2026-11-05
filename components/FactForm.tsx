"use client";

import { useActionState } from "react";
import { saveFact, type AdminState } from "@/lib/actions/admin";
import { DOCUMENTS, type Fact } from "@/lib/rules";

export default function FactForm({ fact }: { fact?: Fact }) {
  const [state, formAction, pending] = useActionState<AdminState, FormData>(saveFact, undefined);
  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="is_new" value={fact ? "0" : "1"} />
      <div className="row">
        <label>
          Key
          {fact ? (
            <input type="text" name="key" value={fact.key} readOnly />
          ) : (
            <input type="text" name="key" required placeholder="rc_tip_line" pattern="[a-z][a-z0-9_]+" />
          )}
        </label>
        <label>
          Looks at
          <select name="document" defaultValue={fact?.document ?? "choice_screen"}>
            {Object.entries(DOCUMENTS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        {!fact && (
          <label>
            Answer
            <select name="kind" defaultValue="yes_no">
              <option value="yes_no">Yes or no</option>
              <option value="number">A number</option>
            </select>
          </label>
        )}
        <label>
          Order
          <input type="text" inputMode="numeric" name="sort" defaultValue={fact?.sort ?? 0} />
        </label>
      </div>
      <label>
        Question for the AI
        <textarea name="question" defaultValue={fact?.question} required rows={2} maxLength={500} />
      </label>
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      {state?.saved && <p className="success">Saved.</p>}
      <button type="submit" className="secondary" disabled={pending}>
        {pending ? "Saving…" : fact ? "Save question" : "Add question"}
      </button>
    </form>
  );
}
