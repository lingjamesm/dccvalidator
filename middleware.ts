import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/", "/login", "/signup", "/check-email"];
const isPublic = (path: string) => PUBLIC_PATHS.includes(path) || path.startsWith("/auth/");

// Every request refreshes the Supabase session, then sends the user where they
// need to be: signed out -> login, no authenticator yet -> 2FA setup,
// authenticator not yet entered this session -> 2FA code.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const path = request.nextUrl.pathname;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const redirect = (to: string, keepNext = false) => {
    const url = request.nextUrl.clone();
    url.pathname = to;
    url.search = "";
    if (keepNext && path !== "/") url.searchParams.set("next", path + request.nextUrl.search);
    const res = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => res.cookies.set(c));
    return res;
  };

  if (!user) {
    return isPublic(path) ? response : redirect("/login", true);
  }

  if (path.startsWith("/auth/")) return response;

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const needsSetup = aal?.nextLevel !== "aal2";
  const needsCode = !needsSetup && aal?.currentLevel !== "aal2";

  if (needsSetup) return path === "/mfa/setup" ? response : redirect("/mfa/setup");
  if (needsCode) return path === "/mfa/verify" ? response : redirect("/mfa/verify", true);

  if (path.startsWith("/mfa/") || path === "/login" || path === "/signup") {
    return redirect("/workspace");
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|ico)$).*)"],
};
