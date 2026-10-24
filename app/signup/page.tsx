import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { signUp } from "@/lib/actions/auth";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="narrow">
      <h1>Register</h1>
      <p className="lead">
        Each representative registers individually. You will confirm your email, then set up Google
        Authenticator.
      </p>
      <div className="card">
        <AuthForm
          action={signUp}
          submitLabel="Create account"
          next={next}
          fields={[
            { name: "full_name", label: "Full name", type: "text", autoComplete: "name" },
            { name: "company", label: "Company", type: "text", autoComplete: "organization" },
            { name: "email", label: "Work email", type: "email", autoComplete: "email" },
            { name: "password", label: "Password (at least 12 characters)", type: "password", autoComplete: "new-password" },
          ]}
        />
      </div>
      <p className="muted">
        Already registered? <Link href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}>Sign in</Link>
      </p>
    </main>
  );
}
