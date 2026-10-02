import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SANDBOX_TEST_PHONE = "254708374149";
const SANDBOX_MATCH_WINDOW_MS = 15 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function callbackMetadata(items: unknown[]) {
  const metadata: Record<string, unknown> = {};
  for (const item of items) {
    if (item && typeof item === "object" && "Name" in item && item.Name) {
      metadata[String(item.Name)] = item.Value;
    }
  }
  return metadata;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const secretKey = secretKeys.default;

    if (!supabaseUrl || !secretKey) {
      return json({ error: "Supabase server configuration is incomplete" }, 500);
    }

    const callback = await req.json().catch(() => null);
    const stk = callback?.Body?.stkCallback;

    if (!stk?.CheckoutRequestID) {
      return json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const admin = createClient(supabaseUrl, secretKey);
    const resultCode = Number(stk.ResultCode);
    const resultDescription = String(stk.ResultDesc || "");
    const successful = resultCode === 0;
    const metadata = callbackMetadata(stk.CallbackMetadata?.Item || []);

    let payment = null;

    const { data: exactPayment, error: exactPaymentError } = await admin
      .from("payments")
      .select("id, user_id, subscription_id, plan, amount, status, phone_number, checkout_request_id, merchant_request_id")
      .eq("checkout_request_id", stk.CheckoutRequestID)
      .maybeSingle();

    if (exactPaymentError) {
      console.error("payment_lookup_failed", exactPaymentError);
      return json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    payment = exactPayment;

    // Daraja's sandbox simulator can generate its own CheckoutRequestID.
    // In sandbox only, correlate it to the newest pending FieldInspect test
    // payment using the documented test phone and exact transaction amount.
    if (!payment && Deno.env.get("MPESA_ENV") !== "live") {
      const callbackPhone = String(metadata.PhoneNumber || "");
      const callbackAmount = Number(metadata.Amount);

      if (
        callbackPhone === SANDBOX_TEST_PHONE &&
        Number.isFinite(callbackAmount) &&
        callbackAmount > 0
      ) {
        const since = new Date(Date.now() - SANDBOX_MATCH_WINDOW_MS).toISOString();

        const { data: candidate, error: candidateError } = await admin
          .from("payments")
          .select("id, user_id, subscription_id, plan, amount, status, phone_number, checkout_request_id, merchant_request_id, created_at")
          .eq("status", "PENDING")
          .eq("phone_number", SANDBOX_TEST_PHONE)
          .eq("amount", callbackAmount)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (candidateError) {
          console.error("sandbox_payment_match_failed", candidateError);
        } else if (candidate) {
          payment = candidate;
          console.log("sandbox_simulator_payment_matched", {
            paymentId: candidate.id,
            simulatorCheckoutRequestId: stk.CheckoutRequestID,
          });
        }
      }
    }

    if (!payment) {
      console.warn("payment_not_found_for_callback", {
        checkoutRequestId: stk.CheckoutRequestID,
        resultCode,
        callbackPhone: metadata.PhoneNumber ?? null,
        callbackAmount: metadata.Amount ?? null,
      });
      return json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const { error: paymentUpdateError } = await admin
      .from("payments")
      .update({
        status: successful ? "SUCCESS" : "FAILED",
        result_code: resultCode,
        result_description: resultDescription,
        mpesa_receipt_number: metadata.MpesaReceiptNumber ?? null,
        transaction_id: metadata.MpesaReceiptNumber ?? null,
        raw_callback: callback,
        completed_at: new Date().toISOString(),
        checkout_request_id: payment.checkout_request_id || stk.CheckoutRequestID,
        merchant_request_id: payment.merchant_request_id || stk.MerchantRequestID || null,
      })
      .eq("id", payment.id);

    if (paymentUpdateError) {
      console.error("payment_update_failed", paymentUpdateError);
      return json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    if (successful) {
      const now = new Date();
      const periodEnd = new Date(now.getTime() + 30 * 86400000).toISOString();

      const limits: Record<string, { inspection_limit: number; pdf_limit: number | null; seat_limit: number }> = {
        professional: { inspection_limit: 100, pdf_limit: null, seat_limit: 1 },
        business: { inspection_limit: 500, pdf_limit: null, seat_limit: 5 },
      };

      const limit = limits[payment.plan];

      if (!limit) {
        console.error("unsupported_successful_payment_plan", { paymentId: payment.id, plan: payment.plan });
        return json({ ResultCode: 0, ResultDesc: "Accepted" });
      }

      const { error: subscriptionError } = await admin
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

      if (subscriptionError) {
        console.error("subscription_activation_failed", {
          paymentId: payment.id,
          error: subscriptionError,
        });
      }
    }

    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (error) {
    console.error("mpesa_callback_failed", error);
    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});
