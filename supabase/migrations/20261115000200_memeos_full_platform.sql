-- Full platform schema (applied to project voaglopdlyvsohlaefxz as "memeos_full_platform").
-- All tables have RLS enabled and no client policies; only the Worker's service-role key uses them.

CREATE TABLE account_connections (
  account_id bigint PRIMARY KEY REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  ig_user_id text,
  facebook_page_id text,
  token_secret_ref text,
  token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'not_connected'
    CHECK (status IN ('not_connected', 'connected', 'expired', 'error')),
  last_verified_at timestamptz,
  last_error text
);

CREATE TABLE account_settings (
  account_id bigint PRIMARY KEY REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  post_times text[] NOT NULL DEFAULT ARRAY['09:00','13:00','18:30'],
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  format_preference text NOT NULL DEFAULT 'photo' CHECK (format_preference IN ('photo','reel','mixed')),
  auto_approve boolean NOT NULL DEFAULT false,
  max_publish_retries int NOT NULL DEFAULT 3 CHECK (max_publish_retries BETWEEN 0 AND 10),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reference_accounts ADD COLUMN last_post_count int NOT NULL DEFAULT 0;
ALTER TABLE reference_accounts ADD COLUMN discovery_interval_minutes int NOT NULL DEFAULT 360
  CHECK (discovery_interval_minutes BETWEEN 15 AND 10080);

CREATE TABLE discovery_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference_id bigint REFERENCES reference_accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','skipped')),
  new_posts int NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

ALTER TABLE memes ADD COLUMN status text NOT NULL DEFAULT 'extracted'
  CHECK (status IN ('discovered','extracted','rejected_unsuitable','needs_review','rendered','failed'));
ALTER TABLE memes ADD COLUMN failure_reason text;
ALTER TABLE memes ADD COLUMN ocr_confidence real;
ALTER TABLE memes ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE memes ADD COLUMN edited_text text;

CREATE TABLE publish_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id bigint NOT NULL REFERENCES meme_assignments(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','publishing','published','failed')),
  attempts int NOT NULL DEFAULT 0,
  media_container_id text,
  platform_media_id text,
  permalink text,
  error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  platform_media_id text,
  metric text NOT NULL,
  value numeric NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('groq','apify','meta','supabase','cloudflare')),
  metric text NOT NULL,
  amount numeric NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE groq_keys (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label text NOT NULL UNIQUE,
  secret_name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  cooldown_until timestamptz,
  last_status text,
  last_tested_at timestamptz
);

CREATE TABLE job_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint REFERENCES automation_jobs(id) ON DELETE CASCADE,
  attempt int NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded','failed')),
  error_class text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE publishing_schedule ADD COLUMN account_id bigint REFERENCES instagram_accounts(id) ON DELETE CASCADE;
ALTER TABLE publishing_schedule ADD COLUMN attempts int NOT NULL DEFAULT 0;
ALTER TABLE publishing_schedule ADD COLUMN last_error text;

CREATE TABLE audio_matches (
  assignment_id bigint PRIMARY KEY REFERENCES meme_assignments(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('unknown','unsupported','unavailable','matched','attached')),
  detail text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_assignments_status ON meme_assignments(approval_status, account_id);
CREATE INDEX idx_memes_status ON memes(status, created_at);
CREATE INDEX idx_publish_records_status ON publish_records(status);
CREATE INDEX idx_analytics_account_time ON analytics_snapshots(account_id, captured_at);
CREATE INDEX idx_discovery_runs_ref ON discovery_runs(reference_id, started_at);
CREATE INDEX idx_job_attempts_job ON job_attempts(job_id);

ALTER TABLE account_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE groq_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audio_matches ENABLE ROW LEVEL SECURITY;
