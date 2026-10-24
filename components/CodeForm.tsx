"use client";

import { useState } from "react";

// Six-digit authenticator code entry.
export default function CodeForm({
  onSubmit,
  submitLabel,
}: {
  onSubmit: (code: string) => Promise<string | undefined>;
  submitLabel: string;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(await onSubmit(code));
        setPending(false);
      }}
    >
      <label>
        6-digit code from Google Authenticator
        <input
          className="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
          autoFocus
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={pending || code.length !== 6}>
        {pending ? "Checking…" : submitLabel}
      </button>
    </form>
  );
}
