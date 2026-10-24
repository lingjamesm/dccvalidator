import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "DCC Validator",
  description: "Check DCC screens and receipts against Visa and Mastercard rules.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <html lang="en">
      <body>
        <header className="site">
          <Link href={user ? "/workspace" : "/"} className="brand">
            DCC Validator
          </Link>
          <nav>
            {user ? (
              <>
                <span className="muted">{user.email}</span>
                <form action="/auth/signout" method="post">
                  <button type="submit" className="link">
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <>
                <Link href="/login">Sign in</Link>
                <Link href="/signup" className="button">
                  Register
                </Link>
              </>
            )}
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
