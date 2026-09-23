"use strict";

const fs = require("fs");
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
      // Background
      // --------------------------------------------------

      doc
        .rect(0, 0, pageWidth, pageHeight)
        .fill(C.colors.background);

      // --------------------------------------------------
      // Border
      // --------------------------------------------------

      doc
        .lineWidth(1)
        .rect(
          10,
          10,
          pageWidth - 20,
          pageHeight - 20
        )
        .stroke(C.colors.border);

      // --------------------------------------------------
      // RailTrans Logo
      // --------------------------------------------------

      // Your current config does not define a railtrans logo.
      // So don't try C.LOGOS.railtrans here.
      // Add it to config later if required.

      // --------------------------------------------------
      // Top logos
      // Hosted by | Association | Supported by
      // --------------------------------------------------

      if (C.layout?.topLogos?.enabled) {
        const y = 35;

        safeImage(
          doc,
          C.logos.hostedBy?.file,
          50,
          y,
          120
        );

        safeImage(
          doc,
          C.logos.association?.file,
          (pageWidth - 140) / 2,
          y,
          140
        );

        safeImage(
          doc,
          C.logos.supportedBy?.file,
          pageWidth - 170,
          y,
          120
        );
      }

      // --------------------------------------------------
      // Title
      // --------------------------------------------------

      doc
        .fillColor(C.colors.primary)
        .font("Helvetica-Bold")
        .fontSize(C.pdf.titleFontSize || 22)
        .text(
          C.card.title || "ATTENDING CARD",
          30,
          125,
          {
            width: pageWidth - 60,
            align: "center",
          }
        );

      // --------------------------------------------------
      // Participant information
      // --------------------------------------------------

      const participantTop = 180;

      if (C.card.fields.name) {
        doc
          .fillColor(C.colors.text)
          .font("Helvetica-Bold")
          .fontSize(C.pdf.nameFontSize || 28)
          .text(
            name || "Participant",
            40,
            participantTop,
            {
              width: pageWidth - 80,
              align: "center",
            }
          );
      }

      if (C.card.fields.designation) {
        doc
          .fillColor(C.colors.muted)
          .font("Helvetica")
          .fontSize(C.pdf.designationFontSize || 16)
          .text(
            designation || "",
            40,
            participantTop + 50,
            {
              width: pageWidth - 80,
              align: "center",
            }
          );
      }

      if (C.card.fields.company) {
        doc
          .fillColor(C.colors.text)
          .font("Helvetica-Bold")
          .fontSize(C.pdf.companyFontSize || 17)
          .text(
            company || "",
            40,
            participantTop + 80,
            {
              width: pageWidth - 80,
              align: "center",
            }
          );
      }

      // --------------------------------------------------
      // QR Code
      // --------------------------------------------------

      if (C.qr?.enabled) {
        const qrSize = C.qr.size || 150;

        const qrBuffer = await getQR(
          C.qr.value || ticketCode,
          qrSize
        );

        doc.image(
          qrBuffer,
          (pageWidth - qrSize) / 2,
          315,
          {
            width: qrSize,
          }
        );
      }

      // --------------------------------------------------
      // Share message
      // --------------------------------------------------

      doc
        .fillColor(C.colors.muted)
        .font("Helvetica")
        .fontSize(C.pdf.messageFontSize || 16)
        .text(
          C.card.shareMessage || "",
          60,
          485,
          {
            width: pageWidth - 120,
            align: "center",
          }
        );

      // --------------------------------------------------
      // Website
      // --------------------------------------------------

      doc
        .fillColor(C.colors.primary)
        .font("Helvetica-Bold")
        .fontSize(C.pdf.websiteFontSize || 12)
        .text(
          C.card.websiteLabel ||
            C.event.website ||
            "",
          40,
          535,
          {
            width: pageWidth - 80,
            align: "center",
          }
        );

      // --------------------------------------------------
      // Event details
      // --------------------------------------------------

      doc
        .fillColor(C.colors.secondary)
        .font("Helvetica")
        .fontSize(11)
        .text(
          `${C.event.name}\n${C.event.dates}\n${C.event.venue}`,
          40,
          565,
          {
            width: pageWidth - 80,
            align: "center",
            lineGap: 4,
          }
        );

      // --------------------------------------------------
      // Bottom logos
      // --------------------------------------------------

      const bottomY = pageHeight - 100;

      safeImage(
        doc,
        C.logos.hostedBy?.file,
        50,
        bottomY,
        100
      );

      safeImage(
        doc,
        C.logos.association?.file,
        (pageWidth - 100) / 2,
        bottomY,
        100
      );

      safeImage(
        doc,
        C.logos.supportedBy?.file,
        pageWidth - 150,
        bottomY,
        100
      );

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