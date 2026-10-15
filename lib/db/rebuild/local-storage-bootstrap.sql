-- Test-only minimal Supabase Storage surface for policy simulation.
-- This is not the Storage service/API and must never be applied to Supabase.
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL REFERENCES storage.buckets(id),
  name text NOT NULL,
  owner_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bucket_id,name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
GRANT SELECT,INSERT,DELETE ON storage.objects TO anon,authenticated,service_role;
