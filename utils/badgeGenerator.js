// badgeGenerator.js — RailTrans Expo 2026
"use strict";
const fs = require("fs");
const path = require("path");
const PDF = require("pdfkit");
const QRCode = require("qrcode");
const getBadgeTheme = require("./badgeTheme");
const C = require("./badgeConfig");

// QR Code cache for faster generation
const qrCache = new Map();

async function getCachedQR(text, size) {
  const key = `${text}_${size}`;
  if (qrCache.has(key)) return qrCache.get(key);

  const qrDataUrl = await QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 0,
    width: size,
  });

  const buffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

  if (qrCache.size > 50) {
    qrCache.clear();
  }

  qrCache.set(key, buffer);
  return buffer;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function safeImage(doc, filePath, x, y, width, extraOpts = {}) {
  if (!filePath) return false;
  const candidates = [
    filePath,
    path.join(process.cwd(), filePath),
    path.join(__dirname, "..", "assets", "logos", path.basename(filePath)),
    path.join(__dirname, "..", "assets", "bg", path.basename(filePath)),
    path.join(__dirname, "assets", "logos", path.basename(filePath)),
    path.join(__dirname, "assets", "bg", path.basename(filePath)),
    path.join(
      process.cwd(),
      "public",
      "assets",
      "logos",
      path.basename(filePath),
    ),
    "C:\\Users\\Jaya Singh\\Demo\\backend\\assets\\logos\\" +
      path.basename(filePath),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        doc.image(p, x, y, { width, ...extraOpts });
        return true;
      } catch (_) {}
    }
  }
  console.warn(`⚠️  Image not found: ${path.basename(filePath)}`);
  return false;
}

function roundedRect(doc, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  doc
    .moveTo(x + r, y)
    .lineTo(x + w - r, y)
    .quadraticCurveTo(x + w, y, x + w, y + r)
    .lineTo(x + w, y + h - r)
    .quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    .lineTo(x + r, y + h)
    .quadraticCurveTo(x, y + h, x, y + h - r)
    .lineTo(x, y + r)
    .quadraticCurveTo(x, y, x + r, y)
    .closePath();
}

function drawPill(
  doc,
  text,
  x,
  y,
  bgColor,
  textColor,
  fontSize,
  padding = 14,
  height = 16,
) {
  doc.font("Helvetica-Bold").fontSize(fontSize);
  const tw = doc.widthOfString(text);
  const pw = tw + padding * 2;
  roundedRect(doc, x, y, pw, height, height / 2);
  doc.fill(bgColor);
  doc
    .fillColor(textColor)
    .font("Helvetica-Bold")
    .fontSize(fontSize)
    .text(text, x, y + (height - fontSize) / 2 + 1, {
      width: pw,
      align: "center",
      lineBreak: false,
      ellipsis: false,
    });
}

function drawSquarePill(
  doc,
  text,
  x,
  y,
  w,
  h,
  bgColor,
  textColor,
  fontSize,
  radius = 6,
) {
  roundedRect(doc, x, y, w, h, radius);
  doc.fill(bgColor);
  doc
    .fillColor(textColor)
    .font("Helvetica-Bold")
    .fontSize(fontSize)
    .text(text, x, y + (h - fontSize) / 2 + 1, {
      width: w,
      align: "center",
      lineBreak: false,
    });
}

// ── Sections ──────────────────────────────────────────────────────────────────

function drawHeader(doc) {
  const H = C.HEADER;
  const dp = C.DATE_PILLS;

  doc.rect(0, H.y, C.PAGE.width, H.height).fill(H.bgColor);

  // RailTrans logo — left
  safeImage(
    doc,
    C.RAILTRANS_LOGO.path,
    C.RAILTRANS_LOGO.x,
    C.RAILTRANS_LOGO.y,
    C.RAILTRANS_LOGO.width,
  );

  // Date squares "03" "04"
  if (dp?.pill1?.text) {
    drawSquarePill(
      doc,
      dp.pill1.text,
      dp.pill1.x,
      dp.pill1.y,
      dp.pill1.width,
      dp.pill1.height,
      dp.pill1.bgColor,
      dp.pill1.textColor,
      dp.pill1.fontSize,
    );
  }
  if (dp?.pill2?.text) {
    drawSquarePill(
      doc,
      dp.pill2.text,
      dp.pill2.x,
      dp.pill2.y,
      dp.pill2.width,
      dp.pill2.height,
      dp.pill2.bgColor,
      dp.pill2.textColor,
      dp.pill2.fontSize,
    );
  }

  // "JULY" then "2026" — to right of date squares (no overlap with Mandapam)
  const mandapamLeftEdge = Number(C?.MANDAPAM?.x);
  const rightLimit = Number.isFinite(mandapamLeftEdge)
    ? mandapamLeftEdge - 10
    : C.PAGE.width - 8;
  const monthMaxWidth = 120;

  const monthBlockY = dp.monthY;

  const monthBlockWidth = 80;

  // CENTER BETWEEN DATE PILLS AND MANDAPAM LOGO
  const datesRight = dp.pill2.x + dp.pill2.width;
  const mandapamLeft = C.MANDAPAM.x;

  const monthBlockX =
    datesRight + (mandapamLeft - datesRight - monthBlockWidth) / 2;

  doc
    .fillColor("#000000")
    .font("Helvetica-Bold")
    .fontSize(19)
    .text("JULY", monthBlockX, 28, {
      width: monthBlockWidth,
      align: "center",
      lineBreak: false,
    });

  doc
    .fillColor("#000000")
    .font("Helvetica-Bold")
    .fontSize(19)
    .text("2026", monthBlockX, 56, {
      width: monthBlockWidth,
      align: "center",
      lineBreak: false,
    });
  // Bharat Mandapam logo — top-right
  safeImage(doc, C.MANDAPAM.path, C.MANDAPAM.x, C.MANDAPAM.y, C.MANDAPAM.width);

  // Venue — 2 lines under Mandapam logo (explicit Y; no overlap)
  const mt = C.MANDAPAM_TEXT || {};
  const venueX = Number(C?.MANDAPAM?.x) || (dp?.monthX ?? 0);
  const venueW =
    Number(C?.MANDAPAM?.width) || Math.max(40, rightLimit - (dp?.monthX ?? 0));

  const baseY = Number(mt.y) || (dp?.venueY ?? 0);

  doc
    .fillColor(mt.color || "#555555")
    .font("Helvetica-Bold")
    .fontSize(mt.fontSizeLine1 || 8.2)
    .text(mt.line1 || "BHARAT MANDAPAM", venueX, baseY, {
      width: venueW,
      align: "center",
      lineBreak: false,
    });

  const line1H = doc.heightOfString(mt.line1 || "BHARAT MANDAPAM", {
    width: venueW,
    align: "center",
  });
  // "NEW DELHI, INDIA" should be below and in same font style
  doc
    .fillColor(mt.color || "#555555")
    .font("Helvetica-Bold")
    .fontSize(mt.fontSizeLine2 || 8.2)
    .text(
      mt.line2 || "NEW DELHI, INDIA",
      venueX,
      baseY + line1H + (Number(mt.lineGap) || 0.5),
      {
        width: venueW,
        align: "center",
        lineBreak: false,
      },
    );
}

function drawTagline(doc) {
  const tg = C.TAGLINE;
  doc.rect(0, tg.y, C.PAGE.width, tg.height).fill(tg.bgColor);

  doc.font("Helvetica-Bold").fontSize(tg.fontSize);
  const tw = doc.widthOfString(tg.text);
  const pw = Math.min(tw + 40, C.PAGE.width - 20);
  const ph = 18;
  const px = (C.PAGE.width - pw) / 2;
  const py = tg.y + (tg.height - ph) / 2;

  roundedRect(doc, px, py, pw, ph, 9);
  doc.fillAndStroke(tg.pillBgColor, tg.pillBorderColor);

  doc
    .fillColor(tg.textColor)
    .font("Helvetica-Bold")
    .fontSize(tg.fontSize)
    .text(tg.text, px + 10, py + (ph - tg.fontSize) / 2 + 1, {
      width: pw - 20,
      align: "center",
      lineBreak: false,
    });
}

function drawBodyBackground(doc) {
  const bodyH = C.RIBBON.y - C.BODY.startY;
  doc.rect(0, C.BODY.startY, C.PAGE.width, bodyH).fill(C.BODY.bgColor);
  safeImage(doc, C.BODY.bgImage, 0, C.BODY.startY, C.PAGE.width, {
    height: bodyH,
  });

  // White overlay
  doc.save();
  doc.opacity(C.BODY.overlayOpacity / 255);
  doc.rect(0, C.BODY.startY, C.PAGE.width, bodyH).fill("#FFFFFF");
  doc.restore();
}

async function drawQRCard(doc, ticketCode, entity, mode, name, company) {
  const qc = C.QR_CARD;

  // Generate QR code with larger size
  const qrPayload =
    mode === "scan"
      ? ticketCode
      : JSON.stringify({ ticket_code: ticketCode, entity });
  const qrBuf = await getCachedQR(qrPayload, C.QR.size * 2);

  const qrX = qc.x + (qc.width - C.QR.size) / 2;
  const qrY = qc.y + 20; // Adjusted for larger QR
  doc.image(qrBuf, qrX, qrY, { width: C.QR.size });

  // Calculate text starting position
  const textStartY = qrY + C.QR.size + (Number(C?.TEXT_AREA?.gapAfterQr) || 15);

  // Draw NAME - BOLDER AND BIGGER
  doc
    .fillColor("#000")
    .font("Helvetica-Bold")
    .fontSize(C.TEXT_AREA.nameFontSize);

  // Calculate name height
  const nameHeight = doc.heightOfString(name, {
    width: qc.width - 30,
    align: "center",
  });

  doc.text(name, qc.x + 15, textStartY, {
    width: qc.width - 30,
    align: "center",
  });

  // Draw COMPANY - BOLDER AND BIGGER
  if (
    company &&
    company.trim() !== "" &&
    company !== "UNDEFINED" &&
    company !== "NULL"
  ) {
    doc
      .fillColor("#333") // Darker for better contrast
      .font("Helvetica-Bold") // Make company bold too
      .fontSize(C.TEXT_AREA.companyFontSize);

    const companyY = textStartY + nameHeight + 2;

    doc.text(company, qc.x + 15, companyY, {
      width: qc.width - 30,
      align: "center",
      lineBreak: true,
    });
  }
}

function drawFooter(doc) {
  const org = C.ORGANISED_BY;
  const centerX = C.PAGE.width / 2;

  doc.font("Helvetica-Bold").fontSize(org.labelFontSize);
  const labelWidth = doc.widthOfString(org.label) + 50;

  const labelX = centerX - labelWidth / 2;
  const labelY = 412;

  drawPill(
    doc,
    org.label,
    labelX,
    labelY,
    org.labelBgColor,
    org.labelTextColor,
    org.labelFontSize,
    22,
    20,
  );

  // LOGO (perfect center + spacing)
  const logoWidth = 120;
  const logoX = centerX - logoWidth / 2;
  const logoY = labelY + 22;

  safeImage(doc, org.logoPath, logoX, logoY, logoWidth);
}

function drawRibbon(doc, themeColor, ribbonLabel) {
  const R = C.RIBBON;

  doc.rect(0, R.y, C.PAGE.width, R.height).fill(themeColor);

  roundedRect(doc, 0, R.y, C.PAGE.width, R.height, R.borderRadius);
  doc.fill(themeColor);

  const textY = R.y + (R.height - R.textSize) / 2;

  doc
    .fillColor(R.textColor)
    .opacity(1)
    .font("Helvetica-Bold")
    .fontSize(R.textSize)
    .text(ribbonLabel, 0, textY, {
      align: "center",
      width: C.PAGE.width,
    });
}

async function generateScanBadgePDF(data) {
  return new Promise(async (resolve, reject) => {
    try {
      const ticketCode =
        data?.ticket_code || data?.ticketCode || data?.data?.ticket_code;
      if (!ticketCode) throw new Error("ticket_code missing");

      const name =
        (data.name || data.full_name || data.fullName || "")
          .trim()
          .toUpperCase() || "GUEST";

      let company = (
        data.company ||
        data.organization ||
        data.companyName ||
        ""
      )
        .trim()
        .toUpperCase();
      if (company === "NULL" || company === "UNDEFINED") company = "";

      const W = 220;
      const H = 300;

      // Enable compression for faster delivery
      const doc = new PDF({ size: [W, H], margin: 0, compress: true });
      const buffers = [];
      doc.on("data", (b) => buffers.push(b));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      // Background
      doc.rect(0, 0, W, H).fill("#FFFFFF");

      // Outer blue border
      doc.roundedRect(6, 6, W - 12, H - 12, 8).stroke("#1B3A8A");

      // QR Code - use cached version with smaller multiplier
      const qrSize = 130;
      const qrX = (W - qrSize) / 2;
      const qrY = 20;

      const qrBuf = await getCachedQR(ticketCode, qrSize * 2); // 2x instead of 4x
      doc.image(qrBuf, qrX, qrY, { width: qrSize });

      // Divider
      const divY = qrY + qrSize + 16;
      doc
        .moveTo(24, divY)
        .lineTo(W - 24, divY)
        .lineWidth(0.5)
        .stroke("#CCCCCC");

      // Name
      const nameY = divY + 14;
      doc.fillColor("#1B3A8A").font("Helvetica-Bold").fontSize(14);

      const nameH = doc.heightOfString(name, {
        width: W - 28,
        align: "center",
      });
      doc.text(name, 14, nameY, {
        width: W - 28,
        align: "center",
        lineBreak: true,
      });

      // Company
      if (company) {
        doc.fillColor("#444444").font("Helvetica-Bold").fontSize(8.5);
        doc.text(company, 14, nameY + nameH + 5, {
          width: W - 28,
          align: "center",
          lineBreak: true,
        });
      }

      doc.end();
    } catch (err) {
      console.error("[generateScanBadgePDF] error:", err);
      reject(err);
    }
  });
}
async function generateBadgePDF(entity, data, options = {}) {
  const { mode = "email" } = options;

  // ── Scan mode: return lightweight card (QR + name + company only) ──
  if (mode === "scan") {
    return generateScanBadgePDF(data);
  }

  // ── All other modes: full branded badge ──
  return new Promise(async (resolve, reject) => {
    try {
      const ticketCode =
        data?.ticket_code || data?.ticketCode || data?.data?.ticket_code;
      if (!ticketCode) throw new Error("ticket_code missing");

      // Payment signals vary by collection/flow; treat any positive ticket amount as paid.
      const paidAmount =
        Number(data.amount) ||
        Number(data.amount_paid) ||
        Number(data.ticket_total) ||
        Number(data.ticket_price) ||
        Number(data.ticketTotal) ||
        Number(data.ticketPrice) ||
        Number(data?.data?.amount) ||
        Number(data?.data?.ticket_total) ||
        0;
      const isPaid =
        Boolean(
          data.txId ||
          data.tx_id ||
          data.transactionId ||
          data.paymentId ||
          data.razorpay_payment_id,
        ) ||
        data.paid === true ||
        String(data.payment_status || "").toLowerCase() === "paid" ||
        paidAmount > 0;
      const { ribbon: ribbonLabel, color: themeColor } = getBadgeTheme({
        entity,
        isPaid,
      });

      console.log(`[${ribbonLabel}] ${data.name || "(no name)"}`);

      const doc = new PDF({ size: [C.PAGE.width, C.PAGE.height], margin: 0 });
      const buffers = [];
      doc.on("data", (b) => buffers.push(b));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      // Draw all sections
      doc
        .rect(0, C.TOP_STRIP.y, C.PAGE.width, C.TOP_STRIP.height)
        .fill(themeColor);
      drawHeader(doc);
      drawTagline(doc);
      drawBodyBackground(doc);

      // Enhanced name extraction
      const name = (
        data.name ||
        data.full_name ||
        (data.firstName ? `${data.firstName} ${data.lastName || ""}` : "") ||
        data.fullName ||
        ""
      )
        .trim()
        .toUpperCase();

      // Enhanced company extraction
      let company = (
        data.company ||
        data.organization ||
        data.companyName ||
        data.company_name ||
        data.org ||
        data.employer ||
        data.affiliation ||
        data.business ||
        data.firm ||
        (data.data && data.data.company) ||
        (data.data && data.data.organization) ||
        (data.data && data.data.companyName) ||
        ""
      )
        .trim()
        .toUpperCase();

      // Remove any "null" or "undefined" strings
      if (company === "NULL" || company === "UNDEFINED" || company === "") {
        company = "";
      }

      console.log(`[DEBUG] Final Company: "${company}"`);

      await drawQRCard(doc, ticketCode, entity, mode, name, company);
      drawFooter(doc);
      drawRibbon(doc, themeColor, ribbonLabel);

      doc.end();
    } catch (err) {
      console.error("Badge generation error:", err);
      reject(err);
    }
  });
}

module.exports = { generateBadgePDF };
