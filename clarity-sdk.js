// ============================================================
// CLARITY APP — CLIENT SDK
// Drop this into your sobriety-tracker.html just before </body>
// Replace the placeholder values with your real keys
// ============================================================

// ---- CONFIG (replace with your real values) ----
const SUPABASE_URL  = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON = "YOUR_SUPABASE_ANON_KEY";
const STRIPE_KEY    = "pk_live_YOUR_STRIPE_PUBLISHABLE_KEY";

// ---- Load Supabase ----
// Add this to your <head>:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
// <script src="https://js.stripe.com/v3/"></script>

const { createClient } = supabase;
const db     = createClient(SUPABASE_URL, SUPABASE_ANON);
const stripe = Stripe(STRIPE_KEY);

// ============================================================
// AUTH
// ============================================================
const Auth = {

  async signUp(email, password, displayName) {
    const { data, error } = await db.auth.signUp({
      email, password,
      options: { data: { display_name: displayName } }
    });
    if (error) throw error;
    return data;
  },

  async signIn(email, password) {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    await db.auth.signOut();
    window.location.href = "/login";
  },

  async getUser() {
    const { data: { user } } = await db.auth.getUser();
    return user;
  },

  async getProfile() {
    const user = await Auth.getUser();
    if (!user) return null;
    const { data } = await db.from("profiles").select("*").eq("id", user.id).single();
    return data;
  },

  onAuthChange(callback) {
    db.auth.onAuthStateChange(callback);
  }
};

// ============================================================
// STATS — sobriety calculations
// ============================================================
const Stats = {

  async get() {
    const user = await Auth.getUser();
    if (!user) return null;
    const { data } = await db.from("user_stats").select("*").eq("id", user.id).single();
    return data;
  },

  async updateStartDate(date) {
    const user = await Auth.getUser();
    await db.from("profiles").update({ sobriety_start: date }).eq("id", user.id);
  }
};

// ============================================================
// CHECK-INS
// ============================================================
const CheckIns = {

  async todayExists() {
    const user = await Auth.getUser();
    const today = new Date().toISOString().split("T")[0];
    const { data } = await db.from("checkins")
      .select("id")
      .eq("user_id", user.id)
      .eq("checked_in_at", today)
      .single();
    return !!data;
  },

  async checkIn(mood, note) {
    const user = await Auth.getUser();
    const today = new Date().toISOString().split("T")[0];
    const { error } = await db.from("checkins").upsert({
      user_id: user.id,
      checked_in_at: today,
      mood,
      note
    });
    if (error) throw error;

    // Trigger rough mood alert if applicable
    if (mood === "rough") {
      await Notifications.send("rough_mood");
    }

    // Check for milestones
    const stats = await Stats.get();
    const milestones = [7, 14, 21, 30, 50, 60, 90, 100, 180, 365];
    if (milestones.includes(stats.total_days)) {
      await Notifications.send("milestone", { milestone: stats.total_days });
    }

    return true;
  },

  async getCalendar(year, month) {
    const user = await Auth.getUser();
    const start = `${year}-${String(month).padStart(2,"0")}-01`;
    const end   = `${year}-${String(month).padStart(2,"0")}-31`;
    const { data } = await db.from("checkins")
      .select("checked_in_at, mood")
      .eq("user_id", user.id)
      .gte("checked_in_at", start)
      .lte("checked_in_at", end);
    return data || [];
  }
};

// ============================================================
// WINS
// ============================================================
const Wins = {

  async add(title, category, shared = false) {
    const user = await Auth.getUser();
    const { data, error } = await db.from("wins").insert({
      user_id: user.id, title, category, shared
    }).select().single();
    if (error) throw error;

    if (shared) {
      await Notifications.send("new_win", { win_title: title });
    }
    return data;
  },

  async getAll() {
    const user = await Auth.getUser();
    const { data } = await db.from("wins")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    return data || [];
  },

  async like(winId) {
    await db.rpc("increment_win_likes", { win_id: winId });
  }
};

// ============================================================
// JOURNAL
// ============================================================
const Journal = {

  async save(content, mood) {
    const user = await Auth.getUser();
    const { data, error } = await db.from("journal_entries").insert({
      user_id: user.id, content, mood
    }).select().single();
    if (error) throw error;
    return data;
  },

  async getAll() {
    const user = await Auth.getUser();
    const { data } = await db.from("journal_entries")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    return data || [];
  }
};

// ============================================================
// VILLAGE
// ============================================================
const Village = {

  async getMembers() {
    const user = await Auth.getUser();
    const { data } = await db.from("village_members")
      .select("*")
      .eq("owner_id", user.id)
      .neq("status", "removed")
      .order("created_at");
    return data || [];
  },

  async invite({ name, email, phone, role, permissions }) {
    const user = await Auth.getUser();
    const { data, error } = await db.from("village_members").insert({
      owner_id:              user.id,
      display_name:          name,
      invite_email:          email || null,
      invite_phone:          phone || null,
      role,
      ...permissions
    }).select().single();
    if (error) throw error;

    // Send invite notification
    await Notifications.send("invite", {
      email, phone, name, role,
      token: data.invite_token
    });

    return data;
  },

  async updatePermissions(memberId, permissions) {
    const user = await Auth.getUser();
    const { error } = await db.from("village_members")
      .update(permissions)
      .eq("id", memberId)
      .eq("owner_id", user.id);
    if (error) throw error;
  },

  async remove(memberId) {
    const user = await Auth.getUser();
    await db.from("village_members")
      .update({ status: "removed" })
      .eq("id", memberId)
      .eq("owner_id", user.id);
  },

  async broadcast(message) {
    await Notifications.send("broadcast", { message });
  },

  async sendSOS() {
    await Notifications.send("sos");
  }
};

// ============================================================
// MESSAGES
// ============================================================
const Messages = {

  async getInbox() {
    const user = await Auth.getUser();
    const { data } = await db.from("messages")
      .select("*")
      .eq("to_user_id", user.id)
      .order("created_at", { ascending: false });
    return data || [];
  },

  async getUnreadCount() {
    const user = await Auth.getUser();
    const { data } = await db.from("unread_counts")
      .select("unread_messages")
      .eq("user_id", user.id)
      .single();
    return data?.unread_messages || 0;
  },

  async markRead(messageId) {
    await db.from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("id", messageId);
  },

  async sendReaction(messageId, emoji) {
    await db.from("messages").update({ reaction: emoji }).eq("id", messageId);
  },

  async getComfortNotes() {
    const user = await Auth.getUser();
    const { data } = await db.from("comfort_notes")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    return data || [];
  },

  async saveComfortNote(messageId, text, authorName) {
    const user = await Auth.getUser();
    await db.from("comfort_notes").insert({
      user_id: user.id,
      message_id: messageId,
      text,
      author_name: authorName
    });
  },

  // Real-time: listen for new messages
  subscribe(userId, onMessage) {
    return db.channel("messages")
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `to_user_id=eq.${userId}`
      }, onMessage)
      .subscribe();
  }
};

// ============================================================
// NOTIFICATIONS (calls Supabase Edge Function)
// ============================================================
const Notifications = {

  async send(type, data = {}) {
    const user = await Auth.getUser();
    if (!user) return;

    try {
      await db.functions.invoke("send-notification", {
        body: { type, user_id: user.id, data }
      });
    } catch (err) {
      console.warn("Notification failed (non-critical):", err);
    }
  }
};

// ============================================================
// SUBSCRIPTIONS & STRIPE
// ============================================================
const Billing = {

  PRICES: {
    basic: "price_basic_monthly",  // Replace with real Stripe price IDs
    pro:   "price_pro_monthly",
    team:  "price_team_monthly",
  },

  async startCheckout(plan) {
    const user = await Auth.getUser();
    if (!user) { window.location.href = "/login"; return; }

    // Call your backend to create a Stripe Checkout session
    const res = await fetch("/api/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id:  user.id,
        price_id: Billing.PRICES[plan],
        success_url: `${window.location.origin}/app?subscribed=true`,
        cancel_url:  `${window.location.origin}/pricing`,
      }),
    });

    const { url } = await res.json();
    window.location.href = url; // Redirect to Stripe hosted checkout
  },

  async openPortal() {
    // Opens Stripe Customer Portal for managing/canceling subscription
    const res = await fetch("/api/customer-portal", { method: "POST" });
    const { url } = await res.json();
    window.location.href = url;
  },

  async getCurrentPlan() {
    const profile = await Auth.getProfile();
    return profile?.subscription || "free";
  },

  isPro(plan) {
    return ["pro", "team"].includes(plan);
  },

  isTeam(plan) {
    return plan === "team";
  }
};

// ============================================================
// FEATURE GATES (what free vs paid users can access)
// ============================================================
const Features = {

  free: {
    village_members:   2,
    journal_days:     30,
    wins_total:       10,
    notifications:  false,
    comfort_notes:     3,
  },

  basic: {
    village_members:   5,
    journal_days:    365,
    wins_total:      100,
    notifications:  true,
    comfort_notes:   999,
  },

  pro: {
    village_members:  10,
    journal_days:    Infinity,
    wins_total:      Infinity,
    notifications:  true,
    comfort_notes:   Infinity,
  },

  team: {
    village_members:  20,
    journal_days:    Infinity,
    wins_total:      Infinity,
    notifications:  true,
    comfort_notes:   Infinity,
    team_connect:   true,   // Village members can coordinate with each other
  },

  async check(feature) {
    const plan = await Billing.getCurrentPlan();
    return Features[plan]?.[feature] ?? Features.free[feature];
  },

  async requiresPro(action) {
    const plan = await Billing.getCurrentPlan();
    if (!Billing.isPro(plan)) {
      showUpgradeModal(action);
      return false;
    }
    return true;
  }
};

// ============================================================
// UPGRADE MODAL
// ============================================================
function showUpgradeModal(action = "this feature") {
  // Remove existing modal
  document.getElementById("upgrade-modal")?.remove();

  const modal = document.createElement("div");
  modal.id = "upgrade-modal";
  modal.style.cssText = "position:fixed;inset:0;z-index:900;background:rgba(0,0,0,0.85);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:20px;";
  modal.innerHTML = `
    <div style="background:#181c27;border:1px solid #2a3048;border-radius:18px;padding:32px;max-width:360px;width:100%;text-align:center;">
      <div style="font-size:40px;margin-bottom:14px;">✨</div>
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#e8eaf2;margin-bottom:8px;">
        Upgrade to <span style="font-style:italic;color:#f0a868;">Pro</span>
      </div>
      <div style="font-size:13px;color:#6b7394;line-height:1.7;margin-bottom:22px;">
        ${action} is available on the Pro plan. Upgrade to unlock your full Village, unlimited wins, notifications, and more.
      </div>
      <button onclick="Billing.startCheckout('pro')" style="width:100%;padding:14px;background:linear-gradient(135deg,#f0a868,#f0c060);border:none;border-radius:10px;color:#0f1117;font-weight:700;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;margin-bottom:10px;">
        Upgrade to Pro — $14.99/mo
      </button>
      <button onclick="document.getElementById('upgrade-modal').remove()" style="background:none;border:none;color:#6b7394;font-size:13px;cursor:pointer;font-family:'DM Sans',sans-serif;">
        Maybe later
      </button>
    </div>
  `;
  document.body.appendChild(modal);
}

// ============================================================
// APP INIT — call this when the page loads
// ============================================================
async function initApp() {
  const user = await Auth.getUser();

  if (!user) {
    // Redirect to login if not authenticated
    // window.location.href = "/login";
    console.log("Not logged in — showing demo mode");
    return;
  }

  // Load real stats
  const stats = await Stats.get();
  if (stats) {
    document.getElementById("day-count").textContent = stats.total_days;
    document.querySelector(".stat-val[data-stat='money']").textContent =
      "$" + Number(stats.money_saved).toLocaleString();
    document.querySelector(".stat-val[data-stat='hours']").textContent =
      Number(stats.hours_sober).toLocaleString();
  }

  // Check if already checked in today
  const alreadyIn = await CheckIns.todayExists();
  if (alreadyIn) {
    const btn = document.getElementById("checkin-btn");
    if (btn) { btn.classList.add("done"); btn.innerHTML = "<span>✓</span> Checked in today!"; }
  }

  // Load unread count
  const unread = await Messages.getUnreadCount();
  if (unread > 0) {
    const tab = document.querySelectorAll(".nav-tab")[3]; // Messages tab
    if (tab) tab.textContent = `💌 Messages (${unread})`;
  }

  // Real-time: listen for new messages
  Messages.subscribe(user.id, (payload) => {
    showToast(`💌 New message from ${payload.new.sender_name || "your Village"}!`);
    // Optionally reload messages tab
  });

  console.log(`✅ Clarity loaded for user: ${user.id}`);
}

// Boot the app
document.addEventListener("DOMContentLoaded", initApp);
