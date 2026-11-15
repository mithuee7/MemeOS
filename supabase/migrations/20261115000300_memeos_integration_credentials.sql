-- Encrypted third-party credentials entered from Settings (applied as "memeos_integration_credentials").
-- Ciphertext is AES-GCM encrypted by the Worker with CREDENTIALS_KEY (a Worker secret).
CREATE TABLE integration_credentials (
  provider text PRIMARY KEY CHECK (provider IN ('apify', 'groq', 'meta')),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  last4 text NOT NULL,
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'ok', 'failed')),
  status_detail text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  tested_at timestamptz
);
ALTER TABLE integration_credentials ENABLE ROW LEVEL SECURITY;
