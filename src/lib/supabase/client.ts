import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {isShowcase} from '@/lib/showcase';
let client: SupabaseClient | undefined;
export function createSupabaseBrowserClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Faltan las variables públicas de Supabase.');
  client ??= createClient(url, key, isShowcase ? {auth:{storageKey:'sb-aj-showcase-auth-token'}} : undefined);
  return client;
}
