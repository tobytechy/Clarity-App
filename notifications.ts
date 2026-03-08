// ============================================================
// CLARITY — NOTIFICATION SENDER
// Deploy as: supabase/functions/send-notification/index.ts
//
// Handles all Village alerts:
//   - Milestone reached
//   - Missed check-in
//   - Rough mood (quiet sponsor alert)
//   - SOS broadcast
//   - New message from user
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const TWILIO_SID     = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_TOKEN   = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_FROM    = Deno.env.get("TWILIO_PHONE_NUMBER")!;
const APP_URL        = Deno.env.get("APP_URL") || "https://yourapp.com";

// ---- Send email via Resend ----
async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Clarity App <support@yourapp.com>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) console.error("Resend error:", await res.text());
  return res.ok;
}

// ---- Send SMS via Twilio ----
async function sendSMS(to: string, body: string) {
  const auth = btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body }),
    }
  );
  if (!res.ok) console.error("Twilio error:", await res.text());
  return res.ok;
}

// ---- Email templates ----
function emailTemplate(title: string, body: string, cta?: { text: string; url: string }) {
  return `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;padding:0;background:#0f1117;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:520px;margin:32px auto;background:#181c27;border-radius:16px;overflow:hidden;border:1px solid #2a3048;">
      <div style="background:linear-gradient(135deg,#1e2333,#181c27);padding:28px 32px;border-bottom:1px solid #2a3048;">
        <div style="font-size:22px;font-weight:300;color:#e8eaf2;font-family:Georgia,serif;">
          Clar<span style="color:#f0a868;font-style:italic;">ity</span>
        </div>
      </div>
      <div style="padding:28px 32px;">
        <h2 style="font-size:20px;font-weight:400;color:#e8eaf2;margin:0 0 14px;font-family:Georgia,serif;">${title}</h2>
        <div style="font-size:14px;color:#9098b8;line-height:1.7;">${body}</div>
        ${cta ? `
        <div style="margin-top:24px;">
          <a href="${cta.url}" style="display:inline-block;background:#f0a868;color:#0f1117;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:13px;">${cta.text}</a>
        </div>` : ""}
      </div>
      <div style="padding:16px 32px;border-top:1px solid #2a3048;font-size:11px;color:#4a5070;text-align:center;">
        You're receiving this because you're part of someone's Village on Clarity.<br>
        <a href="${APP_URL}/unsubscribe" style="color:#f0a868;text-decoration:none;">Manage notifications</a>
      </div>
    </div>
  </body>
  </html>`;
}

// ============================================================
// MAIN HANDLER
// ============================================================
serve(async (req) => {
  const { type, user_id, data } = await req.json();

  // Load the user's profile
  const { data: user } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user_id)
    .single();

  if (!user) {
    return new Response("User not found", { status: 404 });
  }

  // Load village members who need to be notified
  const { data: members } = await supabase
    .from("village_members")
    .select("*")
    .eq("owner_id", user_id)
    .eq("status", "active");

  const days = Math.floor(
    (new Date().getTime() - new Date(user.sobriety_start).getTime()) / 86400000
  );

  switch (type) {

    // ---- MILESTONE REACHED ----
    case "milestone": {
      const milestone = data.milestone; // e.g. 30, 50, 90, 365
      const eligible = members?.filter(m => m.alert_milestone) || [];

      for (const member of eligible) {
        const subject = `🎉 ${user.display_name} just hit ${milestone} days!`;
        const body = `
          <p>Amazing news — <strong style="color:#f0a868">${user.display_name}</strong> just reached 
          <strong>${milestone} days</strong> sober. That's ${milestone * 24} hours of strength and commitment.</p>
          <p>Take a moment to send them some love — it means more than you know.</p>
        `;
        const ctaUrl = `${APP_URL}/village/message?to=${user_id}`;

        if (member.invite_email) {
          await sendEmail(member.invite_email, subject, emailTemplate(`🎉 ${milestone} Days!`, body, { text: "Send a message of support →", url: ctaUrl }));
        }
        if (member.invite_phone) {
          await sendSMS(member.invite_phone, `🎉 ${user.display_name} just hit ${milestone} days sober! Send them some love: ${ctaUrl}`);
        }
      }
      break;
    }

    // ---- MISSED CHECK-IN ----
    case "missed_checkin": {
      const eligible = members?.filter(m => m.alert_missed_checkin) || [];

      for (const member of eligible) {
        const subject = `💙 ${user.display_name} hasn't checked in today`;
        const body = `
          <p><strong style="color:#f0a868">${user.display_name}</strong> hasn't logged their daily check-in today.</p>
          <p>They may just be busy — but a quick message of support could mean everything right now.</p>
        `;

        if (member.invite_email) {
          await sendEmail(member.invite_email, subject, emailTemplate("Check In With Them 💙", body, { text: "Send a comfort note →", url: `${APP_URL}/village/message?to=${user_id}` }));
        }
        if (member.invite_phone) {
          await sendSMS(member.invite_phone, `💙 ${user.display_name} hasn't checked in on Clarity today. Consider reaching out.`);
        }
      }
      break;
    }

    // ---- ROUGH MOOD (quiet sponsor alert) ----
    case "rough_mood": {
      // Only notify sponsor silently
      const sponsors = members?.filter(m => m.alert_rough_mood && m.role === "sponsor") || [];

      for (const sponsor of sponsors) {
        const subject = `💙 ${user.display_name} is having a rough day`;
        const body = `
          <p><strong style="color:#f0a868">${user.display_name}</strong> just logged that they're feeling rough today 
          (Day ${days} of their journey).</p>
          <p>A quick call or message from you could make a real difference right now.</p>
        `;

        if (sponsor.invite_email) {
          await sendEmail(sponsor.invite_email, subject, emailTemplate("They Could Use You 💙", body, { text: "Reach out now →", url: `${APP_URL}/village/message?to=${user_id}` }));
        }
        if (sponsor.invite_phone) {
          await sendSMS(sponsor.invite_phone, `💙 FYI — ${user.display_name} is having a rough day (Day ${days}). Worth reaching out.`);
        }
      }
      break;
    }

    // ---- SOS BROADCAST ----
    case "sos": {
      // Alert EVERYONE in the village immediately
      for (const member of members || []) {
        const subject = `🆘 ${user.display_name} needs support RIGHT NOW`;
        const body = `
          <p style="color:#e8728a;font-weight:600;font-size:16px;">🆘 ${user.display_name} has sent an SOS.</p>
          <p>They need immediate support. Please reach out as soon as possible — a call, text, or message could make all the difference.</p>
          <p>They are on Day ${days} of their recovery journey.</p>
        `;

        if (member.invite_email) {
          await sendEmail(member.invite_email, subject, emailTemplate("🆘 They Need You Now", body, { text: "Respond immediately →", url: `${APP_URL}/village/message?to=${user_id}` }));
        }
        if (member.invite_phone) {
          await sendSMS(member.invite_phone, `🆘 URGENT: ${user.display_name} needs support right now (Day ${days}). Please reach out immediately.`);
        }
      }
      break;
    }

    // ---- NEW WIN SHARED ----
    case "new_win": {
      const eligible = members?.filter(m => m.alert_new_win && m.can_see_wins) || [];

      for (const member of eligible) {
        const subject = `🏆 ${user.display_name} just recorded a win!`;
        const body = `
          <p><strong style="color:#f0a868">${user.display_name}</strong> just logged a new achievement:</p>
          <p style="background:#1e2333;padding:14px 18px;border-radius:8px;border-left:3px solid #f0c060;color:#e8eaf2;">
            "${data.win_title}"
          </p>
          <p>Every win counts. Let them know you saw it!</p>
        `;

        if (member.invite_email) {
          await sendEmail(member.invite_email, subject, emailTemplate("🏆 New Win!", body, { text: "Send a reaction →", url: `${APP_URL}/village/message?to=${user_id}` }));
        }
      }
      break;
    }

    // ---- VILLAGE BROADCAST (user sends message to team) ----
    case "broadcast": {
      for (const member of members || []) {
        const subject = `💌 ${user.display_name} sent a message to their Village`;
        const body = `
          <p><strong style="color:#f0a868">${user.display_name}</strong> wanted to share something with their support circle:</p>
          <p style="background:#1e2333;padding:14px 18px;border-radius:8px;border-left:3px solid #a890e8;color:#e8eaf2;font-style:italic;">
            "${data.message}"
          </p>
        `;

        if (member.invite_email) {
          await sendEmail(member.invite_email, subject, emailTemplate(`Message from ${user.display_name}`, body, { text: "Reply with support →", url: `${APP_URL}/village/message?to=${user_id}` }));
        }
        if (member.invite_phone) {
          await sendSMS(member.invite_phone, `💌 ${user.display_name}: "${data.message.substring(0, 100)}${data.message.length > 100 ? "..." : ""}"`);
        }
      }
      break;
    }

    // ---- VILLAGE INVITE ----
    case "invite": {
      const { email, phone, name, token, role } = data;
      const inviteUrl = `${APP_URL}/join?token=${token}`;

      if (email) {
        const body = `
          <p><strong style="color:#f0a868">${user.display_name}</strong> is on a recovery journey and has invited you 
          to be part of their Village as their <strong>${role}</strong>.</p>
          <p>As a Village member, you'll be able to send encouragement, leave comfort notes, and support them on their journey — on their terms.</p>
          <p style="font-size:12px;color:#6b7394;">Their privacy is always protected. They control everything you can see.</p>
        `;
        await sendEmail(email, `${user.display_name} wants you in their Village on Clarity`, emailTemplate(`You're Invited to ${user.display_name}'s Village 🫂`, body, { text: "Accept invitation →", url: inviteUrl }));
      }
      if (phone) {
        await sendSMS(phone, `🫂 ${user.display_name} invited you to their support Village on Clarity. Accept here: ${inviteUrl}`);
      }
      break;
    }
  }

  return new Response(JSON.stringify({ sent: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
