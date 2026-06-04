const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { getDefaultBusinessId } = require('../services/businesses');

// This is a PUBLIC customer-facing page (opened from an SMS link), so it stays
// unauthenticated — but it must show the lead's OWN business's branding and
// payment handles, so settings are scoped to that business.
function readSettings(businessId) {
  const rows = db.prepare('SELECT key, value FROM settings WHERE business_id = ?').all(businessId);
  const obj = {};
  for (const row of rows) {
    try { obj[row.key] = JSON.parse(row.value); } catch { obj[row.key] = row.value; }
  }
  return obj;
}

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseStyles() {
  return `
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f4f8;color:#1a202c;min-height:100vh}
    .header{background:#1a2744;color:#fff;padding:20px 16px 14px}
    .header-top{display:flex;align-items:center;justify-content:space-between}
    .business-name{font-size:20px;font-weight:700;letter-spacing:-0.3px}
    .lf-badge{font-size:11px;color:rgba(255,255,255,0.55);letter-spacing:0.02em}
    .header-sub{font-size:13px;color:rgba(255,255,255,0.65);margin-top:5px}
    .container{max-width:480px;margin:0 auto;padding:16px 14px 32px}
    .card{background:#fff;border-radius:16px;padding:20px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.07)}
    .section-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:#64748b;margin-bottom:12px}
    .pay-section-label{margin-top:6px;margin-bottom:8px}
    .detail-row{display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid #f1f5f9;gap:12px}
    .detail-row:last-child{border-bottom:none}
    .dl{font-size:13px;color:#64748b;flex-shrink:0}
    .dv{font-size:14px;font-weight:500;text-align:right}
    .total-row{padding-top:14px;margin-top:4px;border-top:2px solid #e2e8f0;border-bottom:none}
    .price-big{font-size:24px;font-weight:800;color:#16a34a}
    .pay-card{background:#fff;border-radius:16px;padding:18px 18px 18px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.07)}
    .pay-header{display:flex;align-items:center;gap:14px;margin-bottom:14px}
    .pay-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;flex-shrink:0;line-height:1}
    .pay-icon-card{background:#e0e7ff;color:#4f46e5}
    .pay-icon-cash{background:#dcfce7;color:#16a34a;font-size:22px}
    .pay-icon-venmo{background:#dbeafe;color:#2563eb}
    .pay-method{font-size:16px;font-weight:700;color:#111}
    .pay-handle{font-size:14px;color:#16a34a;font-weight:600;margin-top:2px}
    .pay-amount{font-size:13px;color:#475569;margin-top:2px}
    .fee-note{color:#94a3b8;font-size:11px}
    .cs-badge{margin-left:auto;background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;padding:3px 9px;border-radius:20px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap;align-self:flex-start}
    .btn{display:block;width:100%;padding:16px;border-radius:12px;font-size:16px;font-weight:700;text-align:center;text-decoration:none;border:none;cursor:pointer;letter-spacing:0.01em;-webkit-tap-highlight-color:transparent}
    .btn:active{opacity:0.85}
    .btn-green{background:#16a34a;color:#fff}
    .btn-blue{background:#2563eb;color:#fff}
    .btn-gray{background:#475569;color:#fff}
    .btn-disabled{background:#e2e8f0;color:#94a3b8;cursor:not-allowed}
    .unavailable{padding:14px;background:#f8fafc;border-radius:10px;color:#64748b;font-size:14px;text-align:center;border:1px dashed #cbd5e1}
    .manual{display:none;margin-top:12px;background:#f0fdf4;border-radius:10px;padding:12px 16px;color:#166534;font-size:14px;line-height:1.5}
    .text-center{text-align:center}
    .muted{color:#64748b;font-size:14px;margin-top:8px;line-height:1.6}
    .icon-circle{width:58px;height:58px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 16px}
    .icon-green{background:#dcfce7;color:#16a34a}
    .icon-gray{background:#f1f5f9;color:#64748b}
    .footer{padding:20px 0 8px;text-align:center;color:#64748b;font-size:13px;line-height:2.1}
    .footer a{color:#2563eb;text-decoration:none}
    .small-print{font-size:11px;color:#94a3b8;margin-top:6px;line-height:1.6}
    h2{font-size:20px;font-weight:700;color:#1a202c}
  `;
}

function shell(businessName, title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${esc(title)}</title>
<style>${baseStyles()}</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <span class="business-name">${esc(businessName)}</span>
    <span class="lf-badge">&#9889; LeadFlow</span>
  </div>
  <p class="header-sub">Secure Payment</p>
</div>
<div class="container">${body}</div>
</body>
</html>`;
}

// GET /pay/:jobId
router.get('/:jobId', (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.jobId);
    // Use the lead's business for branding; fall back to the default tenant when
    // the link points at a non-existent lead so the "not found" page still renders.
    const settings = readSettings(lead ? lead.business_id : getDefaultBusinessId());

    const businessName = settings.businessName || 'LeadFlow Business';
    const cashAppHandle = settings.cashAppHandle || null;
    const venmoHandle = settings.venmoHandle || null;
    const squareApiKey = settings.squareApiKey || null;
    const businessPhone = settings.businessPhone || process.env.USER_PHONE_NUMBER || null;

    if (!lead) {
      return res.type('text/html').send(shell(businessName, 'Payment Link Not Found', `
        <div class="card text-center" style="margin-top:24px">
          <div class="icon-circle icon-gray">&#10007;</div>
          <h2>Payment Link Not Found</h2>
          <p class="muted">This payment link is invalid or has expired.<br>Please contact the business for a new link.</p>
        </div>
        <div class="footer">${businessPhone ? `<p>Questions? Call <a href="tel:${esc(businessPhone)}">${esc(businessPhone)}</a></p>` : ''}<p>Powered by <strong>LeadFlow</strong></p></div>
      `));
    }

    if (lead.paid_at) {
      const paidDate = new Date(lead.paid_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      return res.type('text/html').send(shell(businessName, 'Payment Received', `
        <div class="card text-center" style="margin-top:24px">
          <div class="icon-circle icon-green">&#10003;</div>
          <h2>Payment Already Received</h2>
          <p class="muted">Thank you! Your payment was recorded on ${esc(paidDate)}.<br>No further action is needed.</p>
        </div>
        <div class="footer">${businessPhone ? `<p>Questions? Call <a href="tel:${esc(businessPhone)}">${esc(businessPhone)}</a></p>` : ''}<p>Powered by <strong>LeadFlow</strong></p></div>
      `));
    }

    let vd = {};
    try { vd = JSON.parse(lead.vertical_data || '{}'); } catch {}

    const customerName = vd.customerName
      || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
      || 'Valued Customer';
    const dumpsterSize = vd.dumpsterSize || null;
    const serviceName = dumpsterSize ? `${dumpsterSize} Dumpster Rental` : 'Dumpster Rental';
    const deliveryDate = formatDate(lead.delivery_date);
    const pickupDate = formatDate(lead.pickup_date);
    const rentalDuration = vd.rentalDuration || null;
    const deliveryAddress = vd.deliveryAddress || lead.address || null;

    const rawPrice = vd.quotedPrice ? parseFloat(String(vd.quotedPrice).replace(/[^0-9.]/g, '')) : null;
    const quotedPrice = rawPrice && !isNaN(rawPrice) ? rawPrice : null;
    const squareTotal = quotedPrice ? Math.round(quotedPrice * 1.035 * 100) / 100 : null;
    const squareFee = quotedPrice && squareTotal ? Math.round((squareTotal - quotedPrice) * 100) / 100 : null;

    const priceStr = quotedPrice ? `$${quotedPrice.toFixed(2)}` : 'Contact for price';
    const squarePriceStr = squareTotal ? `$${squareTotal.toFixed(2)}` : null;
    const squareFeeStr = squareFee ? `$${squareFee.toFixed(2)}` : null;

    const jobNote = `${serviceName}${deliveryDate ? ' - ' + deliveryDate : ''}`;

    const cashDeepLink = cashAppHandle && quotedPrice
      ? `cashapp://pay?recipient=${cashAppHandle}&amount=${quotedPrice.toFixed(2)}&note=${encodeURIComponent(jobNote)}`
      : null;
    const venmoDeepLink = venmoHandle && quotedPrice
      ? `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(venmoHandle)}&amount=${quotedPrice.toFixed(2)}&note=${encodeURIComponent(jobNote)}`
      : null;

    const detailRows = [
      ['Customer', customerName],
      ['Service', serviceName],
      deliveryDate ? ['Delivery', deliveryDate] : null,
      pickupDate ? ['Pickup', pickupDate] : null,
      rentalDuration ? ['Duration', rentalDuration] : null,
      deliveryAddress ? ['Address', deliveryAddress] : null,
    ].filter(Boolean);

    const detailRowsHtml = detailRows.map(([l, v]) =>
      `<div class="detail-row"><span class="dl">${esc(l)}</span><span class="dv">${esc(v)}</span></div>`
    ).join('');

    const cashBtn = cashDeepLink
      ? `<a href="${esc(cashDeepLink)}" class="btn btn-green" onclick="showAfter('cashapp-manual')">Open Cash App &#8594;</a>`
      : cashAppHandle
        ? `<button class="btn btn-gray" onclick="show('cashapp-manual')">View Cash App Details</button>`
        : '';

    const cashManual = cashAppHandle
      ? `<div class="manual" id="cashapp-manual"><strong>Send ${priceStr} to ${esc(cashAppHandle)} in Cash App.</strong><br>Search for the handle, verify the name, then send the exact amount shown above.</div>`
      : '';

    const venmoBtn = venmoDeepLink
      ? `<a href="${esc(venmoDeepLink)}" class="btn btn-blue" onclick="showAfter('venmo-manual')">Open Venmo &#8594;</a>`
      : venmoHandle
        ? `<button class="btn btn-gray" onclick="show('venmo-manual')">View Venmo Details</button>`
        : '';

    const venmoManual = venmoHandle
      ? `<div class="manual" id="venmo-manual"><strong>Send ${priceStr} to ${esc(venmoHandle)} in Venmo.</strong><br>Search for the handle, verify the name, then send the exact amount shown above.</div>`
      : '';

    const footerPhone = businessPhone ? `<p>Questions? Call <a href="tel:${esc(businessPhone)}">${esc(businessPhone)}</a></p>` : '';

    const body = `
      <div class="card">
        <p class="section-label">Job Details</p>
        ${detailRowsHtml}
        <div class="detail-row total-row">
          <span class="dl">Total Due</span>
          <span class="dv price-big">${priceStr}</span>
        </div>
      </div>

      <p class="section-label pay-section-label">Choose Payment Method</p>

      <!-- Square — Coming Soon -->
      <div class="pay-card">
        <div class="pay-header">
          <div class="pay-icon pay-icon-card">&#128179;</div>
          <div>
            <div class="pay-method">Pay with Card</div>
            ${squarePriceStr ? `<div class="pay-amount">${squarePriceStr} <span class="fee-note">includes 3.5% fee (${squareFeeStr})</span></div>` : ''}
          </div>
          <span class="cs-badge">Coming Soon</span>
        </div>
        <button class="btn btn-disabled" disabled>Card Payments Coming Soon</button>
      </div>

      <!-- Cash App -->
      <div class="pay-card">
        <div class="pay-header">
          <div class="pay-icon pay-icon-cash">$</div>
          <div>
            <div class="pay-method">Pay with Cash App</div>
            ${cashAppHandle ? `<div class="pay-handle">${esc(cashAppHandle)}</div>` : ''}
            ${quotedPrice ? `<div class="pay-amount">${priceStr} <span class="fee-note">no processing fee</span></div>` : ''}
          </div>
        </div>
        ${cashBtn || `<div class="unavailable">Cash App handle not configured &mdash; contact business to arrange payment</div>`}
        ${cashManual}
      </div>

      <!-- Venmo -->
      <div class="pay-card">
        <div class="pay-header">
          <div class="pay-icon pay-icon-venmo">V</div>
          <div>
            <div class="pay-method">Pay with Venmo</div>
            ${venmoHandle ? `<div class="pay-handle">${esc(venmoHandle)}</div>` : ''}
            ${quotedPrice ? `<div class="pay-amount">${priceStr} <span class="fee-note">no processing fee</span></div>` : ''}
          </div>
        </div>
        ${venmoBtn || `<div class="unavailable">Venmo handle not configured &mdash; contact business to arrange payment</div>`}
        ${venmoManual}
      </div>

      <div class="footer">
        ${footerPhone}
        <p>Powered by <strong>LeadFlow</strong></p>
        <p class="small-print">Cash App and Venmo payments are peer-to-peer transfers.<br>Square payments are processed securely.</p>
      </div>

      <script>
        function show(id){var el=document.getElementById(id);if(el)el.style.display='block';}
        function showAfter(id){setTimeout(function(){show(id);},1200);}
      </script>
    `;

    res.type('text/html').send(shell(businessName, `Pay ${businessName}`, body));
  } catch (err) {
    console.error('[payment] Error rendering payment page:', err);
    res.status(500).type('text/html').send('<h1 style="font-family:sans-serif;padding:40px">Error loading payment page. Please contact the business.</h1>');
  }
});

module.exports = router;
