"use strict";

const fs = require("fs");
const path = require("path");
const PDF = require("pdfkit");
const QRCode = require("qrcode");

const C = require("./attendingCardConfig");

/* ── helpers ───────────────────────────────────────────────────────────── */

async function getQR(text, size) {
  const qrDataUrl = await QRCode.toDataURL(String(text), {
    errorCorrectionLevel: C.qr.errorCorrectionLevel || "M",
    margin: C.qr.margin ?? 0,
    width: size * 2,
  });
  return Buffer.from(qrDataUrl.split(",")[1], "base64");
}

function safeImage(doc, filePath, x, y, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.warn("[attendingCard] Logo not found:", filePath);
    return false;
  }
  try { doc.image(filePath, x, y, opts); return true; }
  catch (err) { console.warn("[attendingCard] image failed:", err.message); return false; }
}

/** Draw image scaled to COVER the page — no black bars, no stretch. */
function drawCoverImage(doc, imgPath, pw, ph) {
  if (!fs.existsSync(imgPath)) return false;
  try {
    const img = doc.openImage(imgPath);
    const scale = Math.max(pw / img.width, ph / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    doc.image(img, (pw - w) / 2, (ph - h) / 2, { width: w, height: h });
    return true;
  } catch (err) {
    console.warn("[attendingCard] cover image failed:", err.message);
    return false;
  }
}

/* ── main ──────────────────────────────────────────────────────────────── */

async function generateAttendingCardPDF(data = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const ticketCode =
        data.ticket_code || data.ticketCode || data.data?.ticket_code || "";
      if (!ticketCode) throw new Error("ticket_code missing");

      const name =
        data.name || data.full_name || data.fullName ||
        data.data?.name || data.data?.full_name || "";

      const designation =
        data.designation || data.job_title || data.title ||
        data.data?.designation || data.data?.job_title || "";

      const company =
        data.company || data.organization || data.companyName ||
        data.company_name || data.data?.company || data.data?.organization || "";

      const doc = new PDF({
        size: C.pdf.size || "A4",
        layout: C.pdf.layout || "portrait",
        margin: 0, compress: true,
      });

      const buffers = [];
      doc.on("data", (b) => buffers.push(b));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      const PW = doc.page.width;
      const PH = doc.page.height;

      /* 1. Background image (cover) + light white wash (using fillOpacity, NOT rgba) */
      doc.rect(0, 0, PW, PH).fill(C.colors.background);
      const bgPath = path.join(__dirname, "..", "assets", "bg", "bg.jpeg");
      drawCoverImage(doc, bgPath, PW, PH);

      doc.save();
      doc.fillOpacity(0.25);
      doc.rect(0, 0, PW, PH).fill("#FFFFFF");
      doc.restore();
      doc.fillOpacity(1);

      /* 2. White card panel inside border */
      const pad = 18;
      const cardX = pad, cardY = pad;
      const cardW = PW - pad * 2;
      const cardH = PH - pad * 2;

      doc.save();
      doc.fillOpacity(0.82);
      doc.roundedRect(cardX, cardY, cardW, cardH, 18).fill(C.colors.panelBg);
      doc.restore();
      doc.fillOpacity(1);

      doc.roundedRect(cardX, cardY, cardW, cardH, 18)
         .lineWidth(2.2).stroke(C.colors.panelBorder);

      /* 3. TOP: Hosted by (L) | Supported by (R) */
      doc.fillColor(C.colors.navyBlue).font("Helvetica-Bold").fontSize(9)
         .text(C.logos.hostedBy.label, 46, 32, { width: 130, align: "center" });

      doc.fillColor(C.colors.navyBlue).font("Helvetica-Bold").fontSize(9)
         .text(C.logos.supportedBy.label, PW - 176, 32, { width: 130, align: "center" });

      safeImage(doc, C.logos.hostedBy.file,    46,  46, 120);
      safeImage(doc, C.logos.supportedBy.file, PW - 176, 42, 120);

      /* 4. RailTrans brand block */
      const brandW = 230;
      safeImage(doc, C.logos.railtransBrand.file, (PW - brandW) / 2, 88, brandW);

      doc.fillColor(C.colors.navyBlue).font("Helvetica-Bold").fontSize(13)
         .text("Driving Regional Rail Connectivity", 0, 195, {
           width: PW, align: "center",
         });

      doc.fillColor(C.colors.gold).font("Helvetica-Bold").fontSize(12)
         .text("TRANSFORMING RAIL TOGETHER", 0, 214, {
           width: PW, align: "center",
         });

      doc.fillColor(C.colors.navyBlue).font("Helvetica-Bold").fontSize(20)
         .text(C.event.name, 0, 236, { width: PW, align: "center" });

      /* 5. ATTENDING CARD pill */
      const titleW = PW - 140;
      const titleX = (PW - titleW) / 2;
      const titleY = 272;
      const titleH = 34;

      doc.roundedRect(titleX, titleY, titleW, titleH, 17)
         .fillAndStroke("#FFFFFF", C.colors.navyBlue);
      doc.lineWidth(1.4);

      doc.fillColor(C.colors.navyBlue).font("Helvetica-Bold").fontSize(20)
         .text(C.card.title, titleX, titleY + 6, {
           width: titleW, align: "center",
         });

      /* 6. Participant info */
      const infoX = 40;
      const infoW = PW - 80;
      let cy = 326;

      if (C.card.fields.name) {
        doc.fillColor(C.colors.nameText).font("Helvetica-Bold").fontSize(26)
           .text((name || "Participant").toUpperCase(), infoX, cy, {
             width: infoW, align: "center",
           });
        cy += 40;
      }

      if (C.card.fields.designation && designation) {
        doc.fillColor(C.colors.subText).font("Helvetica").fontSize(14)
           .text(designation, infoX, cy, { width: infoW, align: "center" });
        cy += 24;
      }

      if (C.card.fields.company && company) {
        doc.fillColor(C.colors.text).font("Helvetica-Bold").fontSize(16)
           .text(company, infoX, cy, { width: infoW, align: "center" });
        cy += 30;
      }

      /* 7. Share message */
      cy += 8;
      doc.fillColor("#1f2937").font("Helvetica").fontSize(12)
         .text(C.card.shareMessage, infoX + 20, cy, {
           width: infoW - 40, align: "center",
         });
      cy = doc.y + 18;

      /* 8. In Association with — Rail Chamber logo */
      doc.fillColor(C.colors.navyBlue).font("Helvetica-Bold").fontSize(12)
         .text(C.logos.association.label, 0, cy, {
           width: PW, align: "center",
         });
      cy += 20;

      safeImage(doc, C.logos.association.file, (PW - 130) / 2, cy, 130);
      cy += 130;

      /* 9. QR just above footer */
      const footerH = 62;
      const footerY = PH - footerH;

      if (C.qr?.enabled) {
        const qrSize = C.qr.size || 100;
        const qrBuf = await getQR(C.qr.value, qrSize);
        const qrX = (PW - qrSize) / 2;
        const qrY = footerY - qrSize - 14;

        // white backing so QR is readable over bg        doc.roundedRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 8)
           .fill("#FFFFFF");
        doc.image(qrBuf, qrX, qrY, { width: qrSize });
      }

      /* 10. Red footer band */
      doc.rect(0, footerY, PW, footerH).fill(C.colors.footerRed);

      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(11)
         .text("SCAN TO REGISTER", 30, footerY + 14, { width: 200 });
      doc.fillColor("#FFFFFF").font("Helvetica").fontSize(9)
         .text(C.card.websiteLabel, 30, footerY + 34, { width: 200 });

      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(11)
         .text("VISIT OUR WEBSITE", PW - 230, footerY + 14, {
           width: 200, align: "center",
         });
      doc.fillColor("#FFFFFF").font("Helvetica").fontSize(9)
         .text("www.irmaindia.com", PW - 230, footerY + 34, {
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