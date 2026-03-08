// ============================================================
// CLARITY — STRIPE WEBHOOK HANDLER
// Deploy as a Supabase Edge Function:
//   supabase/functions/stripe-webhook/index.ts
//
// This handles all Stripe subscription events and keeps
// your Supabase database in sync automatically.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@13.0.0";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // service role bypasses RLS
);

// Map Stripe Price IDs to your plan names
// Replace these with your actual Stripe Price IDs from the dashboard
const PRICE_TO_PLAN: Record<string, string> = {
  "price_basic_monthly":  "basic",   // $7.99/mo
  "price_pro_monthly":    "pro",     // $14.99/mo
  "price_team_monthly":   "team",    // $24.99/mo
};

serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature!,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  console.log(`Processing Stripe event: ${event.type}`);

  switch (event.type) {

    // ---- Checkout completed: new subscriber ----
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.user_id;
      if (!userId) break;

      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      );

      const priceId = subscription.items.data[0]?.price.id;
      const plan = PRICE_TO_PLAN[priceId] || "basic";

      // Update profiles table
      await supabase
        .from("profiles")
        .update({
          subscription: plan,
          stripe_customer_id: session.customer as string,
        })
        .eq("id", userId);

      // Create subscription record
      await supabase.from("subscriptions").upsert({
        user_id: userId,
        stripe_subscription_id: subscription.id,
        stripe_customer_id: session.customer as string,
        plan,
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      });

      console.log(`✅ New ${plan} subscriber: ${userId}`);
      break;
    }

    // ---- Subscription updated (upgrade/downgrade) ----
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;

      const priceId = subscription.items.data[0]?.price.id;
      const plan = PRICE_TO_PLAN[priceId] || "basic";

      // Find user by stripe customer ID
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("stripe_customer_id", subscription.customer as string)
        .single();

      if (!profile) break;

      await supabase
        .from("profiles")
        .update({ subscription: subscription.status === "active" ? plan : "free" })
        .eq("id", profile.id);

      await supabase
        .from("subscriptions")
        .update({
          plan,
          status: subscription.status,
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          cancel_at: subscription.cancel_at
            ? new Date(subscription.cancel_at * 1000).toISOString()
            : null,
        })
        .eq("stripe_subscription_id", subscription.id);

      console.log(`🔄 Subscription updated: ${plan} (${subscription.status})`);
      break;
    }

    // ---- Subscription cancelled ----
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;

      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("stripe_customer_id", subscription.customer as string)
        .single();

      if (!profile) break;

      // Downgrade to free
      await supabase
        .from("profiles")
        .update({ subscription: "free" })
        .eq("id", profile.id);

      await supabase
        .from("subscriptions")
        .update({ status: "canceled" })
        .eq("stripe_subscription_id", subscription.id);

      console.log(`❌ Subscription cancelled for user: ${profile.id}`);
      break;
    }

    // ---- Payment failed ----
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;

      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("stripe_customer_id", invoice.customer as string)
        .single();

      if (!profile) break;

      await supabase
        .from("subscriptions")
        .update({ status: "past_due" })
        .eq("user_id", profile.id);

      // TODO: trigger email via Resend — "Payment failed, please update your card"
      console.log(`⚠️ Payment failed for user: ${profile.id}`);
      break;
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});
