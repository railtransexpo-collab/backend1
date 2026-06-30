const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

const MM = 2.83465;

// 95mm × 125mm
const PAGE_WIDTH = 95 * MM;
const PAGE_HEIGHT = 125 * MM;

async function generateSimpleBadgePDF(badgeData) {
  const {
    name = "Attendee",
    company = "Organization",
    ticket_code = "TICKET",
  } = badgeData;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [PAGE_WIDTH, PAGE_HEIGHT],
        margin: 0,
      });

      const buffers = [];

      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      QRCode.toDataURL(
        ticket_code,
        {
          width: 400,
          margin: 1,
          color: {
            dark: "#000000",
            light: "#FFFFFF",
          },
        },
        (err, qrDataUrl) => {
          if (err) return reject(err);

          // Background
          doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill("#FFFFFF");

          // --------------------------
          // NAME
          // --------------------------
          doc
            .font("Helvetica-Bold")
            .fontSize(16)
            .fillColor("#111111")
            .text(String(name).toUpperCase(), 15, 60, {
              width: PAGE_WIDTH - 30,
              align: "center",
            });

          // --------------------------
          // COMPANY
          // --------------------------
          doc
            .font("Helvetica")
            .fontSize(11)
            .fillColor("#666666")
            .text(String(company), 15, 82, {
              width: PAGE_WIDTH - 30,
              align: "center",
            });

          // --------------------------
          // QR CODE
          // --------------------------
          const qrSize = 110;

          const qrX = (PAGE_WIDTH - qrSize) / 2;
          const qrY = 125;

          const base64 = qrDataUrl.replace(
            /^data:image\/png;base64,/,
            ""
          );

          doc.image(Buffer.from(base64, "base64"), qrX, qrY, {
            width: qrSize,
            height: qrSize,
          });

          doc.end();
        }
      );
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateSimpleBadgePDF,
};