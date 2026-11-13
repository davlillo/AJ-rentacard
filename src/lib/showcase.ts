// The local showcase must never be enabled against the real workspace by a flag alone.
export const isShowcase=process.env.NEXT_PUBLIC_SHOWCASE==='true'&&
  process.env.NEXT_PUBLIC_SUPABASE_URL==='http://127.0.0.1:56321';
