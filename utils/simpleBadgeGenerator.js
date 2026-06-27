const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

async function generateSimpleBadgePDF(badgeData) {
  const { name = "Attendee", company = "Organization", ticket_code = "TICKET" } = badgeData;
  
  console.log("[simpleBadgeGenerator] Generating badge for:", { name, company, ticket_code });
  
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [350, 490],
        margin: 0, // No margins
      });
      
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      
      // Generate QR code
      QRCode.toDataURL(ticket_code, {
        width: 180, // Smaller QR
        margin: 1,
        color: {
          dark: "#1a1a1a",
          light: "#ffffff"
        }
      }, (err, qrDataUrl) => {
        if (err) {
          reject(err);
          return;
        }
        
        // White background
        doc.rect(0, 0, 350, 490).fill('#ffffff');
        
        // QR Code - centered
        const qrSize = 120; // Smaller QR
        const qrX = (350 - qrSize) / 2;
        const qrY = 80; // Position from top
        
        // Convert base64 to image buffer
        const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
        const imageBuffer = Buffer.from(base64Data, 'base64');
        doc.image(imageBuffer, qrX, qrY, { width: qrSize, height: qrSize });
        
        // Separator line (thin, closer to QR)
        const lineY = qrY + qrSize + 20;
        doc.moveTo(40, lineY)
           .lineTo(310, lineY)
           .stroke('#d1d5db');
        
        // Name - directly below line with minimal spacing
        doc.fontSize(20)
           .font('Helvetica-Bold')
           .fillColor('#1a1a1a')
           .text(String(name).toUpperCase(), 0, lineY + 15, { 
             align: 'center',
             width: 350
           });
        
        // Organization - small gap below name
        doc.fontSize(13)
           .font('Helvetica')
           .fillColor('#6b7280')
           .text(String(company), 0, lineY + 42, { 
             align: 'center',
             width: 350
           });
        
        doc.end();
      });
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { generateSimpleBadgePDF };