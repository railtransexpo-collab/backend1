/**
 * utils/dynamicReminder.js
 *
 * DYNAMIC REMINDER SYSTEM - Works for ALL entities
 *
 * Reads event date from DB config and calculates reminder days automatically.
 * Fixed reminder dates (June 26, 27, 29) are calculated RELATIVE to event date.
 */

/**
 * Calculate fixed reminder dates based on event date
 * Returns array of dates (June 26, 27, 29) in YYYY-MM-DD format
 * These are calculated as (eventDate.getMonth() === 6) ? June dates : default
 */
function getFixedReminderDatesFromEvent(eventDate) {
  if (!eventDate) return null;
  
  const event = new Date(eventDate);
  const year = event.getFullYear();
  const month = event.getMonth(); // June = 5, July = 6
  
  // If event is in July (month 6), then reminders are in June (month 5)
  if (month === 6) { // July
    return [
      new Date(year, 5, 26), // June 26
      new Date(year, 5, 27), // June 27
      new Date(year, 5, 29), // June 29
    ];
  }
  
  // Default: if event not in July, use same year but June dates
  return [
    new Date(year, 5, 26),
    new Date(year, 5, 27),
    new Date(year, 5, 29),
  ];
}

/**
 * Calculate days until event from today
 * Returns array of days from NOW to send reminders
 */
function calculateReminderDays(eventDateStr) {
  if (!eventDateStr) {
    console.log("[dynamicReminder] No event date, using fallback [10, 5, 2, 1, 0]");
    return [10, 5, 2, 1, 0];
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
    return [0];
  }

  const reminders = [];
  
  // Send reminders before event
  if (diffDays >= 10) reminders.push(diffDays - 10);
  if (diffDays >= 5) reminders.push(diffDays - 5);
  if (diffDays >= 2) reminders.push(diffDays - 2);
  if (diffDays >= 1) reminders.push(diffDays - 1);
  reminders.push(diffDays); // Event day

  if (reminders.length === 0) reminders.push(0);

  return reminders;
}

/**
 * Calculate days from today to fixed reminder dates (June 26, 27, 29)
 * These dates are calculated from the event date
 */
function calculateDaysToFixedDates(eventDateStr) {
  if (!eventDateStr) return [];
  
  const fixedDates = getFixedReminderDatesFromEvent(eventDateStr);
  if (!fixedDates || fixedDates.length === 0) return [];
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const scheduleDays = [];
  
  for (const reminderDate of fixedDates) {
    reminderDate.setHours(0, 0, 0, 0);
    const diffTime = reminderDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays >= 0) {
      scheduleDays.push(diffDays);
    }
  }
  
  return scheduleDays;
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

    // Check app_configs (your primary config system)
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

    return eventDate;
  } catch (e) {
    console.error("[dynamicReminder] Error getting event date:", e.message);
    return null;
  }
}

/**
 * MAIN FUNCTION: Schedule dynamic reminders for any entity
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

    // Normalize entity name
    const normalizedEntity = entity.endsWith("s") ? entity : `${entity}s`;

    const eventDate = await getEventDate(db);
    
    if (!eventDate) {
      console.log("[dynamicReminder] No event date found, cannot schedule reminders");
      return { ok: false, error: "No event date configured" };
    }
    
    // Get dynamic schedule days based on event date
    const dynamicScheduleDays = calculateReminderDays(eventDate);
    
    // Get fixed schedule days based on June 26, 27, 29 (calculated from event date)
    const fixedScheduleDays = calculateDaysToFixedDates(eventDate);
    
    // Get the actual fixed reminder dates for logging
    const fixedReminderDatesObj = getFixedReminderDatesFromEvent(eventDate);
    const fixedReminderDatesStr = fixedReminderDatesObj.map(d => 
      d.toISOString().split('T')[0]
    );
    
    // Combine both sets of reminders, remove duplicates, sort
    const allScheduleDays = [...new Set([...dynamicScheduleDays, ...fixedScheduleDays])].sort((a, b) => a - b);

    console.log(`[dynamicReminder] Scheduling for ${normalizedEntity}/${entityId}`);
    console.log(`[dynamicReminder] Event date from DB: ${eventDate}`);
    console.log(`[dynamicReminder] Fixed reminder dates (calculated): ${fixedReminderDatesStr.join(", ")}`);
    console.log(`[dynamicReminder] Dynamic days (before event): [${dynamicScheduleDays.join(", ")}]`);
    console.log(`[dynamicReminder] Fixed days from today: [${fixedScheduleDays.join(", ")}]`);
    console.log(`[dynamicReminder] Combined schedule days: [${allScheduleDays.join(", ")}]`);

    // Check if already scheduled
    const existingReminder = await db
      .collection("scheduled_reminders")
      .findOne({
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
        eventDate,
        fixedReminderDates: fixedReminderDatesStr,
      };
    }

    // Store scheduled reminder in DB
    await db.collection("scheduled_reminders").insertOne({
      entity: normalizedEntity,
      entityId: String(entityId),
      eventDate: new Date(eventDate),
      scheduleDays: allScheduleDays,
      dynamicScheduleDays,
      fixedScheduleDays,
      fixedReminderDates: fixedReminderDatesStr,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Calculate reminder dates for logging
    const today = new Date();
    const reminderDates = allScheduleDays.map((days) => {
      const date = new Date(today);
      date.setDate(date.getDate() + days);
      return date.toISOString().split("T")[0];
    });

    console.log(`[dynamicReminder] Scheduled: ${normalizedEntity}/${entityId}`);
    console.log(`[dynamicReminder] Reminder dates: ${reminderDates.join(", ")}`);

    return {
      ok: true,
      scheduleDays: allScheduleDays,
      dynamicScheduleDays,
      fixedScheduleDays,
      eventDate,
      reminderDates,
      fixedReminderDates: fixedReminderDatesStr,
    };
  } catch (e) {
    console.error("[dynamicReminder] Schedule error:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Schedule reminders for multiple entities at once
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
  getFixedReminderDatesFromEvent,
  calculateDaysToFixedDates,
};