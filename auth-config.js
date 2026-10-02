// FieldInspect Pro authentication configuration
//
// This is client-side configuration. Supabase publishable keys are intended
// to be exposed in browser/desktop applications. NEVER put a Supabase secret
// or service_role key here.
//
// If a deployment/build system provides these values on window.FIELDINSPECT_ENV,
// they take precedence. Otherwise the production publishable configuration
// below is used directly.
(function () {
  const env = window.FIELDINSPECT_ENV || {};

  window.FIELDINSPECT_AUTH = {
    SUPABASE_URL: env.SUPABASE_URL || "https://aynlfxquofvlnthxuqcl.supabase.co",
    SUPABASE_PUBLISHABLE_KEY:
      env.SUPABASE_PUBLISHABLE_KEY ||
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      "sb_publishable_N2gR3sQb0PE18MsEN0Htbg_qn6fQooJ",
    AUTH_REDIRECT_URL:
      env.AUTH_REDIRECT_URL ||
      "https://radiant-granita-8f2db2.netlify.app/",
    SUPABASE_FUNCTIONS_URL:
      env.SUPABASE_FUNCTIONS_URL ||
      env.VITE_SUPABASE_FUNCTIONS_URL ||
      "https://aynlfxquofvlnthxuqcl.supabase.co/functions/v1"
  };
})();
