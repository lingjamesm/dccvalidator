"use client";

import { useActionState, useState } from "react";
import { saveRule, type AdminState } from "@/lib/actions/admin";
import { DOCUMENTS, EXPECTED, SEVERITIES, type Fact, type Rule } from "@/lib/rules";
import { CHANNELS, SCHEMES } from "@/lib/labels";

export default function RuleForm({
  rule,
  ruleSetId,
  facts,
  readOnly,
}: {
  rule?: Rule;
  ruleSetId: string;
  facts: Fact[];
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<AdminState, FormData>(saveRule, undefined);
  const [checkType, setCheckType] = useState(rule?.check_type ?? "fact");
  const [expected, setExpected] = useState(rule?.expected ?? "yes");
  const [factKey, setFactKey] = useState(rule?.fact_key ?? "");
  const fact = facts.find((f) => f.key === factKey);

  return (
    <form action={formAction} className="stack">
      <fieldset disabled={readOnly} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        {rule && <input type="hidden" name="id" value={rule.id} />}
        <input type="hidden" name="rule_set_id" value={ruleSetId} />
        <div className="row">
          <label>
            Code
            <input type="text" name="code" defaultValue={rule?.code} required maxLength={31} placeholder="V-30" />
          </label>
          <label>
            Scheme
            <select name="scheme" defaultValue={rule?.scheme ?? "visa"}>
              {Object.entries(SCHEMES).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Order
            <input type="text" inputMode="numeric" name="sort" defaultValue={rule?.sort ?? 0} />
          </label>
        </div>
        <div>
          Applies to
          <div className="row">
            {Object.entries(CHANNELS).map(([k, v]) => (
              <label key={k} className="inline">
                <input
                  type="checkbox"
                  name="channels"
                  value={k}
                  defaultChecked={rule ? rule.channels.includes(k as Rule["channels"][number]) : true}
                />{" "}
                {v}
              </label>
            ))}
          </div>
        </div>
        <label>
          Title
          <input type="text" name="title" defaultValue={rule?.title} required maxLength={200} />
        </label>
        <label>
          Requirement (shown in reports and, for judgement rules, given to the AI)
          <textarea name="requirement" defaultValue={rule?.requirement} required rows={4} maxLength={2000} />
        </label>
        <label>
          Source reference
          <input type="text" name="source_reference" defaultValue={rule?.source_reference} placeholder="Document, section and page" />
        </label>

        <label>
          How it is checked
          <select name="check_type" value={checkType} onChange={(e) => setCheckType(e.target.value as Rule["check_type"])}>
            <option value="fact">From one question the AI answers (decided by the rule)</option>
            <option value="judgement">AI judgement against the requirement text</option>
          </select>
        </label>
        {checkType === "fact" && (
          <div className="card stack">
            <label>
              Question
              <select name="fact_key" value={factKey} onChange={(e) => setFactKey(e.target.value)} required>
                <option value="">Choose a question…</option>
                {facts.map((f) => (
                  <option key={f.key} value={f.key}>
                    {DOCUMENTS[f.document]}: {f.question}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <label>
                Passes when the answer is
                <select name="expected" value={expected} onChange={(e) => setExpected(e.target.value as NonNullable<Rule["expected"]>)}>
                  {Object.entries(EXPECTED)
                    .filter(([k]) => fact?.kind === "number" || k === "yes" || k === "no")
                    .map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                </select>
              </label>
              {(expected === "at_least" || expected === "at_most") && (
                <label>
                  Number
                  <input type="text" inputMode="decimal" name="threshold" defaultValue={rule?.threshold ?? ""} required />
                </label>
              )}
            </div>
            <p className="muted">If the AI cannot see the answer, the rule is marked as needing review.</p>
          </div>
        )}

        <div className="row">
          <label>
            Severity
            <select name="severity" defaultValue={rule?.severity ?? "major"}>
              {Object.entries(SEVERITIES).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Weight (1 to 10)
            <select name="weight" defaultValue={rule?.weight ?? 5}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">A failed critical rule makes the scheme result Not compliant whatever the score.</p>
        <label className="inline">
          <input type="checkbox" name="verified" defaultChecked={rule?.verified ?? false} /> Verified against the official
          scheme document
        </label>
        <label className="inline">
          <input type="checkbox" name="active" defaultChecked={rule?.active ?? true} /> Active (switched-off rules are not
          checked)
        </label>
        <label>
          Internal notes
          <textarea name="notes" defaultValue={rule?.notes} rows={2} />
        </label>
        {state?.error && <p className="error" role="alert">{state.error}</p>}
        {!readOnly && (
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save rule"}
          </button>
        )}
      </fieldset>
    </form>
  );
}
