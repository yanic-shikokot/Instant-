import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLANS: Record<string, { amount: number; name: string; days: number }> = {
  professional: { amount: 1500, name: "Professional", days: 30 },
  business: { amount: 4000, name: "Business", days: 30 },
};

const SANDBOX_TEST_PHONES = new Set(["254708374149"]);
const REQUEST_TIMEOUT_MS = 15000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeKenyanPhone(input: string) {
  const raw = String(input || "").replace(/\s|-/g, "");
  if (/^07\d{8}$/.test(raw)) return "254" + raw.slice(1);
  if (/^01\d{8}$/.test(raw)) return "254" + raw.slice(1);
  if (/^254[17]\d{8}$/.test(raw)) return raw;
  if (/^\+254[17]\d{8}$/.test(raw)) return raw.slice(1);
  return null;
}

function darajaBaseUrl() {
  return Deno.env.get("MPESA_ENV") === "live"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("M-Pesa provider request timed out. Please try again.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  const consumerKey = Deno.env.get("MPESA_CONSUMER_KEY");
  const consumerSecret = Deno.env.get("MPESA_CONSUMER_SECRET");
  if (!consumerKey || !consumerSecret) throw new Error("MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET is not configured");

  const basic = btoa(unescape(encodeURIComponent(`${consumerKey}:${consumerSecret}`)));
  const response = await fetchWithTimeout(
    `${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${basic}` } }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.errorMessage || data.error_description || "Unable to obtain M-Pesa access token");
  return data.access_token as string;
}

function timestamp() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    if (!supabaseUrl || !anonKey) return json({ error: "Supabase function configuration is incomplete" }, 500);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

    const supabase = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return json({ error: "Invalid or expired session" }, 401);

    const body = await req.json().catch(() => null);
    const planKey = body?.plan;
    const phone = normalizeKenyanPhone(body?.phone);
    if (!PLANS[planKey]) return json({ error: "Unsupported paid plan" }, 400);
    if (!phone) return json({ error: "Enter a valid Kenyan M-Pesa phone number" }, 400);

    const environment = Deno.env.get("MPESA_ENV") || "sandbox";
    const liveEnabled = Deno.env.get("MPESA_LIVE_ENABLED") === "true";
    if (environment === "live" && !liveEnabled) return json({ error: "Live M-Pesa payments are disabled until production billing is explicitly enabled." }, 503);
    if (environment !== "live" && !SANDBOX_TEST_PHONES.has(phone)) {
      return json({ error: "Sandbox safety lock: use the documented Daraja sandbox test number or enable live only after Safaricom Go Live." }, 400);
    }

    const plan = PLANS[planKey];
    const shortcode = Deno.env.get("MPESA_SHORTCODE");
    const passkey = Deno.env.get("MPESA_PASSKEY");
    const callbackUrl = Deno.env.get("MPESA_CALLBACK_URL") || "https://aynlfxquofvlnthxuqcl.supabase.co/functions/v1/mpesa-callback";
    if (!shortcode || !passkey) return json({ error: "M-Pesa server configuration is incomplete" }, 500);

    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const secretKey = secretKeys.default;
    if (!secretKey) return json({ error: "Supabase server secret key is not configured" }, 500);
    const admin = createClient(supabaseUrl, secretKey);

    const { data: payment, error: paymentError } = await admin.from("payments").insert({
      user_id: user.id, plan: planKey, amount: plan.amount, currency: "KES", provider: "mpesa", status: "PENDING", phone_number: phone,
    }).select("id, status").single();

    if (paymentError || !payment) {
      console.error("payment_insert_failed", paymentError);
      return json({ error: "Could not create the payment record. Please try again." }, 500);
    }

    try {
      const accessToken = await getAccessToken();
      const ts = timestamp();
      const password = btoa(`${shortcode}${passkey}${ts}`);
      const stkResponse = await fetchWithTimeout(`${darajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: shortcode, Password: password, Timestamp: ts, TransactionType: "CustomerPayBillOnline",
          Amount: plan.amount, PartyA: phone, PartyB: shortcode, PhoneNumber: phone, CallBackURL: callbackUrl,
          AccountReference: `FIELDINSPECT-${planKey.toUpperCase()}`, TransactionDesc: `FieldInspect Pro ${plan.name} subscription`,
        }),
      });

      const stk = await stkResponse.json().catch(() => ({}));
      if (!stkResponse.ok || stk.ResponseCode !== "0") {
        await admin.from("payments").update({
          status: "FAILED", result_code: stk.ResponseCode ? Number(stk.ResponseCode) : null,
          result_description: stk.errorMessage || stk.ResponseDescription || "M-Pesa STK Push could not be started",
          raw_callback: { stage: "stk_request", provider: stk }, completed_at: new Date().toISOString(),
        }).eq("id", payment.id);
        return json({ error: stk.errorMessage || stk.ResponseDescription || "M-Pesa STK Push could not be started", paymentId: payment.id }, 502);
      }

      const { error: updateError } = await admin.from("payments").update({
        merchant_request_id: stk.MerchantRequestID, checkout_request_id: stk.CheckoutRequestID,
      }).eq("id", payment.id);

      if (updateError) {
        console.error("payment_checkout_update_failed", updateError);
        return json({ error: "M-Pesa accepted the request, but FieldInspect could not save the checkout reference. Do not retry repeatedly; check payment status.", paymentId: payment.id }, 500);
      }

      return json({ ok: true, paymentId: payment.id, status: "PENDING", message: "M-Pesa payment prompt sent to your phone.", checkoutRequestId: stk.CheckoutRequestID });
    } catch (error) {
      console.error("mpesa_stk_push_failed", error);
      await admin.from("payments").update({ status: "FAILED", result_description: error?.message || "M-Pesa request failed", completed_at: new Date().toISOString() }).eq("id", payment.id);
      return json({ error: error?.message || "Unable to start the M-Pesa payment request.", paymentId: payment.id }, 502);
    }
  } catch (error) {
    console.error("mpesa_function_failed", error);
    return json({ error: error?.message || "Unexpected M-Pesa billing error." }, 500);
  }
});