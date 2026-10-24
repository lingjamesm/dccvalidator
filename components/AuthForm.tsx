"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/actions/auth";

type Field = { name: string; label: string; type: string; autoComplete: string };

export default function AuthForm({
  action,
  fields,
  submitLabel,
  next,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  fields: Field[];
  submitLabel: string;
  next?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="stack">
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          <input name={f.name} type={f.type} autoComplete={f.autoComplete} required />
        </label>
      ))}
      {next && <input type="hidden" name="next" value={next} />}
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      <button type="submit" disabled={pending}>
        {pending ? "Please wait…" : submitLabel}
      </button>
    </form>
  );
}
