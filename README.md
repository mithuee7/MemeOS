# MemeOS

Automated Instagram meme discovery, BRAT-style generation, approval and publishing platform.

## Status

This repository currently contains the **foundation only**:

- Cloudflare Worker entry point with `/api/health` and `/api/accounts`.
- D1 schema (`migrations/0001_init.sql`) covering accounts, parent inheritance, reference
  sources, global post dedup, the central meme library, per-account assignments, audio
  metadata/match status, schedules, persistent jobs, settings and logs.
- Parent-cycle prevention (`wouldCreateCycle`).

Not yet implemented: Apify discovery, OCR/classification, BRAT generation (PNG/MP4),
Meta publishing, Meta audio matching, the approval UI, analytics, Groq/usage monitoring,
and the React frontend.

## Setup

1. `npm install`
2. Create the D1 database and put its id in `wrangler.toml`:
   `npx wrangler d1 create memeos`
3. Create the R2 bucket: `npx wrangler r2 bucket create memeos-media`
4. Apply migrations: `npm run db:migrate:local` (or `:remote`)
5. `npm run dev`

Secrets (Apify token, Groq keys, Meta app credentials) must be set with
`wrangler secret put <NAME>`. They are never committed.

## Known constraints

- Meta's Instagram Audio API must be verified against current official docs before the
  audio-attachment step is built. Unsupported parts will be marked `unsupported` in
  `meme_assignments.audio_status`, not faked.
