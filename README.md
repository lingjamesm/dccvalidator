# DCC Validator

A web app where DCC submitters register with two-factor authentication, upload their Dynamic Currency Conversion screens and receipts into a private workspace, and (in later phases) get a scored check against Visa and Mastercard rules.

## What is built so far (phase 1: secure foundation)

- Registration with email confirmation, then mandatory Google Authenticator 2FA before anything else is reachable.
- A private workspace that logs every submission over time, newest first. A resubmission is saved as a new version of the same entry.
- Uploads of PNG, JPG and PDF files (up to 20 MB each) into a private storage folder per user.
- Database rules that keep each user's data separate, with sharing built in at the database level. Owners can share one submission or their whole workspace, read-only and revocable. The sharing screens and invite emails come in a later phase.
- Automated tests that prove one user cannot read or change another user's data (`tests/rls`). They run on every change.

Coming next: card number (PAN) masking, the rule library and AI validation with scoring, sharing screens and invite emails, paid ordering through Stripe, and Word and PowerPoint training packs.

## How it fits together

| Part | Service | Folder |
| --- | --- | --- |
| Website | Vercel (Next.js) | `app/`, `components/`, `lib/` |
| Login, 2FA, database, file storage | Supabase | `supabase/migrations/` |
| Isolation tests | GitHub Actions + Postgres | `tests/rls/` |

## Setting it up (one time)

You do these steps once, in the browser. Nothing needs installing on your computer.

### 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) with GitHub and click **New project**.
2. Name it `dccvalidator`, choose a strong database password and keep it safe, pick the region where data should live, and click **Create new project**. It takes about two minutes.

### 2. Set up the database

1. In Supabase, click **Connect** at the top of the project. Under **Session pooler**, copy the connection string, then replace `[YOUR-PASSWORD]` in it with your database password.
2. In GitHub, open this repository and go to **Settings → Secrets and variables → Actions → New repository secret**. Name it `SUPABASE_DB_URL`, paste the connection string as the value, and save.
3. Go to the **Actions** tab, choose **Apply database changes**, click **Run workflow**, and wait for the green tick.

From then on, database changes apply automatically whenever they reach `main`.

### 3. Deploy the website on Vercel

1. Sign in at [vercel.com](https://vercel.com) with GitHub, click **Add New → Project**, and import `dccvalidator`.
2. Before clicking Deploy, open **Environment Variables** and add these two. Find both in Supabase under **Project Settings → API Keys**, or on the **Connect** screen.
   - `NEXT_PUBLIC_SUPABASE_URL`: the project URL, like `https://abcd1234.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the `anon` (or publishable) key
3. Click **Deploy**. When it finishes, copy the site address, like `https://dccvalidator.vercel.app`.

### 4. Point Supabase sign-in at the website

In Supabase, go to **Authentication → URL Configuration**:

- **Site URL**: your Vercel address
- **Redirect URLs**: add `https://<your Vercel address>/auth/confirm`

Under **Authentication → Sign In / Providers → Email**, make sure **Confirm email** is on. TOTP multi-factor authentication (used by Google Authenticator) is on by default.

### 5. Try it

Open the Vercel address, register, confirm your email, and scan the QR code with Google Authenticator.

Supabase's built-in email sender only allows a few emails an hour, which is fine for testing. A proper email service will be added with the sharing invites.

## Looking after users

- **Lost phone / reset 2FA:** in Supabase **Authentication → Users**, open the user and delete their MFA factor after checking their identity. They will be asked to set up Google Authenticator again at their next sign-in.
- **Audit trail:** every submission, upload and share is recorded in the `audit_log` table. Only you can see it, in the Supabase Table Editor.

## For developers

```bash
npm install
cp .env.example .env.local   # fill in the Supabase URL and anon key
npm run dev
npm run typecheck
npm run test:rls             # needs Postgres server binaries, or TEST_DATABASE_URL
```

The isolation tests run the real migrations against plain Postgres with a small stand-in for Supabase's `auth` and `storage` schemas (`tests/rls/supabase_stub.sql`).
