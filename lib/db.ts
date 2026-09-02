import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let db: SupabaseClient | null = null;

/**
 * Server-only Supabase client using the service-role key, which bypasses RLS.
 * Never import this from a "use client" file.
 */
export function getDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  db ??= createClient(url, key, { auth: { persistSession: false } });
  return db;
}
