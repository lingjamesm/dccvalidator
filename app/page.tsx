import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Check your DCC screens and receipts before certification</h1>
      <p className="lead">
        Upload your Dynamic Currency Conversion screens and receipts and get a scored check against
        Visa and Mastercard rules. Your files stay in your own private workspace, protected by
        two-factor authentication.
      </p>
      <div className="row">
        <Link href="/signup" className="button">
          Register
        </Link>
        <Link href="/login" className="button secondary">
          Sign in
        </Link>
      </div>
      <p className="muted" style={{ marginTop: 32 }}>
        Results are a pre-certification check, not a Visa or Mastercard certification.
      </p>
    </main>
  );
}
