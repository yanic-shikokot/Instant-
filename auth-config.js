// FieldInspect Pro authentication configuration
// The Supabase anon/public key is safe to expose in browser code.
// NEVER put a Supabase service_role key, M-Pesa secret, or other server secret here.
window.FIELDINSPECT_AUTH = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  // Optional: set this to your deployed app URL for email confirmation/password reset.
  // Example: "https://your-site.netlify.app/"
  AUTH_REDIRECT_URL: ""
};
