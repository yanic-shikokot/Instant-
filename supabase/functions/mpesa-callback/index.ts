import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
  const secretKey = secretKeys.default;

  if (!supabaseUrl || !secretKey) {
    return json({ error: "Supabase server configuration is incomplete" }, 500);
  }

  const callback = await req.json().catch(() => null);
  const stk = callback?.Body?.stkCallback;
  if (!stk?.CheckoutRequestID) return json({ ResultCode: 0, ResultDesc: "Accepted" });

  const admin = createClient(supabaseUrl, secretKey);

  const resultCode = Number(stk.ResultCode);
  const resultDescription = stk.ResultDesc || "";
  const successful = resultCode === 0;

  const metadataItems = stk.CallbackMetadata?.Item || [];
  const metadata: Record<string, unknown> = {};
  for (const item of metadataItems) {
    if (item?.Name) metadata[item.Name] = item.Value;
  }

  const { data: payment } = await admin
    .from("payments")
    .select("id, user_id, subscription_id, plan, amount, status")
    .eq("checkout_request_id", stk.CheckoutRequestID)
    .maybeSingle();

  if (!payment) {
    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  await admin
    .from("payments")
    .update({
      status: successful ? "SUCCESS" : "FAILED",
      result_code: resultCode,
      result_description: resultDescription,
      mpesa_receipt_number: metadata.MpesaReceiptNumber ?? null,
      transaction_id: metadata.MpesaReceiptNumber ?? null,
      raw_callback: callback,
      completed_at: new Date().toISOString(),
    })
    .eq("id", payment.id);

  if (successful) {
    const days = payment.plan === "business" ? 30 : 30;
    const now = new Date();
    const periodEnd = new Date(now.getTime() + days * 86400000).toISOString();

    const limits: Record<string, { inspection_limit: number; pdf_limit: number | null; seat_limit: number }> = {
      professional: { inspection_limit: 100, pdf_limit: null, seat_limit: 1 },
      business: { inspection_limit: 500, pdf_limit: null, seat_limit: 5 },
    };

    const limit = limits[payment.plan] || limits.professional;

    await admin
      .from("subscriptions")
      .upsert({
        user_id: payment.user_id,
        plan: payment.plan,
        status: "ACTIVE",
        inspection_limit: limit.inspection_limit,
        pdf_limit: limit.pdf_limit,
        seat_limit: limit.seat_limit,
        inspections_used: 0,
        pdf_exports_used: 0,
        started_at: now.toISOString(),
        current_period_end: periodEnd,
        next_billing_date: periodEnd,
        payment_method: "mpesa",
        last_payment_id: payment.id,
      }, { onConflict: "user_id" });
  }

  return json({ ResultCode: 0, ResultDesc: "Accepted" });
});
