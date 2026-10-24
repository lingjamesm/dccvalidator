import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { signIn } from "@/lib/actions/auth";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="narrow">
      <h1>Sign in</h1>
      <div className="card">
        <AuthForm
          action={signIn}
          submitLabel="Continue"
          next={next}
          fields={[
            { name: "email", label: "Email", type: "email", autoComplete: "email" },
            { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
          ]}
        />
      </div>
      <p className="muted">
        New here? <Link href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}>Register</Link>
      </p>
    </main>
  );
}
