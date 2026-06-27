const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

async function generateSimpleBadgePDF(badgeData) {
  const { name = "Attendee", company = "Organization", ticket_code = "TICKET" } = badgeData;
  
  console.log("[simpleBadgeGenerator] Generating badge for:", { name, company, ticket_code });
  
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [350, 490],
        margin: 30,
      });
      
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      
      // Generate QR code
      QRCode.toDataURL(ticket_code, {
        width: 200,
        margin: 2,
        color: {
          dark: "#1a1a1a",
          light: "#ffffff"
        }
      }, (err, qrDataUrl) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Draw badge
        // Background
        doc.rect(0, 0, 350, 490).fill('#ffffff');
        
        // Border
        doc.rect(10, 10, 330, 470).stroke('#e5e7eb');
        
        // QR Code
        const qrSize = 160;
        const qrX = (350 - qrSize) / 2;
        const qrY = 60;
        
        // Convert base64 to image buffer
        const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
        const imageBuffer = Buffer.from(base64Data, 'base64');
        doc.image(imageBuffer, qrX, qrY, { width: qrSize, height: qrSize });
        
        // Label
        doc.fontSize(9)
           .fillColor('#9ca3af')
           .text('SCAN ME', 175, qrY + qrSize + 10, { align: 'center' });
        
        // Separator line
        const lineY = qrY + qrSize + 40;
        doc.moveTo(50, lineY)
           .lineTo(300, lineY)
           .stroke('#d1d5db');
        
        // Name
        doc.fontSize(22)
           .font('Helvetica-Bold')
           .fillColor('#1a1a1a')
           .text(String(name).toUpperCase(), 175, lineY + 25, { 
             align: 'center',
             width: 290
           });
        
        // Organization
        doc.fontSize(14)
           .font('Helvetica')
           .fillColor('#6b7280')
           .text(String(company), 175, lineY + 55, { 
             align: 'center',
             width: 290
           });
        
        doc.end();
      });
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { generateSimpleBadgePDF };