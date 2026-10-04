"use strict";

const fs = require("fs");
const path = require("path");
const PDF = require("pdfkit");
const QRCode = require("qrcode");

const C = require("./attendingCardConfig");

async function getQR(text, size) {
  const qrDataUrl = await QRCode.toDataURL(String(text), {
    errorCorrectionLevel: C.qr.errorCorrectionLevel || "M",
    margin: C.qr.margin ?? 1,
    width: size * 2,
  });

  return Buffer.from(
    qrDataUrl.split(",")[1],
    "base64"
  );
}

function safeImage(doc, filePath, x, y, width, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.warn(
      "[attendingCard] Logo not found:",
      filePath
    );
    return false;
  }

  try {
    doc.image(filePath, x, y, {
      width,
      ...options,
    });

    return true;
  } catch (err) {
    console.warn(
      "[attendingCard] Failed to draw image:",
      err.message
    );

    return false;
  }
}

async function generateAttendingCardPDF(data = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const ticketCode =
        data.ticket_code ||
        data.ticketCode ||
        data.data?.ticket_code ||
        "";

      if (!ticketCode) {
        throw new Error("ticket_code missing");
      }

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

      // Use A4 from config
      const doc = new PDF({
        size: C.pdf.size || "A4",
        layout: C.pdf.layout || "portrait",
        margin: 0,
        compress: true,
      });

      const buffers = [];

      doc.on("data", (chunk) => {
        buffers.push(chunk);
      });

      doc.on("end", () => {
        resolve(Buffer.concat(buffers));
      });

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      // --------------------------------------------------
      // Light ticket-style background using the existing bg asset
      // --------------------------------------------------
      const bgPath = path.join(__dirname, "..", "assets", "bg", "bg.jpeg");
      if (fs.existsSync(bgPath)) {
        doc.image(bgPath, 0, 0, { width: pageWidth, height: pageHeight });
      }

      doc
        .rect(0, 0, pageWidth, pageHeight)
        .fill("rgba(255,255,255,0.18)");

      doc
        .roundedRect(18, 18, pageWidth - 36, pageHeight - 36, 18)
        .fillAndStroke("rgba(255,255,255,0.08)", "#0e4d7d")
        .lineWidth(2.2);

      // Top row logos
      doc
        .fillColor("#0e4d7d")
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("Hosted by", 58, 38, { width: 90, align: "center" });

      doc
        .fillColor("#0e4d7d")
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("Supported by", pageWidth - 150, 38, { width: 100, align: "center" });

      if (C.layout?.topLogos?.enabled) {
        safeImage(doc, C.logos.hostedBy?.file, 54, 52, 110);
        safeImage(doc, C.logos.supportedBy?.file, pageWidth - 170, 52, 108);
      }

      // Main RailTrans logo and text
      safeImage(doc, C.logos.railtransBrand?.file, (pageWidth - 270) / 2, 90, 270);

      doc
        .fillColor("#0e4d7d")
        .font("Helvetica-Bold")
        .fontSize(16)
        .text("Driving Regional Rail Connectivity", 0, 200, {
          width: pageWidth,
          align: "center",
        });

      doc
        .fillColor("#0e4d7d")
        .font("Helvetica-Bold")
        .fontSize(14)
        .text("TRANSFORMING RAIL TOGETHER", 0, 224, {
          width: pageWidth,
          align: "center",
        });

      doc
        .fillColor("#0e4d7d")
        .font("Helvetica-Bold")
        .fontSize(20)
        .text(C.event.name || "7th RailTrans Expo 2027", 0, 250, {
          width: pageWidth,
          align: "center",
        });

      // Title bar
      doc
        .roundedRect(70, 290, pageWidth - 140, 36, 18)
        .fillAndStroke("#ffffff", "#0e4d7d")
        .lineWidth(1.4);

      doc
        .fillColor("#0e4d7d")
        .font("Helvetica-Bold")
        .fontSize(20)
        .text(C.card.title || "ATTENDING CARD", 0, 296, {
          width: pageWidth,
          align: "center",
        });

      // Participant information
      const participantTop = 350;

      if (C.card.fields.name) {
        doc
          .fillColor("#0f172a")
          .font("Helvetica-Bold")
          .fontSize(28)
          .text(name || "Participant", 40, participantTop, {
            width: pageWidth - 80,
            align: "center",
          });
      }

      if (C.card.fields.designation) {
        doc
          .fillColor("#475569")
          .font("Helvetica")
          .fontSize(16)
          .text(designation || "", 40, participantTop + 42, {
            width: pageWidth - 80,
            align: "center",
          });
      }

      if (C.card.fields.company) {
        doc
          .fillColor("#111827")
          .font("Helvetica-Bold")
          .fontSize(18)
          .text(company || "", 40, participantTop + 74, {
            width: pageWidth - 80,
            align: "center",
          });
      }

      // Small QR at the bottom, as in the reference card
      if (C.qr?.enabled) {
        const qrSize = C.qr.size || 120;
        const qrValue = C.qr.value || "https://www.irmaindia.com";
        const qrBuffer = await getQR(qrValue, qrSize);

        doc
          .roundedRect((pageWidth - (qrSize + 28)) / 2, 615, qrSize + 28, qrSize + 28, 12)
          .fillAndStroke("#f8fafc", "#dfe7ef")
          .lineWidth(1);

        doc.image(qrBuffer, (pageWidth - qrSize) / 2, 627, { width: qrSize });
      }

      // Message and event details
      doc
        .fillColor("#1f2937")
        .font("Helvetica")
        .fontSize(14)
        .text(C.card.shareMessage || "", 52, 520, {
          width: pageWidth - 104,
          align: "center",
        });

      doc
        .fillColor("#0e4d7d")
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(C.card.websiteLabel || "www.irmaindia.com", 0, 557, {
          width: pageWidth,
          align: "center",
        });

      doc
        .fillColor("#1f2937")
        .font("Helvetica")
        .fontSize(12)
        .text(`${C.event.name}\n${C.event.dates}\n${C.event.venue}`, 0, 575, {
          width: pageWidth,
          align: "center",
          lineGap: 4,
        });

      // Association section and chamber logo
      doc
        .fillColor("#0e4d7d")
        .font("Helvetica-Bold")
        .fontSize(11)
        .text("In Association with", 0, 780, {
          width: pageWidth,
          align: "center",
        });

      safeImage(doc, C.logos.association?.file, (pageWidth - 130) / 2, 795, 130);

      // Footer red band
      const footerY = pageHeight - 58;
      doc.rect(0, footerY, pageWidth, 58).fill("#d61b2a");

      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(13)
        .text("SCAN TO REGISTER", 40, footerY + 16, { width: 180 });

      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(13)
        .text("VISIT OUR WEBSITE", pageWidth - 220, footerY + 16, { width: 180, align: "center" });

      doc
        .fillColor("#ffffff")
        .font("Helvetica")
        .fontSize(10)
        .text("www.irmaindia.com", pageWidth - 200, footerY + 36, { width: 160, align: "center" });

      doc.end();

    } catch (err) {
      console.error(
        "[attendingCardGenerator] error:",
        err.stack || err
      );

      reject(err);
    }
  });
}

module.exports = {
  generateAttendingCardPDF,
};