const { buildTicketEmail } = require("./emailTemplate");
const mailer = require("./mailer");
const roleConfig = require("./emailRoleConfig");
const mongoClient = require("./mongoClient");
const {
  generateAttendingCardPDF,
} = require("./attendingCardGenerator");
// Ensure no trailing slash
function sanitizeUrl(url) {
  if (!url) return "";
  return url.replace(/\/$/, "");
}

async function obtainDb() {
  if (!mongoClient) return null;
  try {
    if (typeof mongoClient.getDb === "function") return await mongoClient.getDb();
    if (mongoClient.db) return mongoClient.db;
  } catch (e) {
    console.warn("[sendTicketEmail] obtainDb failed:", e && e.message);
  }
  return null;
}

/**
 * Fetch event details from DB (same source as EventDetailsAdmin / configs)
 * Returns { name, dates, time, venue, tagline } or null
 */
async function fetchEventDetailsFromDb() {
  try {
    const db = await obtainDb();
    if (!db) return null;
    const col = db.collection("app_configs");
    const doc = await col.findOne({ key: "event-details" });
    if (!doc || !doc.value || typeof doc.value !== "object") return null;
    const val = doc.value;
    return {
      name: val.name || "",
      dates: val.dates || val.date || "",
      time: val.time || val.startTime || "",
      venue: val.venue || val.location || "",
      tagline: val.tagline || "",
    };
  } catch (e) {
    console.warn("[sendTicketEmail] fetchEventDetailsFromDb failed:", e && e.message);
    return null;
  }
}

/**
 * Helper to fetch JSON from URL (works in Node.js)
 */
async function safeFetch(url) {
  try {
    let _fetch = typeof fetch !== "undefined" ? fetch : null;
    if (! _fetch) {
      try {
        const nf = require("node-fetch");
        _fetch = nf && nf.default ? nf. default : nf;
      } catch (e) {
        console.warn("[sendTicketEmail] node-fetch not available");
        return null;
      }
    }
    
    console.log("[sendTicketEmail] Fetching:", url);
    
    const res = await _fetch(url, {
      headers: {
        Accept: "application/json",
        "ngrok-skip-browser-warning":  "69420",
      },
      timeout: 5000,
    });
    
    if (!res.ok) {
      console.warn("[sendTicketEmail] Fetch failed:", res.status, res. statusText);
      return null;
    }
    
    const data = await res.json();
    console.log("[sendTicketEmail] ✅ Fetch successful");
    return data;
  } catch (e) {
    console.warn("[sendTicketEmail] Fetch error:", e.message);
    return null;
  }
}

/**
 * Fetch canonical event details (same source as EventDetailsAdmin)
 * Tries DB first (app_configs.event-details), then HTTP /api/configs/event-details as fallback
 */
async function fetchEventDetails() {
  // 1. Prefer DB - same data EventDetailsAdmin saves via /api/configs/event-details
  const fromDb = await fetchEventDetailsFromDb();
  if (fromDb) {
    console.log("[sendTicketEmail] Event details from DB:", fromDb.name || "(empty)");
    return fromDb;
  }

  // 2. Fallback: HTTP if BACKEND_URL is set
  const apiBase = process.env.BACKEND_URL || process.env.API_BASE || "";
  if (!apiBase || !/^https?:\/\//i.test(apiBase)) return fromDb || null;

  const url = `${apiBase.replace(/\/$/, "")}/api/configs/event-details?cb=${Date.now()}`;
  const js = await safeFetch(url);
  if (!js || !js.value) return fromDb || null;

  const val = js.value;
  return {
    name: val.name || "",
    dates: val.dates || val.date || "",
    time: val.time || val.startTime || "",
    venue: val.venue || val.location || "",
    tagline: val.tagline || "",
  };
}

/**
 * Fetch admin logo URL from backend
 */
async function fetchAdminLogo() {
  const apiBase = process.env.BACKEND_URL || process. env.API_BASE || "";
  
  if (!apiBase || !/^https?:\/\//i.test(apiBase)) {
    return "";
  }

  const paths = ["/api/admin-config", "/api/admin/logo-url"];
  
  for (const path of paths) {
    const url = `${apiBase.replace(/\/$/, "")}${path}?cb=${Date.now()}`;
    const js = await safeFetch(url);
    
    if (!js) continue;
    
    if (js.logoUrl) return js.logoUrl;
    if (js.logo_url) return js.logo_url;
    if (js.url) return js.url;
    if (typeof js === "string" && js.trim()) return js.trim();
  }
  
  return "";
}

/**
 * Main function:  Send ticket email with badge
 */
module.exports = async function sendTicketEmail({ entity, record, frontendBase = "", options = {} }) {
  const doc = record;
  const config = roleConfig[entity];

  if (!config) throw new Error(`Unsupported entity: ${entity}`);
  if (!doc?.email) throw new Error("Recipient email missing");

  // Sanitize URLs
  const backendUrlSafe = sanitizeUrl(process.env.BACKEND_ORIGIN || process.env.BACKEND_URL || "");
  const frontendUrlSafe = sanitizeUrl(frontendBase || process.env.APP_URL || backendUrlSafe);

  console.log("[sendTicketEmail] Backend URL:", backendUrlSafe);
  console.log("[sendTicketEmail] Frontend URL:", frontendUrlSafe);

  // Fetch event details and admin logo ONCE
  let eventDetails = null;
  try { eventDetails = await fetchEventDetails(); } catch (e) { console.warn(e.message); }

  let logoUrl = "";
  try { logoUrl = await fetchAdminLogo(); } catch (e) { console.warn(e.message); }

  // Handle nested fields
  const getField = (field) => doc[field] ?? doc.data?.[field];

  // Build email payload
  const isUpgrade = options && typeof options === "object" ? !!options.isUpgrade : false;
  const previousCategory =
    options && typeof options === "object" && options.previousCategory
      ? String(options.previousCategory)
      : null;

  const includeAttendingCard =
  options &&
  typeof options === "object"
    ? options.includeAttendingCard === true
    : false;

  const emailPayload = await buildTicketEmail({
    frontendBase: frontendUrlSafe,
    backendBase: backendUrlSafe,   // ✅ ADD THIS
    entity,
    id: String(doc._id || doc.id),
    name: getField("name"),
    company: getField("company"),
    ticket_category: getField("ticket_category"),
    logoUrl: logoUrl || "",
    form: { ...(doc.data ?? doc), eventDetails, isUpgrade, previousCategory },
    pdfBase64: null,
    upgradeUrl: config.allowUpgrade ? undefined : "",
  });
  

  // Override subject if needed
  if (config.subjectPrefix) emailPayload.subject = `RailTrans Expo — ${config.subjectPrefix}`;

 console.log("[sendTicketEmail] Sending to:", doc.email);
console.log("[sendTicketEmail] Subject:", emailPayload.subject);

const attachments = [];

if (includeAttendingCard) {
  try {
    console.log(
      "[sendTicketEmail] Generating Attending Card for:",
      doc.ticket_code || doc._id || doc.id
    );

    const attendingCardPDF =
      await generateAttendingCardPDF(doc);

    if (!Buffer.isBuffer(attendingCardPDF)) {
      throw new Error(
        "Attending Card generator did not return a valid PDF buffer"
      );
    }

    const ticketCode =
      doc.ticket_code ||
      doc.ticketCode ||
      doc._id ||
      doc.id;

    attachments.push({
      filename: `RailTrans-Attending-Card-${ticketCode}.pdf`,
      content: attendingCardPDF,
      contentType: "application/pdf",
    });

    console.log(
      "[sendTicketEmail] ✅ Attending Card attached:",
      attendingCardPDF.length,
      "bytes"
    );
  } catch (err) {
    console.error(
      "[sendTicketEmail] ❌ Attending Card generation failed:",
      err.stack || err
    );

    // Do NOT fail the complete email just because
    // Attending Card generation failed.
  }
}

const result = await mailer.sendMail({
  to: doc.email,
  subject: emailPayload.subject,
  text: emailPayload.text,
  html: emailPayload.html,
  attachments,
});

  if (result?.success) {
    console.log("[sendTicketEmail] ✅ Email sent successfully");
    return { success: true, info: result.info, messageId: result.info?.messageId, dbRecordId: result.dbRecordId };
  } else {
    console.error("[sendTicketEmail] ❌ Email failed:", result?.error);
    return { success: false, error: result?.error || "Mail send failed", dbRecordId: result?.dbRecordId };
  }
};
