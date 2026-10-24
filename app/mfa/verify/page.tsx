"use client";

import CodeForm from "@/components/CodeForm";
import { createClient } from "@/lib/supabase/client";

export default function MfaVerifyPage() {
  async function verify(code: string) {
    const supabase = createClient();
    const { data } = await supabase.auth.mfa.listFactors();
    const factor = data?.totp.find((f) => f.status === "verified");
    if (!factor) {
      window.location.assign("/mfa/setup");
      return;
    }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (error) return "That code didn't match. Try the newest code in Google Authenticator.";
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.assign(next?.startsWith("/") && !next.startsWith("//") ? next : "/workspace");
  }

  return (
    <main className="narrow">
      <h1>Enter your authenticator code</h1>
      <p className="lead">Open Google Authenticator and enter the code shown for DCC Validator.</p>
      <div className="card">
        <CodeForm onSubmit={verify} submitLabel="Continue" />
      </div>
      <p className="muted">Lost your phone? Contact the administrator to reset your 2FA after an identity check.</p>
    </main>
  );
}
