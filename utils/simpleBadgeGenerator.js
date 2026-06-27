const puppeteer = require("puppeteer");
const QRCode = require("qrcode");

async function generateSimpleBadgePDF(badgeData) {
  const { name = "Attendee", company = "Organization", ticket_code = "TICKET" } = badgeData;
  
  // Generate QR code as data URL
  const qrDataUrl = await QRCode.toDataURL(ticket_code, {
    width: 200,
    margin: 2,
    color: {
      dark: "#1a1a1a",
      light: "#ffffff"
    }
  });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          background: white;
          font-family: Arial, Helvetica, sans-serif;
        }
        .badge {
          width: 350px;
          height: 490px;
          background: white;
          padding: 30px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
        }
        .qr-container {
          width: 160px;
          height: 160px;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 10px;
        }
        .qr-container img {
          width: 100%;
          height: 100%;
        }
        .separator {
          width: 80%;
          height: 1px;
          background: #d1d5db;
          margin: 15px 0 15px 0;
        }
        .name {
          font-size: 22px;
          font-weight: 700;
          color: #1a1a1a;
          text-align: center;
          letter-spacing: 0.5px;
          line-height: 1.3;
          text-transform: uppercase;
        }
        .org {
          font-size: 14px;
          font-weight: 500;
          color: #6b7280;
          text-align: center;
          letter-spacing: 0.3px;
          margin-top: 4px;
        }
        .qr-label {
          font-size: 9px;
          color: #9ca3af;
          text-transform: uppercase;
          letter-spacing: 2px;
          margin-top: 5px;
        }
      </style>
    </head>
    <body>
      <div class="badge">
        <div class="qr-container">
          <img src="${qrDataUrl}" alt="QR Code" />
        </div>
        <div class="qr-label">SCAN ME</div>
        <div class="separator"></div>
        <div class="name">${name.toUpperCase()}</div>
        <div class="org">${company}</div>
      </div>
    </body>
    </html>
  `;

  // Launch puppeteer and generate PDF
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    
    // Generate PDF with exact dimensions
    const pdf = await page.pdf({
      width: "350px",
      height: "490px",
      printBackground: true,
      margin: {
        top: "0px",
        right: "0px",
        bottom: "0px",
        left: "0px"
      }
    });
    
    return pdf;
  } catch (error) {
    console.error("Error generating simple badge PDF:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { generateSimpleBadgePDF };