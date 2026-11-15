# MemeOS

Automated Instagram meme discovery, BRAT-style generation, approval and publishing platform.

## Architecture

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript (not yet built) |
| Backend / hosting | Cloudflare Workers (TypeScript) |
| Database | Supabase PostgreSQL (`voaglopdlyvsohlaefxz`, ap-southeast-1) |
| Media storage | Supabase Storage, private bucket `memeos-media` |
| Auth | Supabase Auth (not yet wired) |
| Access control | Row Level Security enabled on every table; no anon policies |
| Source discovery | Apify (not yet integrated) |
| Text processing | Groq (not yet integrated) |
| Publishing | Meta Instagram Graph API (not yet integrated) |

Cloudflare D1 and R2 are not used.

## Current status

Working in code:
- Supabase Auth verification of bearer tokens, with an admin allow-list (`admin_users`).
  Unauthenticated requests get 401, non-admins get 403. Tested.
- Account API: `GET/POST /api/accounts`, `POST /api/accounts/:id/parents`,
  `DELETE /api/accounts/:id/parents/:parentId`. All writes are admin-only and validated.
- Parent-cycle prevention via the Postgres function `would_create_cycle`, checked before insert.
- Public `GET /api/health`. Errors never expose secrets or upstream details.
- Test suite: `npm test` (28 tests) runs the real Worker code against a fake Supabase.
  The tests cover auth, admin checks, validation, duplicates, cycle blocking and secret leakage.

Applied to Supabase:
- Migration `supabase/migrations/20261115000000_memeos_init.sql` (applied as `memeos_init`).
- Migration `supabase/migrations/20261115000100_memeos_admin_auth.sql` (applied as `memeos_admin_auth`).
- 13 tables with RLS enabled (12 core + `admin_users`). Advisors report no security errors; the only lints are informational
  "RLS enabled, no policy" notices, which is intended because only the backend should access data.
- Private storage bucket `memeos-media`.

Not verified:
- The Worker's HTTP calls to Supabase were not tested end to end. The build sandbox's network
  policy blocks `*.supabase.co` and `workers.cloudflare.com`, so `wrangler dev` could not reach
  the database and `wrangler deploy` could not run from there. Run the checks below yourself.

Not yet implemented: the Discovery, Approval, Library, Creator, Scheduler, Publishing, Analytics, Automation, System Health and Settings pages; parent-account UI; Apify discovery, OCR/classification,
BRAT generation (PNG/MP4), Meta publishing, Meta audio matching, the approval queue,
analytics, Groq and usage monitoring, and the automation job runner (`scheduled` is a stub).

## Website

The React app lives in `web/` (Vite). `npm run build` writes it to `dist/`, and the Worker
serves it at the root URL. Every other path under `/api` is the JSON API.

Pages: sign in, sign up, password reset, dashboard overview (accounts count, other counts show
"not connected" until those features exist), and an Accounts page that adds and lists accounts
through the admin-protected API. Other navigation items are marked "Soon".

## Setup

1. `npm install`
2. Apply the schema. Either link the Supabase CLI to the project and run `npm run db:push`,
   or run the SQL file in the Supabase SQL editor.
3. Local development: copy `.dev.vars.example` to `.dev.vars` and set
   `SUPABASE_SERVICE_ROLE_KEY` (from Supabase dashboard → Project Settings → API). Then `npm run dev`.
4. Grant yourself admin (run once in the Supabase SQL editor, using your own auth user id):
   `insert into admin_users (user_id) values ('<your-auth-user-uuid>');`
5. Production secrets, never committed:
   ```
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   ```
6. Deploy: `npm run deploy` (builds the website, then deploys the Worker with it).
   Live URL: https://memeos.mithbuilds.workers.dev

## One-time encryption key

Connections entered in Settings are encrypted with a key that exists only as a Worker secret:

```
openssl rand -base64 32                  # copy the output
npx wrangler secret put CREDENTIALS_KEY  # paste it when prompted
```

Keep a copy of that key somewhere safe. If it is lost, saved connections cannot be decrypted and must be re-entered.

## Security rules

- The service-role key is a Worker secret only. It must never appear in frontend code, logs or
  API responses. Errors return generic messages; details belong in `system_logs`.
- The browser never queries Supabase tables directly. It calls the Worker API, and the Worker uses
  the service-role key.
- Apify, Groq and Meta credentials are also Worker secrets.

## Verification checklist after deploy

- `GET /api/health` returns `{"ok":true,"paused":false}`.
- `GET /api/accounts` returns `{"accounts":[]}` on the empty database.
- A request with a wrong or missing key does not expose any data.

## Known constraints

- The Instagram Audio API must be checked against current official Meta documentation before the
  audio-attachment step is built. Unsupported parts will be marked `unsupported` in
  `meme_assignments.audio_status`, not faked.
