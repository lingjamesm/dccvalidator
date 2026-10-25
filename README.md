# DCC Validator

A web app where DCC submitters register with two-factor authentication, upload their Dynamic Currency Conversion screens and receipts into a private workspace, and (in later phases) get a scored check against Visa and Mastercard rules.

## What is built so far (phase 1: secure foundation)

- Registration with email confirmation, then mandatory Google Authenticator 2FA before anything else is reachable.
- A private workspace that logs every submission over time, newest first. A resubmission is saved as a new version of the same entry.
- Uploads of PNG, JPG and PDF files (up to 20 MB each) into a private storage folder per user.
- Database rules that keep each user's data separate, with sharing built in at the database level. Owners can share one submission or their whole workspace, read-only and revocable. The sharing screens and invite emails come in a later phase.
- Automated tests that prove one user cannot read or change another user's data (`tests/rls`). They run on every change.

Phase 2 adds card number masking: uploads go to a locked quarantine area, a worker finds card numbers with OCR and the Luhn check, blacks out all but the last four digits, stores the masked copy and deletes the original. Only masked files can ever be downloaded.

Phase 3 adds validation. Once a submission's files are masked, the worker asks Claude (model `claude-opus-5-5`, with server-side refusal fallbacks turned on) to classify each file and answer a fixed list of questions about it, quoting what it sees. The published rule set then decides pass, fail or needs review for every rule, scores each scheme, and writes a PDF report. Admins keep the rule library under **Rule library** in the site header: rules are edited in a draft and published as a new version, and every result records the version it was checked against.

Scoring, per scheme: score = 100 × weight of passed rules ÷ weight of applicable rules. Any failed critical rule makes the scheme **Not compliant**; all rules passing is **Compliant**; anything else is **Needs review**.

Coming next: sharing screens and invite emails, paid ordering through Stripe, and Word and PowerPoint training packs.

## How it fits together

| Part | Service | Folder |
| --- | --- | --- |
| Website | Vercel (Next.js) | `app/`, `components/`, `lib/` |
| Login, 2FA, database, file storage | Supabase | `supabase/migrations/` |
| Card number masking worker | Render (Python, Tesseract OCR) | `worker/`, `render.yaml` |
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

If the run fails with "password authentication failed", the password in the secret doesn't match. Alternatively, open the migration file in `supabase/migrations/` on GitHub, click **Copy raw file**, paste it into Supabase's **SQL Editor**, and click **Run**. Phase 1 was set up this way.

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

### 6. Card number masking (phase 2)

1. **Database update.** Open `supabase/migrations/20261025000000_pan_masking.sql` on GitHub, click **Copy raw file**, paste it into Supabase's **SQL Editor**, and click **Run**.
2. **Worker.** In [Render](https://dashboard.render.com), click **New → Blueprint**, connect the `dccvalidator` repository, and click **Apply**. When asked for `SUPABASE_SERVICE_ROLE_KEY`, paste the **secret** key (or legacy `service_role` key) from Supabase **Project Settings → API Keys**. This key bypasses all privacy rules: only ever paste it into Render, never anywhere else. The worker runs on Render's Starter plan (about 7 USD a month).
3. When Render shows the worker as **Live**, upload a screen in the app. Within a few seconds the file shows how many card numbers were masked.

### 7. Validation and the rule library (phase 3)

1. **Database update.** Paste `supabase/migrations/20261026000000_rules_validation.sql` into the Supabase **SQL Editor** and click **Run**, as before. It adds the rule library with starter rules for Visa and Mastercard, all marked as not yet verified.
2. **Make yourself an admin.** In the SQL Editor, run (with your own email):
   `update public.profiles set role = 'admin' where email = 'you@example.com';`
   Sign out and in again; **Rule library** appears in the header.
3. **API key.** In Render, open the worker's **Environment** and add `ANTHROPIC_API_KEY`. Without it the worker still masks files but does not validate them.
4. Review each rule under **Rule library**, tick **Verified** once checked against the official document, and publish. Until every rule used is verified, results and reports say they are indicative.

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
