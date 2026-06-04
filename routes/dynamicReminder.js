/**
 * utils/dynamicReminder.js
 * 
 * DYNAMIC REMINDER SYSTEM - Works for ALL entities
 * 
 * Reads event date from DB config and calculates reminder days automatically.
 * Call scheduleDynamicReminder() after successful registration/payment.
 * 
 * No hardcoded dates - just update event date in admin panel.
 */

/**
 * Calculate days until event from today
 * Returns array of days from NOW to send reminders
 */
function calculateReminderDays(eventDateStr) {
  if (!eventDateStr) {
    console.log("[dynamicReminder] No event date, using fallback [2, 1, 0]");
    return [2, 1, 0];
  }

  const eventDate = new Date(eventDateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  eventDate.setHours(0, 0, 0, 0);

  const diffTime = eventDate.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  console.log(`[dynamicReminder] Event: ${eventDateStr}, Days until: ${diffDays}`);

  if (diffDays <= 0) {
    return [0]; // Event today/past → send immediately
  }

  const reminders = [];
  if (diffDays >= 2) reminders.push(diffDays - 2); // 2 days before
  if (diffDays >= 1) reminders.push(diffDays - 1); // 1 day before
  if (diffDays > 0) reminders.push(diffDays);       // Event day

  if (reminders.length === 0) reminders.push(0);

  return reminders;
}

/**
 * Get event date from database (checks multiple locations)
 */
async function getEventDate(db) {
  try {
    // Location 1: registration_configs
    const config = await db.collection("registration_configs").findOne({
      $or: [{ page: "event-details" }, { key: "event-details" }]
    });
    if (config) {
      const val = config.value || config.config || config;
      if (val && (val.date || val.dates)) {
        const date = val.date || val.dates;
        console.log("[dynamicReminder] Found event date in registration_configs:", date);
        return date;
      }
    }

    // Location 2: configs collection
    const eventConfig = await db.collection("configs").findOne({
      $or: [{ key: "event-details" }, { page: "event-details" }]
    });
    if (eventConfig) {
      const val = eventConfig.value || eventConfig.config || eventConfig;
      if (val && (val.date || val.dates)) {
        const date = val.date || val.dates;
        console.log("[dynamicReminder] Found event date in configs:", date);
        return date;
      }
    }

    // Location 3: event_details collection
    const eventDoc = await db.collection("event_details").findOne({});
    if (eventDoc && (eventDoc.date || eventDoc.dates)) {
      const date = eventDoc.date || eventDoc.dates;
      console.log("[dynamicReminder] Found event date in event_details:", date);
      return date;
    }

    console.log("[dynamicReminder] No event date found in database");
    return null;
  } catch (e) {
    console.error("[dynamicReminder] Error getting event date:", e.message);
    return null;
  }
}

/**
 * ✅ MAIN FUNCTION: Schedule dynamic reminders for any entity
 * 
 * @param {Object} db - MongoDB database instance
 * @param {string} entity - "visitors" | "exhibitors" | "partners" | "speakers" | "awardees"
 * @param {string|ObjectId} entityId - Entity's _id or ticket_code
 * @returns {Object} { ok: boolean, scheduleDays: number[], eventDate: string|null }
 */
async function scheduleDynamicReminder(db, entity, entityId) {
  try {
    if (!db || !entity || !entityId) {
      console.log("[dynamicReminder] Missing params:", { entity, entityId });
      return { ok: false, error: "Missing params" };
    }

    // Normalize entity name (remove trailing 's' if present)
    const normalizedEntity = entity.endsWith('s') ? entity : `${entity}s`;

    const eventDate = await getEventDate(db);
    const scheduleDays = calculateReminderDays(eventDate);

    console.log(`[dynamicReminder] Scheduling for ${normalizedEntity}/${entityId}`);
    console.log(`[dynamicReminder] Days: [${scheduleDays}], Event: ${eventDate || "unknown"}`);

    // Check if already scheduled
    const existingReminder = await db.collection("scheduled_reminders").findOne({
      entity: normalizedEntity,
      entityId: String(entityId),
      status: "pending",
    });

    if (existingReminder) {
      console.log(`[dynamicReminder] Already scheduled for ${normalizedEntity}/${entityId}`);
      return { 
        ok: true, 
        alreadyScheduled: true, 
        scheduleDays: existingReminder.scheduleDays,
        eventDate 
      };
    }

    // Store scheduled reminder in DB
    await db.collection("scheduled_reminders").insertOne({
      entity: normalizedEntity,
      entityId: String(entityId),
      eventDate: eventDate ? new Date(eventDate) : null,
      scheduleDays,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Calculate reminder dates for logging
    const today = new Date();
    const reminderDates = scheduleDays.map(days => {
      const date = new Date(today);
      date.setDate(date.getDate() + days);
      return date.toISOString().split('T')[0];
    });

    console.log(`[dynamicReminder] ✅ Scheduled: ${normalizedEntity}/${entityId}`);
    console.log(`[dynamicReminder] Reminder dates: ${reminderDates.join(', ')}`);

    return { 
      ok: true, 
      scheduleDays, 
      eventDate,
      reminderDates 
    };

  } catch (e) {
    console.error("[dynamicReminder] Schedule error:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * ✅ Schedule reminders for multiple entities at once
 */
async function scheduleRemindersForAll(db, entities = []) {
  const results = [];
  
  for (const { entity, entityId } of entities) {
    const result = await scheduleDynamicReminder(db, entity, entityId);
    results.push({ entity, entityId, ...result });
  }

  return results;
}

module.exports = {
  scheduleDynamicReminder,
  scheduleRemindersForAll,
  calculateReminderDays,
  getEventDate,
};