/**
 * emailTemplate.js
 *
 * buildTicketEmail(... ) - email template builder for ticket delivery
 *
 * ✅ NO PDF ATTACHMENT - badge only via download button
 * ✅ Event details passed from caller (no fetch needed)
 * ✅ Professional responsive design
 * ✅ FIXED:  Download URLs use query params (? entity=visitors&id=xxx)
 * ✅ UPGRADE SUPPORT: Shows upgrade messaging when isUpgrade=true
 */

function getEventFromForm(form) {
  const out = { name: "", dates: "", time: "", venue: "", tagline: "" };
  if (!form || typeof form !== "object") return out;

  // Check for eventDetails object first
  if (form.eventDetails && typeof form.eventDetails === "object") {
    const ed = form.eventDetails;
    return {
      name: ed.name || "",
      dates: ed.dates || ed.date || "",
      time: ed.time || "",
      venue: ed.venue || "",
      tagline: ed.tagline || "",
    };
  }

  // Fallback to form-level fields
  out.name = form.eventName || form.event_name || form.eventTitle || "";
  out.dates = form.eventDates || form.event_dates || form.dates || form.date || "";
  out.time = form.eventTime || form.event_time || form.time || "";
  out.venue = form.eventVenue || form.event_venue || form.venue || "";
  out.tagline = form.eventTagline || form.tagline || "";

  return out;
}

function determineRoleLabel(visitor = {}, explicitTicketCategory = "") {
  if (explicitTicketCategory && String(explicitTicketCategory).trim()) {
    const c = String(explicitTicketCategory).trim().toLowerCase();
    if (c.includes("partner")) return "PARTNER";
    if (c.includes("award")) return "AWARDEE";
    if (/(delegate|vip|combo|paid)/i.test(c)) return "DELEGATE";
  }

  if (!visitor || typeof visitor !== "object") return "VISITOR";

  const ent = String(visitor.entity || visitor.role || visitor.type || "").toLowerCase();
  if (ent.includes("partner")) return "PARTNER";
  if (ent.includes("award")) return "AWARDEE";

  const total = Number(visitor.ticket_total || visitor.total || visitor.amount || visitor.price || 0) || 0;
  if (!Number.isNaN(total) && total > 0) return "DELEGATE";

  const cat = String(visitor.ticket_category || visitor.ticketCategory || visitor.category || "").toLowerCase();
  if (cat.includes("partner")) return "PARTNER";
  if (cat.includes("award")) return "AWARDEE";
  if (/(delegate|vip|combo|paid)/i.test(cat)) return "DELEGATE";

  if (visitor.isPartner || visitor.partner) return "PARTNER";
  if (visitor.isAwardee || visitor.awardee) return "AWARDEE";

  return "VISITOR";
}

function getParticipantTypeLabel(entity, roleLabel) {
  // Return appropriate label based on entity and role
  if (entity === "visitors" || roleLabel === "VISITOR") return "Visitor";
  if (roleLabel === "DELEGATE") return "Delegate";
  if (roleLabel === "PARTNER") return "Partner";
  if (roleLabel === "AWARDEE") return "Awardee";
  return "Participant";
}

async function buildTicketEmail({
  frontendBase = "",
  backendBase = "",
  entity = "attendee",
  id = "",
  name = "",
  company = "",
  ticket_category = "",
  badgePreviewUrl = "",
  downloadUrl = "",
  upgradeUrl = "",
  logoUrl = "",
  form = null,
  pdfBase64 = null,
} = {}) {
  form = { ...(form || {}), entity };
  if (!frontendBase || !backendBase) {
    throw new Error(
      "[emailTemplate] frontendBase and backendBase are REQUIRED"
    );
  }
  
  const effectiveFrontend = frontendBase.replace(/\/$/, "");
  const effectiveBackend = backendBase.replace(/\/$/, "");
  
  const resolvedDownload = downloadUrl
    ? downloadUrl
    : `${effectiveBackend}/api/tickets/download?entity=${encodeURIComponent(entity)}&id=${encodeURIComponent(id)}`;

  console.log("[emailTemplate] ========================================");
  console.log("[emailTemplate] Backend URL:", effectiveBackend);
  console.log("[emailTemplate] Frontend URL:", effectiveFrontend);
  console.log("[emailTemplate] Entity:", entity);
  console.log("[emailTemplate] ID:", id);

  // ✅ Use passed event details (no fetch)
  const ev = getEventFromForm(form);

  // Use default values if nothing provided
  if (!ev.name) ev.name = "6th RailTrans Expo 2026";
  if (!ev.dates) ev.dates = "3rd & 4th July 2026";
  if (!ev.time) ev.time = "";
  if (!ev.venue) ev.venue = "Bharat Mandapam, New Delhi";

  const resolvedLogo = logoUrl || "";
  const resolvedBadgePreview = badgePreviewUrl || "";
  let resolvedUpgrade = upgradeUrl || "";

  console.log("[emailTemplate] Download URL:", resolvedDownload);

  // ✅ Frontend upgrade URL
  if (!resolvedUpgrade) {
    const ticketCode = form?.ticket_code || "";
    resolvedUpgrade = `${effectiveFrontend}/ticket-upgrade?entity=${encodeURIComponent(entity)}&${id ? `id=${encodeURIComponent(String(id))}` : `ticket_code=${encodeURIComponent(ticketCode)}`}`;
  }

  // ✅ Check if this is an upgrade email
  const isUpgrade = form?.isUpgrade || false;
  const previousCategory = form?.previousCategory || null;

  const effectiveTicketCategory = ticket_category || (form && (form.ticket_category || form.category)) || "";
  const roleLabel = determineRoleLabel(form || {}, effectiveTicketCategory);
  const participantType = getParticipantTypeLabel(entity, roleLabel);

  console.log("[emailTemplate] Upgrade:", { isUpgrade, previousCategory, roleLabel });
  console.log("[emailTemplate] ========================================");

  // ✅ Dynamic subject based on registration type and upgrade status
  let subject;
  if (isUpgrade) {
    subject = `Registration Upgraded – ${participantType} E-Badge for 6th RailTrans Expo 2026`;
  } else {
    subject = `Registration Confirmed – ${participantType} E-Badge for 6th RailTrans Expo 2026`;
  }

  // ✅ Dynamic intro based on upgrade
  const introText = isUpgrade
    ? `Great news! Your registration has been successfully upgraded${previousCategory ? ` from ${previousCategory}` : ""} to ${participantType}.`
    : `Thank you for registering to ${roleLabel === "VISITOR" ? "visit" : "participate in"} the 6th Edition of RailTrans Expo 2026, scheduled to be held on 3rd & 4th July 2026 at Bharat Mandapam, New Delhi.`;

  // Build plain text version
  const text = [
    `Dear ${name || "Participant"},`,
    "",
    `Greetings from RailTrans Expo 2026!`,
    "",
    introText,
    "",
    `We are pleased to confirm your registration. Please find attached your ${participantType} e-Badge, which will enable your entry to the exhibition venue.`,
    "",
    isUpgrade ? `Previous Category: ${previousCategory}` : "",
    roleLabel ? `${isUpgrade ? "New " : ""}Registration Type: ${roleLabel}` : "",
    entity ? `Category: ${entity}` : "",
    company ? `Company: ${company}` : "",
    "",
    `Download your ${isUpgrade ? "updated " : ""}E-Badge: ${resolvedDownload}`,
    resolvedUpgrade ? `Upgrade your registration: ${resolvedUpgrade}` : "",
    "",
    "Event Details:",
    `Event: ${ev.name}`,
    `Dates: ${ev.dates}`,
    ...(ev.time ? [`Time: ${ev.time}`] : []),
    `Venue: ${ev.venue}`,
    "",
    "About the Event:",
    "RailTrans Expo 2026 is being hosted by Urban Infra Group in association with the Chamber of Railway Industries (Rail Chamber) and supported by the Ministry of Railways, Government of India. The event will bring together leading stakeholders from the railway, transportation, logistics, infrastructure, and semiconductor sectors from across India and around the world.",
    "",
    "Important Visitor Instructions:",
    "",
    "1. Entry for Foot Visitors",
    "   Entry for visitors arriving on foot will be provided through Gate No. 10 of Bharat Mandapam, which is the nearest gate from the Supreme Court Metro Station.",
    "",
    "2. Entry for Four-Wheelers",
    "   Entry for visitors arriving by four-wheelers will be provided through Gate No. 1 of Bharat Mandapam.",
    "",
    "3. E-Badge & Physical Badge Collection",
    "   All visitors are requested to show their e-Badge to the security personnel at the venue entry point.",
    "   The physical printed badge will be issued from the Registration Desk located at the main entrance of RailTrans Expo 2026.",
    "",
    "4. Mandatory Identity Proof",
    "   All visitors must carry a valid government-issued identity proof such as:",
    "   - Aadhaar Card",
    "   - Passport (mandatory for foreign nationals)",
    "   - Driving License / Voter ID (if applicable)",
    "",
    "5. Venue Protocols & Security Guidelines",
    "   All visitors are requested to strictly follow the protocols, safety guidelines, and operational norms prescribed by ITPO and the organizers of RailTrans Expo 2026.",
    "",
    "We look forward to welcoming you to Asia's leading exhibition and conference for the railway and transportation industry.",
    "",
    "For any assistance, please feel free to contact us at:",
    "support@railtransexpo.com",
    "Contact: +91 9211675505 / 8527599895",
    "www.railtransexpo.com",
    "",
    "Warm regards,",
    "Team RailTrans Expo 2026",
    "Urban Infra Group",
    "Bharat Mandapam, New Delhi",
    "3–4 July 2026",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
            color: #1f2937; 
            background: #f9fafb; 
            margin: 0; 
            padding: 0; 
            line-height: 1.6;
            -webkit-font-smoothing: antialiased; 
          }
          .container { 
            max-width: 680px; 
            margin: 40px auto; 
            background: #ffffff; 
            border-radius: 12px; 
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
          }
          .header { 
            text-align: center; 
            padding: 32px 24px 24px;
            background: linear-gradient(135deg, #0b4f60 0%, #19a6e7 100%);
          }
          .logo { 
            height: 80px; 
            width: auto; 
            object-fit: contain; 
            display: inline-block;
            background: white;
            padding: 12px 24px;
            border-radius: 8px;
          }
          .content { 
            padding: 32px 24px; 
          }
          .greeting { 
            font-size: 18px; 
            font-weight: 600; 
            color: #0b4f60; 
            margin-bottom: 16px; 
          }
          .intro { 
            color: #4b5563; 
            font-size: 15px; 
            line-height: 1.6; 
            margin-bottom: 24px; 
          }
          .upgrade-banner {
            margin: 16px 0;
            padding: 16px;
            background: #dcfce7;
            border-left: 4px solid #16a34a;
            border-radius: 6px;
          }
          .upgrade-banner-title {
            color: #166534;
            font-weight: 700;
            font-size: 16px;
            margin-bottom: 8px;
          }
          .upgrade-banner-text {
            color: #15803d;
            font-size: 14px;
          }
          .card { 
            background: #f1f5f9; 
            border-radius: 10px; 
            padding: 20px; 
            border: 1px solid #e2e8f0; 
            margin: 20px 0; 
          }
          .card-title { 
            font-weight: 700; 
            color: #0b4f60; 
            font-size: 17px; 
            margin-bottom: 12px; 
            text-align: center; 
          }
          .meta-row { 
            display: flex; 
            gap: 12px; 
            justify-content: center; 
            flex-wrap: wrap; 
            margin: 16px 0; 
          }
          .meta-badge { 
            background: #ffffff; 
            padding: 8px 16px; 
            border-radius: 6px; 
            border: 1px solid #cbd5e1; 
            color: #475569; 
            font-size: 13px; 
            font-weight: 500;
          }
          .meta-badge-upgraded {
            background: #dcfce7;
            color: #166534;
            border-color: #86efac;
          }
          .button-row { 
            display: flex; 
            gap: 16px; 
            align-items: center; 
            justify-content: center; 
            margin-top: 24px; 
            flex-wrap: wrap; 
          }
          
          /* ✅ RED DOWNLOAD BUTTON (Primary Action) */
          .cta { 
            display: inline-block; 
            padding: 16px 32px; 
            background: #dc2626 !important;
            color: #ffffff !important; 
            text-decoration: none !important; 
            border-radius: 8px; 
            font-weight: 700; 
            font-size: 16px;
            border: none;
            box-shadow: 0 4px 6px rgba(220, 38, 38, 0.3);
            transition: all 0.3s ease;
            text-align: center;
            min-width: 200px;
          }
          .cta:hover {
            background: #b91c1c !important;
            box-shadow: 0 6px 8px rgba(220, 38, 38, 0.4);
            transform: translateY(-2px);
          }
          
          /* ✅ BLUE UPGRADE BUTTON (Secondary Action) */
          .cta-outline { 
            display: inline-block; 
            padding: 16px 32px; 
            background: #2563eb !important;
            color: #ffffff !important; 
            text-decoration: none !important; 
            border-radius: 8px; 
            font-weight: 700; 
            font-size: 16px;
            border: none;
            box-shadow: 0 4px 6px rgba(37, 99, 235, 0.3);
            transition: all 0.3s ease;
            text-align: center;
            min-width: 200px;
          }
          .cta-outline:hover {
            background: #1d4ed8 !important;
            box-shadow: 0 6px 8px rgba(37, 99, 235, 0.4);
            transform: translateY(-2px);
          }
          
          .section { 
            margin-top: 28px; 
          }
          .section-title { 
            margin: 0 0 12px 0; 
            color: #0b4f60; 
            font-size: 16px;
            font-weight: 700;
            border-bottom: 2px solid #e2e8f0;
            padding-bottom: 8px;
          }
          .info-row { 
            display: flex; 
            margin-bottom: 10px; 
            align-items: flex-start; 
          }
          .info-label { 
            width: 120px; 
            color: #64748b; 
            font-weight: 600; 
            font-size: 14px;
          }
          .info-value { 
            color: #1f2937; 
            flex: 1;
            font-size: 14px;
          }
          .about-section {
            margin-top: 24px;
            background: #f0f9ff;
            border: 1px solid #bae6fd;
            border-radius: 8px;
            padding: 20px;
          }
          .about-title {
            color: #0c4a6e;
            font-weight: 700;
            font-size: 16px;
            margin-bottom: 12px;
          }
          .about-text {
            color: #075985;
            font-size: 14px;
            line-height: 1.6;
          }
          .guidelines { 
            margin-top: 28px; 
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 16px 20px;
            border-radius: 6px;
          }
          .guidelines-title { 
            margin: 0 0 12px 0; 
            color: #92400e; 
            font-size: 16px;
            font-weight: 700;
          }
          .guidelines ol { 
            padding-left: 20px; 
            color: #78350f; 
            margin: 0;
            font-size: 14px;
            counter-reset: item;
          }
          .guidelines ol li {
            margin-bottom: 12px;
            display: block;
          }
          .guidelines ol li strong {
            color: #92400e;
            display: block;
            margin-bottom: 4px;
          }
          .guidelines ul {
            padding-left: 20px;
            color: #78350f;
            margin: 4px 0 0 0;
            font-size: 13px;
            list-style-type: disc;
          }
          .guidelines ul li {
            margin-bottom: 4px;
          }
          .footer { 
            margin-top: 32px; 
            padding-top: 24px;
            border-top: 1px solid #e5e7eb;
            color: #6b7280; 
            font-size: 13px; 
            text-align: center; 
          }
          .footer a {
            color: #0b4f60;
            text-decoration: none;
          }
          .contact-info {
            margin-top: 16px;
            padding: 16px;
            background: #f8fafc;
            border-radius: 8px;
            text-align: center;
          }
          .contact-info p {
            margin: 4px 0;
            color: #475569;
          }
          
          /* Mobile Responsive */
          @media (max-width: 600px) {
            .container { margin: 20px 12px; }
            .content { padding: 24px 16px; }
            .logo { height: 60px; padding: 8px 16px; }
            .button-row { 
              flex-direction: column; 
              width: 100%; 
              gap: 12px;
            }
            .cta, .cta-outline { 
              width: 100%; 
              min-width: auto;
              box-sizing: border-box; 
            }
            .info-label { width: 100px; font-size: 13px; }
            .info-value { font-size: 13px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            ${resolvedLogo ? `<img src="${resolvedLogo}" alt="RailTrans Expo Logo" class="logo" />` : `<div style="color: white; font-size: 24px; font-weight: bold;">RailTrans Expo 2026</div>`}
          </div>
    
          <div class="content">
            <div class="greeting">Dear ${name || "Participant"},</div>
    
            <p class="intro">
              <strong>Greetings from RailTrans Expo 2026!</strong><br/><br/>
              ${isUpgrade
                ? `Great news! Your registration has been successfully upgraded${previousCategory ? ` from <strong>${previousCategory}</strong>` : ""} to <strong>${participantType}</strong>.`
                : `Thank you for registering to ${roleLabel === "VISITOR" ? "visit" : "participate in"} the <strong>6th Edition of RailTrans Expo 2026</strong>, scheduled to be held on <strong>3rd & 4th July 2026 at Bharat Mandapam, New Delhi</strong>.`
              }
            </p>
    
            ${isUpgrade ? `
            <div class="upgrade-banner">
              <div class="upgrade-banner-title">✅ Upgrade Successful!</div>
              <div class="upgrade-banner-text">
                Previous: ${previousCategory} → New: ${participantType}
              </div>
            </div>
            ` : ""}
    
            <p style="color: #4b5563; font-size: 15px;">
              We are pleased to confirm your registration. Please find attached your <strong>${participantType} e-Badge</strong>, which will enable your entry to the exhibition venue.
            </p>
    
            <div class="card">
              <div class="card-title">${name || "Participant"}${company ? ` • ${company}` : ""}</div>
    
              <div class="meta-row">
                ${roleLabel ? `<div class="meta-badge">${roleLabel}</div>` : ""}
                ${isUpgrade ? `<div class="meta-badge meta-badge-upgraded">UPGRADED</div>` : ""}
              </div>
    
              ${resolvedBadgePreview ? `<div style="margin-top: 16px; text-align: center;"><img src="${resolvedBadgePreview}" alt="E-badge preview" style="max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #e2e8f0;"/></div>` : ""}
    
              <div class="button-row">
                <a href="${resolvedDownload}" class="cta" target="_blank" rel="noopener noreferrer">
                  📥 Download ${participantType} E-Badge
                </a>
                ${resolvedUpgrade ? `<a href="${resolvedUpgrade}" class="cta-outline" target="_blank" rel="noopener noreferrer">⬆️ Upgrade Registration</a>` : ""}
              </div>
            </div>
    
            <div class="about-section">
              <div class="about-title">About RailTrans Expo 2026</div>
              <p class="about-text">
                RailTrans Expo 2026 is being hosted by <strong>Urban Infra Group</strong> in association with the <strong>Chamber of Railway Industries (Rail Chamber)</strong> and supported by the <strong>Ministry of Railways, Government of India</strong>. The event will bring together leading stakeholders from the railway, transportation, logistics, infrastructure, and semiconductor sectors from across India and around the world.
              </p>
            </div>
    
            <div class="section">
              <h4 class="section-title">📅 Event Information</h4>
              <div class="info-row">
                <div class="info-label">Event:</div>
                <div class="info-value"><strong>${ev.name}</strong></div>
              </div>
              <div class="info-row">
                <div class="info-label">Dates:</div>
                <div class="info-value"><strong>${ev.dates}</strong></div>
              </div>
              ${ev.time ? `
              <div class="info-row">
                <div class="info-label">Time:</div>
                <div class="info-value">${ev.time}</div>
              </div>
              ` : ""}
              <div class="info-row">
                <div class="info-label">Venue:</div>
                <div class="info-value"><strong>${ev.venue}</strong></div>
              </div>
            </div>
    
            <div class="guidelines">
              <h4 class="guidelines-title">⚠️ Important Visitor Instructions</h4>
              <ol>
                <li>
                  <strong>Entry for Foot Visitors</strong>
                  Entry for visitors arriving on foot will be provided through <strong>Gate No. 10 of Bharat Mandapam</strong>, which is the nearest gate from the <strong>Supreme Court Metro Station</strong>.
                </li>
                <li>
                  <strong>Entry for Four-Wheelers</strong>
                  Entry for visitors arriving by four-wheelers will be provided through <strong>Gate No. 1 of Bharat Mandapam</strong>.
                </li>
                <li>
                  <strong>Visitor e-Badge & Physical Badge Collection</strong>
                  All visitors are requested to show their <strong>Visitor e-Badge</strong> to the security personnel at the venue entry point.
                  <br/>The <strong>physical printed Visitor Badge</strong> will be issued from the <strong>Registration Desk</strong> located at the main entrance of RailTrans Expo 2026.
                </li>
                <li>
                  <strong>Mandatory Identity Proof</strong>
                  All visitors must carry a valid government-issued identity proof such as:
                  <ul>
                    <li>Aadhaar Card</li>
                    <li>Passport (mandatory for foreign nationals)</li>
                    <li>Driving License / Voter ID (if applicable)</li>
                  </ul>
                </li>
                <li>
                  <strong>Venue Protocols & Security Guidelines</strong>
                  All visitors are requested to strictly follow the protocols, safety guidelines, and operational norms prescribed by <strong>ITPO</strong> and the organizers of <strong>RailTrans Expo 2026</strong>.
                </li>
              </ol>
            </div>
    
            <div class="footer">
              <p style="font-size: 15px; color: #1f2937;">We look forward to welcoming you to <strong>Asia's leading exhibition and conference for the railway and transportation industry</strong>.</p>
              
              <div class="contact-info">
                <p style="font-weight: 600; color: #0b4f60;">For any assistance, please feel free to contact us at:</p>
                <p>📧 <a href="mailto:support@railtransexpo.com" style="color: #0b4f60; font-weight: 600;">support@railtransexpo.com</a></p>
                <p>📞 Contact: +91 9211675505 / 8527599895</p>
                <p>🌐 <a href="https://www.railtransexpo.com" target="_blank" rel="noopener noreferrer" style="color: #0b4f60; font-weight: 600;">www.railtransexpo.com</a></p>
              </div>
              
              <p style="margin-top: 20px;">
                <strong>Warm regards,</strong><br/>
                <strong>Team RailTrans Expo 2026</strong><br/>
                Urban Infra Group<br/>
                Bharat Mandapam, New Delhi<br/>
                3–4 July 2026
              </p>
            </div>
          </div>
        </div>
      </body>
    </html>`;

  const attachments = [];

  return { subject, text, html, attachments };
}

module.exports = { buildTicketEmail };