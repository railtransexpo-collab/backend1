const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

async function generateSimpleBadgePDF(badgeData) {
  const {
    name = "Attendee",
    company = "Organization",
    ticket_code = "TICKET",
  } = badgeData;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [350, 490],
        margin: 0,
      });

      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      QRCode.toDataURL(
        ticket_code,
        {
          width: 140,
          margin: 1,
          color: {
            dark: "#000000",
            light: "#FFFFFF",
          },
        },
        (err, qrDataUrl) => {
          if (err) return reject(err);

          doc.rect(0, 0, 350, 490).fill("#FFFFFF");

          // -------------------------
          // NAME (TOP)
          // -------------------------
          doc
            .font("Helvetica-Bold")
            .fontSize(16)
            .fillColor("#111111")
            .text(String(name).toUpperCase(), 25, 60, {
              width: 300,
              align: "center",
            });

          // -------------------------
          // COMPANY
          // -------------------------
          doc
            .font("Helvetica")
            .fontSize(13)
            .fillColor("#666666")
            .text(String(company), 25, 88, {
              width: 300,
              align: "center",
            });

          // -------------------------
          // Divider
          // -------------------------
          doc
            .moveTo(40, 120)
            .lineTo(310, 120)
            .stroke("#d1d5db");

          // -------------------------
          // QR BELOW
          // -------------------------
          const qrSize = 90;
          const qrX = (350 - qrSize) / 2;
          const qrY = 145;

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