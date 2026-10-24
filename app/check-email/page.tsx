export default async function CheckEmailPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  return (
    <main className="narrow">
      <h1>Check your email</h1>
      <p className="lead">
        We sent a confirmation link to {email ? <strong>{email}</strong> : "your email address"}. Open it
        on this device to continue to two-factor setup.
      </p>
    </main>
  );
}
