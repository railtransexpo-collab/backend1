// badgeGenerator.js — RailTrans Expo 2026
"use strict";
const fs = require("fs");
const path = require("path");
const PDF = require("pdfkit");
const QRCode = require("qrcode");
const getBadgeTheme = require("./badgeTheme");
const C = require("./badgeConfig");

const qrCache = new Map();

async function getCachedQR(text, size) {
  const key = `${text}_${size}`;
  if (qrCache.has(key)) return qrCache.get(key);
  const qrDataUrl = await QRCode.toDataURL(text, {
    errorCorrectionLevel: "M", margin: 0, width: size,
  });
  const buffer = Buffer.from(qrDataUrl.split(",")[1], "base64");
  if (qrCache.size > 50) qrCache.clear();
  qrCache.set(key, buffer);
  return buffer;
}

function safeImage(doc, filePath, x, y, width, extraOpts = {}) {
  if (!filePath) return false;
  const candidates = [
    filePath,
    path.join(process.cwd(), filePath),
    path.join(__dirname, "..", "assets", "logos", path.basename(filePath)),
    path.join(__dirname, "..", "assets", "bg", path.basename(filePath)),
    path.join(__dirname, "assets", "logos", path.basename(filePath)),
    path.join(__dirname, "assets", "bg", path.basename(filePath)),
    path.join(process.cwd(), "public", "assets", "logos", path.basename(filePath)),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        doc.image(p, x, y, { width, compress: true, quality: 0.7, ...extraOpts });
        return true;
      } catch (_) {}
    }
  }
  console.warn(`⚠️  Image not found: ${path.basename(filePath)}`);
  return false;
}

function roundedRect(doc, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  doc.moveTo(x + r, y)
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

function drawPill(doc, text, x, y, bgColor, textColor, fontSize, padding = 14, height = 16) {
  doc.font("Helvetica-Bold").fontSize(fontSize);
  const tw = doc.widthOfString(text);
  const pw = tw + padding * 2;
  roundedRect(doc, x, y, pw, height, height / 2);
  doc.fill(bgColor);
  doc.fillColor(textColor).font("Helvetica-Bold").fontSize(fontSize)
    .text(text, x, y + (height - fontSize) / 2 + 1, {
      width: pw, align: "center", lineBreak: false,
    });
}

function drawSquarePill(doc, text, x, y, w, h, bgColor, textColor, fontSize, radius = 6) {
  roundedRect(doc, x, y, w, h, radius);
  doc.fill(bgColor);
  doc.fillColor(textColor).font("Helvetica-Bold").fontSize(fontSize)
    .text(text, x, y + (h - fontSize) / 2 + 1, {
      width: w, align: "center", lineBreak: false,
    });
}

// ── Header ─────────────────────────────────────────────────────────────────
function drawHeader(doc) {
  const H = C.HEADER;
  const dp = C.DATE_PILLS;

  doc.rect(0, H.y, C.PAGE.width, H.height).fill(H.bgColor);

  safeImage(doc, C.RAILTRANS_LOGO.path,
            C.RAILTRANS_LOGO.x, C.RAILTRANS_LOGO.y, C.RAILTRANS_LOGO.width);

  // three pills
  [dp.pill1, dp.pill2, dp.pill3].forEach((p) => {
    drawSquarePill(doc, p.text, p.x, p.y, p.width, p.height,
                   p.bgColor, p.textColor, p.fontSize);
  });

  // "JULY 2027" — same width & x as pill group → centered with them
  doc.fillColor("#000000")
     .font("Helvetica-Bold")
     .fontSize(dp.monthFontSize || 16)
     .text(dp.monthText || "JULY 2027", dp.monthX, dp.monthY, {
       width: dp.monthWidth, align: "center", lineBreak: false,
     });

  // Bharat Mandapam logo + text
  safeImage(doc, C.MANDAPAM.path, C.MANDAPAM.x, C.MANDAPAM.y, C.MANDAPAM.width);

  const mt = C.MANDAPAM_TEXT;
  const venueX = C.MANDAPAM.x;
  const venueW = C.MANDAPAM.width;
  const baseY  = mt.y;

  doc.fillColor(mt.color).font("Helvetica-Bold").fontSize(mt.fontSizeLine1)
     .text(mt.line1, venueX, baseY, { width: venueW, align: "center", lineBreak: false });
  const l1h = doc.heightOfString(mt.line1, { width: venueW, align: "center" });
  doc.fillColor(mt.color).font("Helvetica-Bold").fontSize(mt.fontSizeLine2)
     .text(mt.line2, venueX, baseY + l1h + mt.lineGap,
           { width: venueW, align: "center", lineBreak: false });
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
  doc.fillColor(tg.textColor).font("Helvetica-Bold").fontSize(tg.fontSize)
     .text(tg.text, px + 10, py + (ph - tg.fontSize) / 2 + 1,
           { width: pw - 20, align: "center", lineBreak: false });
}

function drawBodyBackground(doc) {
  const bodyH = C.RIBBON.y - C.BODY.startY;
  doc.rect(0, C.BODY.startY, C.PAGE.width, bodyH).fill(C.BODY.bgColor);
  safeImage(doc, C.BODY.bgImage, 0, C.BODY.startY, C.PAGE.width, { height: bodyH });
  doc.save();
  doc.opacity(C.BODY.overlayOpacity / 255);
  doc.rect(0, C.BODY.startY, C.PAGE.width, bodyH).fill("#FFFFFF");
  doc.restore();
}

async function drawQRCard(doc, ticketCode, entity, mode, name, company) {
  const qc = C.QR_CARD;
  const qrPayload = mode === "scan"
    ? ticketCode
    : JSON.stringify({ ticket_code: ticketCode, entity });
  const qrBuf = await getCachedQR(qrPayload, C.QR.size * 2);
  const qrX = qc.x + (qc.width - C.QR.size) / 2;
  const qrY = qc.y + 20;
  doc.image(qrBuf, qrX, qrY, { width: C.QR.size });

  const textStartY = qrY + C.QR.size + (C.TEXT_AREA.gapAfterQr || 15);
  doc.fillColor("#000").font("Helvetica-Bold").fontSize(C.TEXT_AREA.nameFontSize);
  const nameHeight = doc.heightOfString(name, { width: qc.width - 30, align: "center" });
  doc.text(name, qc.x + 15, textStartY, { width: qc.width - 30, align: "center" });

  if (company && company.trim() && company !== "UNDEFINED" && company !== "NULL") {
    doc.fillColor("#333").font("Helvetica-Bold").fontSize(C.TEXT_AREA.companyFontSize);
    doc.text(company, qc.x + 15, textStartY + nameHeight + 2,
             { width: qc.width - 30, align: "center", lineBreak: true });
  }
}

// ── Footer: LEFT = CRI  |  RIGHT = ORGANISED BY + Urban Infra ───────────────
function drawFooter(doc) {
  const cri = C.CRI_LOGO;
  const org = C.ORGANISED_BY;

  // LEFT: Chamber of Railway Industries
  safeImage(doc, cri.path, cri.x, cri.y, cri.width);

  // RIGHT: pill centered over right-side logo
  doc.font("Helvetica-Bold").fontSize(org.labelFontSize);
  const labelTextW = doc.widthOfString(org.label);
  const pillW = labelTextW + 50;
  const pillX = org.logoX + (org.logoWidth - pillW) / 2;
  drawPill(doc, org.label, pillX, org.labelY,
           org.labelBgColor, org.labelTextColor, org.labelFontSize, 22, 20);

  safeImage(doc, org.logoPath, org.logoX, org.logoY, org.logoWidth);
}

function drawRibbon(doc, themeColor, ribbonLabel) {
  const R = C.RIBBON;
  doc.rect(0, R.y, C.PAGE.width, R.height).fill(themeColor);
  roundedRect(doc, 0, R.y, C.PAGE.width, R.height, R.borderRadius);
  doc.fill(themeColor);
  const textY = R.y + (R.height - R.textSize) / 2;
  doc.fillColor(R.textColor).opacity(1).font("Helvetica-Bold").fontSize(R.textSize)
     .text(ribbonLabel, 0, textY, { align: "center", width: C.PAGE.width });
}

async function generateScanBadgePDF(data) {
  return new Promise(async (resolve, reject) => {
    try {
      const ticketCode = data?.ticket_code || data?.ticketCode || data?.data?.ticket_code;
      if (!ticketCode) throw new Error("ticket_code missing");
      const name = (data.name || data.full_name || data.fullName || "").trim().toUpperCase() || "GUEST";
      let company = (data.company || data.organization || data.companyName || "").trim().toUpperCase();
      if (company === "NULL" || company === "UNDEFINED") company = "";

      const W = 220, H = 300;
      const doc = new PDF({ size: [W, H], margin: 0, compress: true });
      const buffers = [];
      doc.on("data", (b) => buffers.push(b));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      doc.rect(0, 0, W, H).fill("#FFFFFF");
      doc.roundedRect(6, 6, W - 12, H - 12, 8).stroke("#1B3A8A");

      const qrSize = 130;
      const qrBuf = await getCachedQR(ticketCode, qrSize * 2);
      doc.image(qrBuf, (W - qrSize) / 2, 20, { width: qrSize });

      const divY = 20 + qrSize + 16;
      doc.moveTo(24, divY).lineTo(W - 24, divY).lineWidth(0.5).stroke("#CCCCCC");

      const nameY = divY + 14;
      doc.fillColor("#1B3A8A").font("Helvetica-Bold").fontSize(14);
      const nameH = doc.heightOfString(name, { width: W - 28, align: "center" });
      doc.text(name, 14, nameY, { width: W - 28, align: "center", lineBreak: true });

      if (company) {
        doc.fillColor("#444444").font("Helvetica-Bold").fontSize(8.5);
        doc.text(company, 14, nameY + nameH + 5, { width: W - 28, align: "center", lineBreak: true });
      }
      doc.end();
    } catch (err) { reject(err); }
  });
}

async function generateBadgePDF(entity, data, options = {}) {
  const { mode = "email" } = options;
  if (mode === "scan") return generateScanBadgePDF(data);

  return new Promise(async (resolve, reject) => {
    try {
      const ticketCode = data?.ticket_code || data?.ticketCode || data?.data?.ticket_code;
      if (!ticketCode) throw new Error("ticket_code missing");

      const paidAmount = Number(data.amount) || Number(data.amount_paid) ||
        Number(data.ticket_total) || Number(data.ticket_price) ||
        Number(data.ticketTotal) || Number(data.ticketPrice) ||
        Number(data?.data?.amount) || Number(data?.data?.ticket_total) || 0;

      const isPaid = Boolean(data.txId || data.tx_id || data.transactionId ||
        data.paymentId || data.razorpay_payment_id) ||
        data.paid === true ||
        String(data.payment_status || "").toLowerCase() === "paid" ||
        paidAmount > 0;

      const { ribbon: ribbonLabel, color: themeColor } =
        getBadgeTheme({ entity, isPaid });

      const doc = new PDF({
        size: [C.PAGE.width, C.PAGE.height],
        margin: 0, compress: true, pdfVersion: "1.4",
      });
      const buffers = [];
      doc.on("data", (b) => buffers.push(b));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      doc.rect(0, C.TOP_STRIP.y, C.PAGE.width, C.TOP_STRIP.height).fill(themeColor);
      drawHeader(doc);
      drawTagline(doc);
      drawBodyBackground(doc);

      const name = (data.name || data.full_name ||
        (data.firstName ? `${data.firstName} ${data.lastName || ""}` : "") ||
        data.fullName || "").trim().toUpperCase();

      let company = (data.company || data.organization || data.companyName ||
        data.company_name || data.org || data.employer || data.affiliation ||
        data.business || data.firm ||
        (data.data && data.data.company) ||
        (data.data && data.data.organization) ||
        (data.data && data.data.companyName) || "").trim().toUpperCase();

      if (company === "NULL" || company === "UNDEFINED") company = "";

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

module.exports = { generateBadgePDF, generateScanBadgePDF };