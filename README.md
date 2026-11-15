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
- Worker with `GET /api/health` and `GET /api/accounts`. Both use the Supabase REST API with the service-role key.
- Parent-cycle prevention via the Postgres function `would_create_cycle` (tested against the live
  database: self-loops and two-node cycles are blocked, valid edges are allowed).

Applied to Supabase:
- Migration `supabase/migrations/20261115000000_memeos_init.sql` (applied as `memeos_init`).
- 12 tables with RLS enabled. Advisors report no security errors; the only lints are informational
  "RLS enabled, no policy" notices, which is intended because only the backend should access data.
- Private storage bucket `memeos-media`.

Not verified:
- The Worker's HTTP calls to Supabase were not tested end to end. The build sandbox's network
  policy blocks `*.supabase.co` and `workers.cloudflare.com`, so `wrangler dev` could not reach
  the database and `wrangler deploy` could not run from there. Run the checks below yourself.

Not yet implemented: the React frontend, Supabase Auth, Apify discovery, OCR/classification,
BRAT generation (PNG/MP4), Meta publishing, Meta audio matching, the approval queue,
analytics, Groq and usage monitoring, and the automation job runner (`scheduled` is a stub).

## Setup

1. `npm install`
2. Apply the schema. Either link the Supabase CLI to the project and run `npm run db:push`,
   or run the SQL file in the Supabase SQL editor.
3. Local development: copy `.dev.vars.example` to `.dev.vars` and set
   `SUPABASE_SERVICE_ROLE_KEY` (from Supabase dashboard → Project Settings → API). Then `npm run dev`.
4. Production secrets, never committed:
   ```
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   ```
5. Deploy: `npm run deploy`

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
