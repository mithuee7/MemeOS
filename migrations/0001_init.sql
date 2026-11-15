-- MemeOS core schema (v1). Media lives in R2; D1 holds metadata only.

CREATE TABLE instagram_accounts (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  discovery_enabled INTEGER NOT NULL DEFAULT 1,
  posts_per_day INTEGER NOT NULL DEFAULT 3,
  audio_fallback TEXT NOT NULL DEFAULT 'publish_without_music'
    CHECK (audio_fallback IN ('publish_without_music', 'hold_for_review')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Parent -> child inheritance. Cycle prevention is enforced in the service layer.
CREATE TABLE account_parents (
  child_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  parent_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (child_id, parent_id),
  CHECK (child_id <> parent_id)
);

-- Reference (source) accounts, scraped once globally per cycle.
CREATE TABLE reference_accounts (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scraped_at TEXT,
  last_error TEXT
);

-- Per-account reference assignments (an account may use a source directly).
CREATE TABLE account_reference_assignments (
  account_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  reference_id INTEGER NOT NULL REFERENCES reference_accounts(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, reference_id)
);

CREATE TABLE source_posts (
  id INTEGER PRIMARY KEY,
  reference_id INTEGER NOT NULL REFERENCES reference_accounts(id),
  provider_post_id TEXT NOT NULL,
  permalink TEXT NOT NULL,
  post_type TEXT CHECK (post_type IN ('photo', 'reel', 'carousel', 'other', 'unknown')),
  caption TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider_post_id),
  UNIQUE (permalink)
);

-- Original audio metadata, stored once per source post and reused by all accounts.
CREATE TABLE source_audio (
  source_post_id INTEGER PRIMARY KEY REFERENCES source_posts(id) ON DELETE CASCADE,
  track_title TEXT,
  artist_name TEXT,
  provider_audio_id TEXT,
  is_original_audio INTEGER,
  match_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (match_status IN ('unknown', 'unsupported', 'unavailable', 'matched'))
);

-- Central meme library: one row per meme, shared across accounts.
CREATE TABLE memes (
  id INTEGER PRIMARY KEY,
  source_post_id INTEGER REFERENCES source_posts(id),
  origin TEXT NOT NULL CHECK (origin IN ('discovered', 'custom')),
  original_text TEXT,
  extracted_text TEXT,
  classification TEXT CHECK (classification IN ('suitable', 'unsuitable', 'review')),
  png_key TEXT,
  mp4_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Account-specific assignment and approval/publish state, independent per account.
CREATE TABLE meme_assignments (
  id INTEGER PRIMARY KEY,
  meme_id INTEGER NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  inherited_from_account_id INTEGER REFERENCES instagram_accounts(id),
  media_type TEXT NOT NULL DEFAULT 'photo' CHECK (media_type IN ('photo', 'reel')),
  approval_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  audio_status TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (audio_status IN ('not_applicable', 'unknown', 'unsupported', 'unavailable', 'matched', 'attached')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (meme_id, account_id)
);

CREATE TABLE publishing_schedule (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL UNIQUE REFERENCES meme_assignments(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'publishing', 'published', 'failed'))
);

-- Persistent job state for the automation engine.
CREATE TABLE automation_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'paused')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE global_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO global_settings (key, value) VALUES ('paused', 'false');

CREATE TABLE system_logs (
  id INTEGER PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  workflow TEXT NOT NULL,
  account_id INTEGER REFERENCES instagram_accounts(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_source_posts_reference ON source_posts(reference_id);
CREATE INDEX idx_memes_source ON memes(source_post_id);
CREATE INDEX idx_assignments_account_status ON meme_assignments(account_id, approval_status);
CREATE INDEX idx_jobs_due ON automation_jobs(status, next_run_at);
CREATE INDEX idx_logs_created ON system_logs(created_at);
