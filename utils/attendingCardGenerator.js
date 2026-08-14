"use strict";

const fs = require("fs");
const path = require("path");
const PDF = require("pdfkit");
const QRCode = require("qrcode");

const C = require("./attendingCardConfig");

async function getQR(text, size) {
  const qrDataUrl = await QRCode.toDataURL(String(text), {
    errorCorrectionLevel: "M",
    margin: 1,
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
        "";

      const designation =
        data.designation ||
        data.job_title ||
        data.title ||
        "";

      const company =
        data.company ||
        data.organization ||
        data.companyName ||
        data.company_name ||
        "";

      const doc = new PDF({
        size: [C.PAGE.width, C.PAGE.height],
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

      // Background
      doc
        .rect(
          0,
          0,
          C.PAGE.width,
          C.PAGE.height
        )
        .fill(C.COLORS.background);

      // Border
      doc
        .lineWidth(1)
        .rect(
          10,
          10,
          C.PAGE.width - 20,
          C.PAGE.height - 20
        )
        .stroke(C.COLORS.border);

      // RailTrans logo
      safeImage(
        doc,
        C.LOGOS.railtrans,
        30,
        25,
        150
      );

      // Title
      doc
        .fillColor(C.COLORS.primary)
        .font("Helvetica-Bold")
        .fontSize(24)
        .text(
          "ATTENDING CARD",
          30,
          110,
          {
            width: C.PAGE.width - 60,
            align: "center",
          }
        );

      // Name
      doc
        .fillColor(C.COLORS.text)
        .font("Helvetica-Bold")
        .fontSize(22)
        .text(
          name,
          40,
          155,
          {
            width: C.PAGE.width - 200,
            align: "left",
          }
        );

      // Designation
      doc
        .fillColor(C.COLORS.muted)
        .font("Helvetica")
        .fontSize(14)
        .text(
          designation,
          40,
          195,
          {
            width: C.PAGE.width - 200,
          }
        );

      // Company
      doc
        .fillColor(C.COLORS.text)
        .font("Helvetica-Bold")
        .fontSize(16)
        .text(
          company,
          40,
          225,
          {
            width: C.PAGE.width - 200,
          }
        );

      // QR
      const qrBuffer = await getQR(
        ticketCode,
        C.QR.size
      );

      doc.image(
        qrBuffer,
        C.PAGE.width - C.QR.size - 45,
        140,
        {
          width: C.QR.size,
        }
      );

      // Registration message
      doc
        .fillColor(C.COLORS.muted)
        .font("Helvetica")
        .fontSize(11)
        .text(
          "Please carry this card along with your valid identity proof.",
          40,
          285,
          {
            width: C.PAGE.width - 80,
            align: "center",
          }
        );

      // Logos at bottom
      safeImage(
        doc,
        C.LOGOS.chamber,
        50,
        330,
        100
      );

      safeImage(
        doc,
        C.LOGOS.ministry,
        250,
        330,
        100
      );

      safeImage(
        doc,
        C.LOGOS.urbanInfra,
        450,
        330,
        100
      );

      doc.end();

    } catch (err) {
      console.error(
        "[attendingCardGenerator] error:",
        err
      );

      reject(err);
    }
  });
}

module.exports = {
  generateAttendingCardPDF,
};