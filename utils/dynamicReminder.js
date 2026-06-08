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

  console.log(
    `[dynamicReminder] Event: ${eventDateStr}, Days until: ${diffDays}`,
  );

  if (diffDays <= 0) {
    return [0]; // Event today/past → send immediately
  }

  const reminders = [];
  if (diffDays >= 2) reminders.push(diffDays - 2); // 2 days before
  if (diffDays >= 1) reminders.push(diffDays - 1); // 1 day before
  if (diffDays > 0) reminders.push(diffDays); // Event day

  if (reminders.length === 0) reminders.push(0);

  return reminders;
}

/**
 * Get event date from database (checks multiple locations)
 */
async function getEventDate(db) {
  try {
    if (!db) {
      console.log("[dynamicReminder] No database connection");
      return null;
    }

    let eventDate = null;

    // ✅ NEW: Check app_configs (your primary config system)
    try {
      const appConfig = await db.collection("app_configs").findOne({
        key: "event-details",
      });
      if (appConfig && appConfig.value) {
        const date = appConfig.value.date || appConfig.value.dates;
        if (date) {
          eventDate = date;
          console.log(
            "[dynamicReminder] Found event date in app_configs:",
            eventDate,
          );
        }
      }
    } catch (e) {
      console.warn("[dynamicReminder] Error checking app_configs:", e.message);
    }

    // Fallback 1: registration_configs with page="event-details"
    if (!eventDate) {
      try {
        const config = await db.collection("registration_configs").findOne({
          page: "event-details",
        });
        if (config) {
          const val = config.value || config.config || config;
          const date = val?.date || val?.dates;
          if (date) {
            eventDate = date;
            console.log(
              "[dynamicReminder] Found event date in registration_configs:",
              eventDate,
            );
          }
        }
      } catch (e) {
        console.warn(
          "[dynamicReminder] Error checking registration_configs:",
          e.message,
        );
      }
    }

    // Fallback 2: configs collection
    if (!eventDate) {
      try {
        const eventConfig = await db.collection("configs").findOne({
          key: "event-details",
        });
        if (eventConfig) {
          const val = eventConfig.value || eventConfig.config || eventConfig;
          const date = val?.date || val?.dates;
          if (date) {
            eventDate = date;
            console.log(
              "[dynamicReminder] Found event date in configs:",
              eventDate,
            );
          }
        }
      } catch (e) {
        console.warn("[dynamicReminder] Error checking configs:", e.message);
      }
    }

    // Fallback 3: event_details collection
    if (!eventDate) {
      try {
        const eventDoc = await db.collection("event_details").findOne({});
        if (eventDoc) {
          const date = eventDoc?.date || eventDoc?.dates;
          if (date) {
            eventDate = date;
            console.log(
              "[dynamicReminder] Found event date in event_details:",
              eventDate,
            );
          }
        }
      } catch (e) {
        console.warn(
          "[dynamicReminder] Error checking event_details:",
          e.message,
        );
      }
    }

    // Last resort: use environment variable
    if (!eventDate) {
      const envDate = process.env.EVENT_DATE;
      if (envDate) {
        eventDate = envDate;
        console.log("[dynamicReminder] Using event date from env:", eventDate);
      }
    }

    // Ultimate fallback (July 3rd 2026)
    if (!eventDate) {
      eventDate = "2026-07-03";
      console.log(
        "[dynamicReminder] No event date found, using default:",
        eventDate,
      );
    }

    return eventDate;
  } catch (e) {
    console.error("[dynamicReminder] Error getting event date:", e.message);
    return "2026-07-03"; // Return default on error
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
    const normalizedEntity = entity.endsWith("s") ? entity : `${entity}s`;

    const eventDate = await getEventDate(db);
    const scheduleDays = calculateReminderDays(eventDate);

    console.log(
      `[dynamicReminder] Scheduling for ${normalizedEntity}/${entityId}`,
    );
    console.log(
      `[dynamicReminder] Days: [${scheduleDays}], Event: ${eventDate || "unknown"}`,
    );

    // Check if already scheduled
    const existingReminder = await db
      .collection("scheduled_reminders")
      .findOne({
        entity: normalizedEntity,
        entityId: String(entityId),
        status: "pending",
      });

    if (existingReminder) {
      console.log(
        `[dynamicReminder] Already scheduled for ${normalizedEntity}/${entityId}`,
      );
      return {
        ok: true,
        alreadyScheduled: true,
        scheduleDays: existingReminder.scheduleDays,
        eventDate,
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
    const reminderDates = scheduleDays.map((days) => {
      const date = new Date(today);
      date.setDate(date.getDate() + days);
      return date.toISOString().split("T")[0];
    });

    console.log(
      `[dynamicReminder] ✅ Scheduled: ${normalizedEntity}/${entityId}`,
    );
    console.log(
      `[dynamicReminder] Reminder dates: ${reminderDates.join(", ")}`,
    );

    return {
      ok: true,
      scheduleDays,
      eventDate,
      reminderDates,
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
