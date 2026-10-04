"use strict";

const fs = require("fs");
const path = require("path");
const PDF = require("pdfkit");
const QRCode = require("qrcode");

const C = require("./attendingCardConfig");

/* ─────────────────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────────────────── */

async function getQR(text, size) {
  const qrDataUrl = await QRCode.toDataURL(String(text), {
    errorCorrectionLevel: C.qr.errorCorrectionLevel || "M",
    margin: C.qr.margin ?? 1,
    width: size * 2,
  });
  return Buffer.from(qrDataUrl.split(",")[1], "base64");
}

function safeImage(doc, filePath, x, y, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.warn("[attendingCard] Logo not found:", filePath);
    return false;
  }
  try {
    doc.image(filePath, x, y, opts);
    return true;
  } catch (err) {
    console.warn("[attendingCard] Failed to draw image:", err.message);
    return false;
  }
}

/**
 * Draw background image scaled to COVER the full page
 * (preserves aspect ratio, crops overflow) — no black bars.
 */
function drawCoverImage(doc, imgPath, pw, ph) {
  if (!fs.existsSync(imgPath)) {
    console.warn("[attendingCard] bg not found:", imgPath);
    return false;
  }
  try {
    const img = doc.openImage(imgPath);
    const scale = Math.max(pw / img.width, ph / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (pw - w) / 2;
    const y = (ph - h) / 2;
    doc.image(img, x, y, { width: w, height: h });
    return true;
  } catch (err) {
    console.warn("[attendingCard] bg draw failed:", err.message);
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Main generator
 * ───────────────────────────────────────────────────────────────────────── */

async function generateAttendingCardPDF(data = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const ticketCode =
        data.ticket_code ||
        data.ticketCode ||
        data.data?.ticket_code ||
        "";

      if (!ticketCode) throw new Error("ticket_code missing");

      const name =
        data.name ||
        data.full_name ||
        data.fullName ||
        data.data?.name ||
        data.data?.full_name ||
        "";

      const designation =
        data.designation ||
        data.job_title ||
        data.title ||
        data.data?.designation ||
        data.data?.job_title ||
        "";

      const company =
        data.company ||
        data.organization ||
        data.companyName ||
        data.company_name ||
        data.data?.company ||
        data.data?.organization ||
        "";

      const doc = new PDF({
        size: C.pdf.size || "A4",
        layout: C.pdf.layout || "portrait",
        margin: 0,
        compress: true,
      });

      const buffers = [];
      doc.on("data", (chunk) => buffers.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      const pageWidth  = doc.page.width;
      const pageHeight = doc.page.height;

      /* ─────────────────────────────────────────────────────────────
       * 1. BACKGROUND IMAGE — COVER, no rgba fills
       * ───────────────────────────────────────────────────────────── */
      const bgPath = path.join(__dirname, "..", "assets", "bg", "bg.jpeg");

      // White base first (in case bg fails, no black shows)
      doc.rect(0, 0, pageWidth, pageHeight).fill(C.colors.background);

      // Draw bg image covering the whole page
      drawCoverImage(doc, bgPath, pageWidth, pageHeight);

      // Very light white wash (use fillOpacity, NOT rgba string)
      doc.save();
      doc.fillOpacity(0.15);
      doc.rect(0, 0, pageWidth, pageHeight).fill("#FFFFFF");
      doc.restore();
      doc.fillOpacity(1);

      /* ─────────────────────────────────────────────────────────────
       * 2. OUTER ROUNDED PANEL (the white card on top of bg)
       * ───────────────────────────────────────────────────────────── */
      const pad = 18;
      const panelX = pad;
      const panelY = pad;
      const panelW = pageWidth  - pad * 2;
      const panelH = pageHeight - pad * 2;

      doc.save();
      doc.fillOpacity(0.78);
      doc.roundedRect(panelX, panelY, panelW, panelH, 18)
         .fill(C.colors.panelBg);
      doc.restore();
      doc.fillOpacity(1);

      doc.roundedRect(panelX, panelY, panelW, panelH, 18)
         .lineWidth(2.2)
         .stroke(C.colors.panelBorder);

      /* ─────────────────────────────────────────────────────────────
       * 3. TOP LOGOS: Hosted (L) | Supported (R)
       * ───────────────────────────────────────────────────────────── */
      doc.fillColor(C.colors.navyBlue)
         .font("Helvetica-Bold")
         .fontSize(9)
         .text("Hosted by", 48, 32, { width: 110, align: "center" });

      doc.fillColor(C.colors.navyBlue)
         .font("Helvetica-Bold")
         .fontSize(9)
         .text("Supported by", pageWidth - 158, 32, { width: 110, align: "center" });

      if (C.layout?.topLogos?.enabled) {
        safeImage(doc, C.logos.hostedBy?.file,    52, 46, 110);
        safeImage(doc, C.logos.supportedBy?.file, pageWidth - 168, 42, 110);
      }

      /* ─────────────────────────────────────────────────────────────
       * 4. BRAND block: RailTrans logo + tagline + event info
       * ───────────────────────────────────────────────────────────── */
      // RailTrans logo (wide) — the source image already contains the ribbon + 7th edition + 2027
      const logoW = 250;
      safeImage(doc, C.logos.railtransBrand?.file,
                (pageWidth - logoW) / 2, 88, logoW);

      doc.fillColor(C.colors.navyBlue)
         .font("Helvetica-Bold")
         .fontSize(13)
         .text("Driving Regional Rail Connectivity", 0, 190, {
           width: pageWidth, align: "center",
         });

      doc.fillColor("#c99a2e")
         .font("Helvetica-Bold")
         .fontSize(12)
         .text("TRANSFORMING RAIL TOGETHER", 0, 210, {
           width: pageWidth, align: "center",
         });

      doc.fillColor(C.colors.navyBlue)
         .font("Helvetica-Bold")
         .fontSize(20)
         .text(C.event.name || "7th RailTrans Expo 2027", 0, 232, {
           width: pageWidth, align: "center",
         });

      /* ─────────────────────────────────────────────────────────────
       * 5. ATTENDING CARD pill
       * ───────────────────────────────────────────────────────────── */
      const titleY = 268;
      const titleH = 34;
      const titleW = pageWidth - 140;
      const titleX = (pageWidth - titleW) / 2;

      doc.roundedRect(titleX, titleY, titleW, titleH, 17)
         .fillAndStroke("#FFFFFF", C.colors.navyBlue);
      doc.lineWidth(1.4);

      doc.fillColor(C.colors.navyBlue)
         .font("Helvetica-Bold")
         .fontSize(20)
         .text(C.card.title || "ATTENDING CARD", titleX, titleY + 6, {
           width: titleW, align: "center",
         });

      /* ─────────────────────────────────────────────────────────────
       * 6. Participant info (centered, inside white box)
       * ───────────────────────────────────────────────────────────── */
      const infoX = 40;
      const infoW = pageWidth - 80;

      let cursorY = 320;

      if (C.card.fields.name) {
        doc.fillColor(C.colors.nameText)
           .font("Helvetica-Bold")
           .fontSize(26)
           .text((name || "Participant").toUpperCase(), infoX, cursorY, {
             width: infoW, align: "center",
           });
        cursorY += 40;
      }

      if (C.card.fields.designation && designation) {
        doc.fillColor(C.colors.subText)
           .font("Helvetica")
           .fontSize(14)
           .text(designation, infoX, cursorY, {
             width: infoW, align: "center",
           });
        cursorY += 24;
      }

      if (C.card.fields.company && company) {
        doc.fillColor(C.colors.text)
           .font("Helvetica-Bold")
           .fontSize(16)
           .text(company, infoX, cursorY, {
             width: infoW, align: "center",
           });
        cursorY += 30;
      }

      /* ─────────────────────────────────────────────────────────────
       * 7. Share message
       * ───────────────────────────────────────────────────────────── */
      cursorY += 6;
      doc.fillColor(C.colors.secondary)
         .font("Helvetica")
         .fontSize(12)
         .text(C.card.shareMessage || "", infoX + 20, cursorY, {
           width: infoW - 40, align: "center",
         });
      cursorY = doc.y + 14;

      /* ─────────────────────────────────────────────────────────────
       * 8. In Association with — Rail Chamber logo
       * ───────────────────────────────────────────────────────────── */
      doc.fillColor(C.colors.navyBlue)
         .font("Helvetica-Bold")
         .fontSize(12)
         .text("In Association with", 0, cursorY, {
           width: pageWidth, align: "center",
         });
      cursorY += 20;

      safeImage(doc, C.logos.association?.file,
                (pageWidth - 140) / 2, cursorY, 140);
      cursorY += 100;

      /* ─────────────────────────────────────────────────────────────
       * 9. QR — small, centered just above footer
       * ───────────────────────────────────────────────────────────── */
      const footerH = 60;
      const footerY = pageHeight - footerH;

      if (C.qr?.enabled) {
        const qrSize = 90;
        const qrValue = C.qr.value || "https://www.irmaindia.com";
        const qrBuffer = await getQR(qrValue, qrSize);

        // place QR just above footer, vertically centered inside footer area's upper half
        const qrX = (pageWidth - qrSize) / 2;
        const qrY = footerY - qrSize - 12;

        // white rounded backing
        doc.roundedRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 8)
           .fill("#FFFFFF");

        doc.image(qrBuffer, qrX, qrY, { width: qrSize });
      }

      /* ─────────────────────────────────────────────────────────────
       * 10. RED FOOTER BAND
       * ───────────────────────────────────────────────────────────── */
      doc.rect(0, footerY, pageWidth, footerH).fill(C.colors.footerRed);

      // Left: SCAN TO REGISTER
      doc.fillColor("#FFFFFF")
         .font("Helvetica-Bold")
         .fontSize(11)
         .text("SCAN TO REGISTER", 30, footerY + 14, { width: 200 });

      doc.fillColor("#FFFFFF")
         .font("Helvetica")
         .fontSize(9)
         .text("www.railtransexpo.com", 30, footerY + 32, { width: 200 });

      // Right: VISIT OUR WEBSITE
      doc.fillColor("#FFFFFF")
         .font("Helvetica-Bold")
         .fontSize(11)
         .text("VISIT OUR WEBSITE", pageWidth - 230, footerY + 14, {
           width: 200, align: "center",
         });

      doc.fillColor("#FFFFFF")
         .font("Helvetica")
         .fontSize(9)
         .text("www.irmaindia.com", pageWidth - 230, footerY + 32, {
           width: 200, align: "center",
         });

      doc.end();
    } catch (err) {
      console.error("[attendingCardGenerator] error:", err.stack || err);
      reject(err);
    }
  });
}

module.exports = { generateAttendingCardPDF };