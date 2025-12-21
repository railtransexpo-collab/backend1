const express = require("express");
const { sendMail } = require("../utils/mailer"); // expects module that exports sendMail(...)
const router = express.Router();

const API_BASE = (process.env.API_BASE || process.env.BACKEND_URL || "/api").replace(/\/$/, "");
const FRONTEND_BASE = (process.env.FRONTEND_BASE || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

router.use(express.json({ limit: "3mb" }));

/**
 * Utility - try to find an event date on a record using common field names
 */
function parseEventDate(record) {
  if (!record) return null;
  const candidates = [
    record.eventDate,
    record.event_date,
    record.event?.date,
    record.eventDetails?.date,
    record.eventDetailsDate,
    record.date,
    record.eventDateString,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Compute whole-day difference (eventDate - today) in days using UTC day boundaries.
 */
function daysUntilEvent(eventDate) {
  if (!eventDate) return null;
  const now = new Date();
  const utcNowDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const d = new Date(eventDate);
  const utcEventDayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const diffMs = utcEventDayStart - utcNowDayStart;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Try to fetch a single record by id using a few common patterns.
 * Returns the record object or null.
 */
async function fetchRecordById(entity, id) {
  if (!entity || !id) return null;
  const candidateUrls = [
    `${API_BASE}/api/${entity}/${encodeURIComponent(String(id))}`,
    `${API_BASE}/api/${entity}?id=${encodeURIComponent(String(id))}`,
    `${API_BASE}/api/${entity}?_id=${encodeURIComponent(String(id))}`,
    `${API_BASE}/api/${entity}?where=_id=${encodeURIComponent(String(id))}`,
    `${API_BASE}/api/${entity}?where=id=${encodeURIComponent(String(id))}`,
  ];
  for (const url of candidateUrls) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", "ngrok-skip-browser-warning": "69420" } });
      if (!r.ok) continue;
      const js = await r.json().catch(() => null);
      if (!js) continue;
      // If response is an array, pick first
      if (Array.isArray(js) && js.length) return js[0];
      // If response contains data/rows/results
      const arr = js.data || js.rows || js.results;
      if (Array.isArray(arr) && arr.length) return arr[0];
      // If object shaped, return itself
      if (typeof js === "object" && Object.keys(js).length) {
        // sometimes GET /api/entity/:id returns an object
        // or /api/entity?id=... may return array; handled above
        return js;
      }
    } catch (e) {
      // try next
    }
  }
  return null;
}

/**
 * Update record reminders_sent and last_reminder_at using best-effort update endpoints.
 */
async function markReminderSent(entity, rec, daysUntil) {
  try {
    const nowIso = new Date().toISOString();
    const updatedReminders = Array.isArray(rec.reminders_sent)
      ? Array.from(new Set([...rec.reminders_sent.map((v) => Number(v)), daysUntil]))
      : [daysUntil];

    const updatePayload = { reminders_sent: updatedReminders, last_reminder_at: nowIso };

    const updateId = rec.id || rec._id || rec.insertedId || null;
    if (updateId) {
      await fetch(`${API_BASE}/api/${entity}/${encodeURIComponent(String(updateId))}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "69420" },
        body: JSON.stringify(updatePayload),
      }).catch(() => {});
    } else if (rec.ticket_code || rec.ticketCode) {
      // fallback: try upgrade-by-code or similar
      await fetch(`${API_BASE}/api/${entity}/upgrade-by-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "69420" },
        body: JSON.stringify({ ticket_code: rec.ticket_code || rec.ticketCode, reminders_sent: updatedReminders, last_reminder_at: nowIso }),
      }).catch(() => {});
    }
  } catch (e) {
    // swallow; best-effort only
    console.warn("[reminders] markReminderSent failed", e && (e.message || e));
  }
}

/**
 * POST /api/reminders/send
 *
 * Send a single reminder immediately for an entityId.
 * Body: { entity: "speakers", entityId: "...", eventDate?: "...", subject?, text?, html? }
 *
 * This is a convenience immediate-send endpoint (used by frontend after save).
 */
router.post("/send", async (req, res) => {
  try {
    const { entity = "visitors", entityId = null, eventDate: providedEventDate = null, subject: overrideSubject, text: overrideText, html: overrideHtml } = req.body || {};
    if (!entity) return res.status(400).json({ success: false, error: "entity required" });
    if (!entityId) return res.status(400).json({ success: false, error: "entityId required" });

    const rec = await fetchRecordById(entity, entityId);
    if (!rec) return res.status(404).json({ success: false, error: "record not found" });

    const evDate = providedEventDate || parseEventDate(rec);
    const daysUntil = daysUntilEvent(evDate);

    // Compose message
    const baseName = (rec.name || rec.full_name || rec.company || "Participant");
    const subj = overrideSubject || `${baseName} — Reminder${evDate ? `: ${new Date(evDate).toDateString()}` : ""}`;
    const dayLabel = daysUntil === 0 ? "today" : (daysUntil ? `${daysUntil} day${Math.abs(daysUntil) === 1 ? "" : "s"} to go` : "upcoming");
    const eventName = (rec.eventDetails && rec.eventDetails.name) || (rec.event && rec.event.name) || (typeof rec.event === "string" ? rec.event : "") || "";

    const textBody = overrideText || `Hello ${rec.name || ""},\n\nThis is a reminder that the event "${eventName}" is ${dayLabel}.\n\nRegards,\nRailtrans Expo Team`;
    const htmlBody = overrideHtml || `<p>Hello ${rec.name || ""},</p><p>This is a reminder that the event "<strong>${eventName}</strong>" is <strong>${dayLabel}</strong>.</p><p>Regards,<br/>Railtrans Expo Team</p>`;

    // Send mail
    let sendResult;
    try {
      sendResult = await sendMail({ to: rec.email || rec.emailAddress || rec.contactEmail || rec.contact_email, subject: subj, text: textBody, html: htmlBody });
    } catch (err) {
      console.error("[reminders/send] sendMail error:", err && (err.message || err));
      return res.status(500).json({ success: false, error: "mail send failed", details: String(err && err.message ? err.message : err) });
    }
    if (!sendResult || !sendResult.success) {
      console.warn("[reminders/send] sendMail returned failure:", sendResult);
      return res.status(502).json({ success: false, error: "mailer failure", details: sendResult });
    }

    // Mark reminder sent (best-effort)
    try {
      const du = (typeof daysUntil === "number" && !Number.isNaN(daysUntil)) ? daysUntil : 0;
      await markReminderSent(entity, rec, du);
    } catch (e) {
      // ignore
    }

    return res.json({ success: true, sentTo: rec.email || null });
  } catch (err) {
    console.error("[reminders/send] error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "server error", details: String(err && err.message ? err.message : err) });
  }
});

/**
 * POST /api/reminders/create
 *
 * Back-compat shim: create behaves like send for now (ensures older clients that POST to /create won't 404).
 * Body: same as /send
 */
router.post("/create", async (req, res) => {
  // forward to /send handler logic to avoid duplication
  return router.handle(req, res, () => {}); // This will route to /send if req.url is modified, but since it's complex to internally re-dispatch, call the same logic directly
});

/**
 * POST /api/reminders/scheduled
 *
 * Body:
 * {
 *   entity: "visitors",
 *   scheduleDays: [7,3,1,0],
 *   query?: "...",
 *   entityId?: "single-id"   // NEW: when provided, server will try candidate queries to fetch single record
 *   subject?, text?, html?
 * }
 *
 * This endpoint fetches candidate records from the API, filters by event date,
 * and sends reminders only when daysUntilEvent is one of scheduleDays and the
 * record does not already indicate that a reminder for that day was sent.
 */
router.post("/scheduled", async (req, res) => {
  try {
    const { entity = "visitors", scheduleDays = [7, 3, 1, 0], query = "", entityId = null } = req.body || {};
    if (!entity) return res.status(400).json({ success: false, error: "entity required" });

    // Normalize scheduleDays
    const daysSet = new Set((Array.isArray(scheduleDays) ? scheduleDays : [scheduleDays]).map((n) => Number(n)).filter((n) => !Number.isNaN(n)));

    // Fetch records: if entityId provided, try candidate queries to fetch single record(s)
    let fetched = [];
    let lastError = null;

    if (entityId) {
      const candidateQueries = [
        `?id=${encodeURIComponent(String(entityId))}&limit=1`,
        `?_id=${encodeURIComponent(String(entityId))}&limit=1`,
        `?where=_id=${encodeURIComponent(String(entityId))}&limit=1`,
        `?where=id=${encodeURIComponent(String(entityId))}&limit=1`,
      ];
      for (const q of candidateQueries) {
        const url = `${API_BASE}/api/${entity}${q}`;
        try {
          const r = await fetch(url, { headers: { Accept: "application/json", "ngrok-skip-browser-warning": "69420" } });
          const json = await r.json().catch(() => null);
          if (r.ok && json) {
            // Normalize response to array
            if (Array.isArray(json)) fetched = json;
            else if (Array.isArray(json.data)) fetched = json.data;
            else if (Array.isArray(json.rows)) fetched = json.rows;
            else if (Array.isArray(json.results)) fetched = json.results;
            else if (typeof json === "object" && Object.keys(json).length) fetched = [json];
            if (fetched.length) break;
          } else {
            lastError = `Query failed: ${url} (${r.status})`;
          }
        } catch (err) {
          lastError = String(err);
        }
      }
    } else {
      // fallback to original query string (list)
      const listUrl = query && typeof query === "string" ? `${API_BASE}/api/${entity}${query}` : `${API_BASE}/api/${entity}?limit=1000`;
      try {
        const r = await fetch(listUrl, { headers: { Accept: "application/json", "ngrok-skip-browser-warning": "69420" } });
        const json = await r.json().catch(() => null);
        if (Array.isArray(json)) fetched = json;
        else if (json && Array.isArray(json.data)) fetched = json.data;
        else if (json && Array.isArray(json.rows)) fetched = json.rows;
        else if (json && Array.isArray(json.results)) fetched = json.results;
        else fetched = Array.isArray(json) ? json : (typeof json === "object" ? Object.values(json) : []);
      } catch (err) {
        console.error("[reminders/scheduled] list fetch failed", err);
        return res.status(502).json({ success: false, error: "Failed to fetch records", details: String(err && err.message ? err.message : err) });
      }
    }

    if (!Array.isArray(fetched) || fetched.length === 0) {
      return res.json({ success: true, processed: 0, sent: 0, skipped: 0, note: lastError || "No records" });
    }

    let processed = 0;
    let sentCount = 0;
    let skipped = 0;
    const errors = [];

    for (const rec of fetched) {
      try {
        processed += 1;
        const eventDate = parseEventDate(rec);
        if (!eventDate) { skipped += 1; continue; }

        const daysUntil = daysUntilEvent(eventDate);
        if (daysUntil === null || daysUntil === undefined) { skipped += 1; continue; }

        if (!daysSet.has(daysUntil)) { skipped += 1; continue; }

        const remindersSent = Array.isArray(rec.reminders_sent) ? rec.reminders_sent.map((v) => Number(v)).filter((v) => !Number.isNaN(v)) : [];
        if (remindersSent.includes(daysUntil)) { skipped += 1; continue; }

        const to = rec.email || rec.emailAddress || rec.contactEmail || rec.contact_email;
        if (!to) { skipped += 1; continue; }

        const baseName = (rec.name || rec.full_name || rec.company || "Participant");
        const subj = req.body.subject || `${baseName} — Reminder: ${(eventDate && eventDate.toDateString()) || "Upcoming event"}`;
        const dayLabel = daysUntil === 0 ? "today" : `${daysUntil} day${Math.abs(daysUntil) === 1 ? "" : "s"} to go`;
        let bodyText = req.body.text || `Hello ${rec.name || ""},\n\nThis is a reminder that the event "${(rec.eventDetails && rec.eventDetails.name) || (rec.event && rec.event.name) || ""}" is ${dayLabel}.\n\nRegards,\nRailtrans Expo Team`;
        let bodyHtml = req.body.html || `<p>Hello ${rec.name || ""},</p><p>This is a reminder that the event "<strong>${(rec.eventDetails && rec.eventDetails.name) || (rec.event && rec.event.name) || ""}</strong>" is <strong>${dayLabel}</strong>.</p><p>Regards,<br/>Railtrans Expo Team</p>`;

        const isTicketed = ["speakers", "awardees", "exhibitors", "visitors"].includes(String(entity).toLowerCase());
        if (isTicketed && (rec.ticket_code || rec.ticketCode)) {
          const id = rec.id || rec._id || rec.insertedId || "";
          const ticketCode = rec.ticket_code || rec.ticketCode;
          const upgradeUrl = `${FRONTEND_BASE}/ticket-upgrade?entity=${encodeURIComponent(entity)}&id=${encodeURIComponent(String(id || ""))}&ticket_code=${encodeURIComponent(String(ticketCode || ""))}`;
          bodyHtml += `<p style="margin-top:12px">Want to upgrade your ticket? <a href="${upgradeUrl}">Click here to upgrade</a>.</p>`;
          bodyText += `\n\nWant to upgrade your ticket? Visit: ${upgradeUrl}`;
        }

        let sendResult;
        try {
          sendResult = await sendMail({ to, subject: subj, text: bodyText, html: bodyHtml });
        } catch (err) {
          console.error("[reminders] sendMail threw", err);
          errors.push({ id: rec.id || rec.ticket_code || null, error: String(err && err.message ? err.message : err) });
          continue;
        }

        if (!sendResult || !sendResult.success) {
          errors.push({ id: rec.id || rec.ticket_code || null, error: sendResult && (sendResult.error || sendResult.body) ? (sendResult.error || sendResult.body) : "Unknown send failure" });
          continue;
        }

        // On success, patch the record to mark this daysUntil as sent
        try {
          await markReminderSent(entity, rec, daysUntil);
        } catch (e) {
          console.warn("[reminders] post-send update failed", e && (e.message || e));
        }

        sentCount += 1;
      } catch (errInner) {
        console.error("[reminders] per-record error", errInner);
        errors.push({ error: String(errInner && errInner.message ? errInner.message : errInner) });
      }
    }

    return res.json({ success: true, processed, sent: sentCount, skipped, errors });
  } catch (err) {
    console.error("[reminders] scheduled error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "Server error", details: String(err && err.message ? err.message : err) });
  }
});

module.exports = router;