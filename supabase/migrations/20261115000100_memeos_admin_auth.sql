-- Admin allow-list (applied to project voaglopdlyvsohlaefxz as "memeos_admin_auth").
-- Only the Worker's service-role key reads or writes this table. Membership is
-- granted by hand in SQL, never through the API. No policies are created, so the
-- anon and authenticated roles have no access.

CREATE TABLE admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
