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

async function getAccessToken() {
  const consumerKey = Deno.env.get("MPESA_CONSUMER_KEY");
  const consumerSecret = Deno.env.get("MPESA_CONSUMER_SECRET");

  if (!consumerKey || !consumerSecret) {
    throw new Error("MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET is not configured");
  }

  const basic = btoa(unescape(encodeURIComponent(`${consumerKey}:${consumerSecret}`)));
  const response = await fetch(`${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.errorMessage || "Unable to obtain M-Pesa access token");
  }

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

  if (!supabaseUrl || !anonKey) {
    return json({ error: "Supabase function configuration is incomplete" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Authentication required" }, 401);
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return json({ error: "Invalid or expired session" }, 401);

  const body = await req.json().catch(() => null);
  const planKey = body?.plan;
  const phone = normalizeKenyanPhone(body?.phone);

  if (!PLANS[planKey]) return json({ error: "Unsupported paid plan" }, 400);
  if (!phone) return json({ error: "Enter a valid Kenyan M-Pesa phone number" }, 400);

  const plan = PLANS[planKey];
  const shortcode = Deno.env.get("MPESA_SHORTCODE");
  const passkey = Deno.env.get("MPESA_PASSKEY");
  const callbackUrl = Deno.env.get("MPESA_CALLBACK_URL");

  if (!shortcode || !passkey || !callbackUrl) {
    return json({ error: "M-Pesa server configuration is incomplete" }, 500);
  }

  const accessToken = await getAccessToken();
  const ts = timestamp();
  const password = btoa(`${shortcode}${passkey}${ts}`);

  const stkResponse = await fetch(`${darajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: "CustomerPayBillOnline",
      Amount: plan.amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: `FIELDINSPECT-${planKey.toUpperCase()}`,
      TransactionDesc: `FieldInspect Pro ${plan.name} subscription`,
    }),
  });

  const stk = await stkResponse.json();
  if (!stkResponse.ok || stk.ResponseCode !== "0") {
    return json({
      error: stk.errorMessage || stk.ResponseDescription || "M-Pesa STK Push could not be started",
      provider: stk,
    }, 502);
  }

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    return json({ error: "Supabase service role key is not configured" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: subscription } = await admin
    .from("subscriptions")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: payment, error: paymentError } = await admin
    .from("payments")
    .insert({
      user_id: user.id,
      subscription_id: subscription?.id ?? null,
      plan: planKey,
      amount: plan.amount,
      currency: "KES",
      provider: "mpesa",
      status: "PENDING",
      phone_number: phone,
      merchant_request_id: stk.MerchantRequestID,
      checkout_request_id: stk.CheckoutRequestID,
    })
    .select("id, status, checkout_request_id")
    .single();

  if (paymentError) {
    return json({ error: "Payment started but could not be recorded", checkoutRequestId: stk.CheckoutRequestID }, 500);
  }

  return json({
    ok: true,
    paymentId: payment.id,
    status: "PENDING",
    message: "M-Pesa payment prompt sent to your phone.",
    checkoutRequestId: stk.CheckoutRequestID,
  });
});
