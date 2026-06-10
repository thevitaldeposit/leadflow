const express = require('express');
const router = express.Router();
const { sendContactNotification, sendContactConfirmation } = require('../services/emailService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBJECTS = ['General Inquiry', 'Sales', 'Support', 'Partnership', 'Other'];

// POST /api/contact — PUBLIC (no auth). Relays a contact-form submission from the
// marketing site to info@joinstream.app via Resend and sends the submitter a
// confirmation receipt.
router.post('/', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const cleanName = String(name).trim();
    const cleanEmail = String(email).trim();
    // Only honor a subject from the known set; anything else falls back to the default.
    const cleanSubject = SUBJECTS.includes(subject) ? subject : 'General Inquiry';
    const cleanMessage = String(message).trim();

    // The notification to the team is what matters; if the confirmation receipt
    // fails we don't want to report an error to the submitter.
    await sendContactNotification({
      name: cleanName,
      email: cleanEmail,
      subject: cleanSubject,
      message: cleanMessage,
    });

    try {
      await sendContactConfirmation({ name: cleanName, email: cleanEmail });
    } catch (confirmErr) {
      console.error('POST /contact confirmation email failed:', confirmErr);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('POST /contact error:', err);
    res.status(500).json({ error: 'Failed to send your message' });
  }
});

module.exports = router;
