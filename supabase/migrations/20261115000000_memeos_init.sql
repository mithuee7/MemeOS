-- MemeOS core schema (Supabase / PostgreSQL).
-- Applied to project voaglopdlyvsohlaefxz on 2026-11-15 as migration "memeos_init".

CREATE TABLE instagram_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  discovery_enabled boolean NOT NULL DEFAULT true,
  posts_per_day int NOT NULL DEFAULT 3 CHECK (posts_per_day BETWEEN 0 AND 10),
  audio_fallback text NOT NULL DEFAULT 'publish_without_music'
    CHECK (audio_fallback IN ('publish_without_music', 'hold_for_review')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_parents (
  child_id bigint NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  parent_id bigint NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (child_id, parent_id),
  CHECK (child_id <> parent_id)
);

CREATE TABLE reference_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  last_scraped_at timestamptz,
  last_error text
);

CREATE TABLE account_reference_assignments (
  account_id bigint NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  reference_id bigint NOT NULL REFERENCES reference_accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (account_id, reference_id)
);

CREATE TABLE source_posts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference_id bigint NOT NULL REFERENCES reference_accounts(id),
  provider_post_id text NOT NULL UNIQUE,
  permalink text NOT NULL UNIQUE,
  post_type text CHECK (post_type IN ('photo', 'reel', 'carousel', 'other', 'unknown')),
  caption text,
  discovered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_audio (
  source_post_id bigint PRIMARY KEY REFERENCES source_posts(id) ON DELETE CASCADE,
  track_title text,
  artist_name text,
  provider_audio_id text,
  is_original_audio boolean,
  match_status text NOT NULL DEFAULT 'unknown'
    CHECK (match_status IN ('unknown', 'unsupported', 'unavailable', 'matched'))
);

CREATE TABLE memes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_post_id bigint REFERENCES source_posts(id),
  origin text NOT NULL CHECK (origin IN ('discovered', 'custom')),
  original_text text,
  extracted_text text,
  classification text CHECK (classification IN ('suitable', 'unsuitable', 'review')),
  png_path text,
  mp4_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meme_assignments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meme_id bigint NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  inherited_from_account_id bigint REFERENCES instagram_accounts(id),
  media_type text NOT NULL DEFAULT 'photo' CHECK (media_type IN ('photo', 'reel')),
  approval_status text NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  audio_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (audio_status IN ('not_applicable', 'unknown', 'unsupported', 'unavailable', 'matched', 'attached')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meme_id, account_id)
);

CREATE TABLE publishing_schedule (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id bigint NOT NULL UNIQUE REFERENCES meme_assignments(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'publishing', 'published', 'failed'))
);

CREATE TABLE automation_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'paused')),
  attempts int NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE global_settings (
  key text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO global_settings (key, value) VALUES ('paused', 'false');

CREATE TABLE system_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  workflow text NOT NULL,
  account_id bigint REFERENCES instagram_accounts(id) ON DELETE SET NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_posts_reference ON source_posts(reference_id);
CREATE INDEX idx_memes_source ON memes(source_post_id);
CREATE INDEX idx_assignments_account_status ON meme_assignments(account_id, approval_status);
CREATE INDEX idx_jobs_due ON automation_jobs(status, next_run_at);
CREATE INDEX idx_logs_created ON system_logs(created_at);

-- Cycle prevention: true if child_id is already an ancestor of parent_id.
CREATE OR REPLACE FUNCTION would_create_cycle(child_id bigint, parent_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH RECURSIVE ancestors(id) AS (
    SELECT ap.parent_id FROM account_parents ap WHERE ap.child_id = would_create_cycle.parent_id
    UNION
    SELECT ap.parent_id FROM account_parents ap JOIN ancestors a ON ap.child_id = a.id
  )
  SELECT would_create_cycle.child_id = would_create_cycle.parent_id
      OR EXISTS (SELECT 1 FROM ancestors WHERE id = would_create_cycle.child_id);
$$;

-- Row Level Security: enabled on every table with no anon/authenticated policies.
-- The Worker uses the service-role key (bypasses RLS). The browser never queries
-- tables directly; it talks to the Worker API.
ALTER TABLE instagram_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_reference_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_audio ENABLE ROW LEVEL SECURITY;
ALTER TABLE memes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meme_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE publishing_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- Private storage bucket for generated PNG/MP4 assets. No public read.
INSERT INTO storage.buckets (id, name, public)
VALUES ('memeos-media', 'memeos-media', false)
ON CONFLICT (id) DO NOTHING;
