#!/usr/bin/env node
/*
  Simple test script to send an email using `utils/mailer.js`.

  Usage (POSIX shell):
    SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... node utils/test-send-zepto.js recipient@example.com

  Example (export then run):
    export SMTP_HOST="smtp.zeptomail.zoho.in"
    export SMTP_PORT=587
    export SMTP_USER="support@yourdomain.com"
    export SMTP_PASS="<your-zeptomail-smtp-password>"
    node utils/test-send-zepto.js test@yourdomain.com
*/

const path = require('path');
const mailer = require(path.join(__dirname, 'mailer'));

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: node utils/test-send-zepto.js recipient@example.com');
    process.exit(2);
  }

  console.log('Running SMTP verify...');
  try {
    const v = await mailer.verifyTransport();
    console.log('verifyTransport result:', v);
  } catch (e) {
    console.error('verifyTransport threw:', e && e.stack ? e.stack : e);
  }

  console.log('Sending test email to', to);
  const res = await mailer.sendMail({
    to,
    subject: 'Test email from RailTrans backend (ZeptoMail)',
    text: 'This is a test email sent from the backend to verify ZeptoMail/SMTP settings.',
    html: '<p>This is a test email sent from the backend to verify ZeptoMail/SMTP settings.</p>'
  });

  console.log('sendMail result:', res);
  process.exit(res && res.success ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err && err.stack ? err.stack : err);
  process.exit(3);
});
