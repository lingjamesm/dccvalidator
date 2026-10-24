"use client";

import { useEffect, useState } from "react";
import CodeForm from "@/components/CodeForm";
import { createClient } from "@/lib/supabase/client";

type Enrollment = { factorId: string; qr: string; secret: string };

export default function MfaSetupPage() {
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      // Clear any half-finished setup from an earlier visit, then start fresh.
      const { data: factors } = await supabase.auth.mfa.listFactors();
      for (const f of factors?.all ?? []) {
        if (f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Google Authenticator ${new Date().toISOString().slice(0, 10)}`,
        issuer: "DCC Validator",
      });
      if (error || !data) return setError(error?.message ?? "Could not start 2FA setup.");
      setEnrollment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    })();
  }, []);

  async function verify(code: string) {
    if (!enrollment) return "Setup has not started yet.";
    const supabase = createClient();
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrollment.factorId, code });
    if (error) return "That code didn't match. Check the time on your phone and try the newest code.";
    window.location.assign("/workspace");
  }

  return (
    <main className="narrow">
      <h1>Set up two-factor authentication</h1>
      <p className="lead">Every account is protected by Google Authenticator. This takes about a minute.</p>
      <div className="card stack">
        <ol>
          <li>Install <strong>Google Authenticator</strong> from the App Store or Google Play.</li>
          <li>In the app, tap <strong>+</strong>, then <strong>Scan a QR code</strong>, and scan the code below.</li>
          <li>Type the 6-digit code the app shows.</li>
        </ol>
        {error && <p className="error">{error}</p>}
        {enrollment ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="qr" src={enrollment.qr} alt="QR code for Google Authenticator" />
            <details>
              <summary className="muted">Can't scan? Enter this key instead</summary>
              <code className="secret">{enrollment.secret}</code>
            </details>
            <CodeForm onSubmit={verify} submitLabel="Turn on 2FA" />
          </>
        ) : (
          !error && <p className="muted">Preparing your QR code…</p>
        )}
      </div>
    </main>
  );
}
