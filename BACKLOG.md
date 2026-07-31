# Stream — Master Backlog

> Source: project handoff + build sessions + repo TODO/notes harvest. Deduplicated and triaged. `file:line` refs included where known. Living source of truth — update on every build.

---

## 0. Done (recent)
- [x] Call-intent classifier: Part 1 + 1b (swap+extension together) + Part 2 (editable review → approve → send → sign → pay)
- [x] Swap Fix A — paid swap keeps job open until replacement pickup (no premature completion / orphaned inquiry)
- [x] Swap Fix B — correct swap duration (tz-safe day count) + editable swap delivery date on review screen
- [x] Review-flow UX — review item now inserts into the Action Queue **live** (upsert on `lead_updated`, no manual refresh); rows show the linked customer's **real name** (server-resolved via `customer_id`, plain lookup); in-row **Review** is the obvious primary action (whole card opens the editor, keeps Discard); **Add from rates** fills the real per-size price from `pricing_config` (not the NULL legacy `unit_price`)

---

## 1. Blocks customer #1 (must-fix before a second business onboards)
- [ ] **Auth/tenant leak (top priority).** `attachBusiness` (auth.js:78-93) never 401s — no/invalid token falls back to Valley Binz (business_id=1). Unauthenticated routes under it: reads `GET /all` (leads.js:307), `GET /`, `GET /:id`, `/:id/activity`, `/:id/customer`; mutations `PUT /:id` (:381), `DELETE /:id` (:1203), `POST /:id/call` (:609), `resend-payment-sms` (:582); plus `upload.js`, `devices.js`, `voice.js` routers and `socket.js:51,71`. (Already guarded: `/manual`, `/:id/dump-ticket`, `/:id/cancel`, `/:id/invoice-review*`.)
- [ ] **New-business onboarding.** Guided setup not built (only OnboardingBanner + Calendly + admin flag, admin.js:140-152). Gate: pricing required before booking. Connect the business's own Twilio number + Stripe Connect (Express).
- [ ] **Default vertical for a new tenant.** `LEADFLOW_DEFAULT_VERTICAL` defaults Twilio leads to `auto_dealer`; a home-services business needs `home_services` (webhook.js:367…).
- [ ] **Env/config prerequisites per tenant:** `JWT_SECRET`, `STRIPE_WEBHOOK_SECRET` + webhook, `STRIPE_CONNECT_WEBHOOK_SECRET` + connected-accounts webhook, hardcoded URLs → env.
- [ ] **Confirm Railway volume mounted/writable** so the fallback-DB path never silently activates.

## 2. Correctness sharp-edges (wrong output for a live business — near-term)
- [ ] **Contracts ship with literal `_____` blank fill-ins** (contractTemplates.js:25-59). Real customers sign these now.
- [ ] **Invoice dedup is per-`lead_id`** → follow-up calls can duplicate invoices. Needs engagement/customer-level dedup.
- [ ] **Cancellation never fires from a call.** Marker read/cleared but never set; producer stub (HANDOFF §10.5).
- [ ] **Owner can't edit a job's delivery address.** No UI field (leads.js:879); writes to `leads.vertical_data.deliveryAddress`.
- [ ] **Auto-correct customer name spelling.** Customer name is written once and never overwritten (`enrichCustomerFromLead`, customerService.js:90-92 only fills blank fields), so an early wrong spelling persists and prints on invoices. Recognize an authoritative spelling (customer spells it at booking) and update the stored name.
- [ ] **Dump-ticket / weight-entry rework (next).** (a) tons-vs-lbs input default confusion; (b) editing a recorded weight doesn't update the dump-ticket section or the activity feed; (c) swap-out checkbox double-arm — checking the box (CustomerDetailPage.jsx:1039) while a PAID call-driven swap has armed `vd.pendingSwapOuts` runs the manual `swap` branch (jobLifecycle.js:297-298) WITHOUT consuming the marker, so the next (final-pickup) ticket is ALSO treated as a swap-out and the job needs an extra ticket to complete. Fix = single source of truth (marker authoritative / consume on manual check / make the UI marker-aware).
- [ ] **Verify legacy `/pay` state.** Harvest says `/pay/:leadId` page + `sendPaymentLinkEmail` may still exist as a disabled stub and booking may still email the legacy link. Finish removal → `/invoice/:token`.

## 3. Known functional gaps (needed, not blocking)
- [ ] **Concurrent multi-job** — one open job per customer; multi-site contractors unsupported (structural) + multi-job pricing override + "which job is this call about?"
- [ ] **Delivery-vs-pickup date-change classification** — never built.
- [ ] **Swap availability/inventory** — replacement invisible to availability pool.
- [ ] **Weight display + driver weight-entry** on the profile.
- [ ] **Overage config dual-source cleanup** (pricing_config vs legacy settings).
- [ ] **Inquiry auto-book backfill** — deferred.
- [ ] **Single pending-change/draft limit** — 2nd pending change per job is skipped.

## 4. Features not started (bigger builds)
- [ ] **Dispatch** — scope TBD.
- [ ] **Driver / limited-user view** — iOS role reserved, no UI (AuthManager.swift:40-46).
- [ ] **Mileage / distance pricing + geocoding/mapping** — configurable but never computed (pricingService.js:312-313).
- [ ] **Per-business contract builder** — inert seam (invoiceService.js:767-768); no Settings editor.
- [ ] **Full Insights/analytics page** — stub over morning brief (InsightsPage.jsx:50-54).
- [ ] **Photo-OCR dump tickets** — only `source:'manual'` wired.
- [ ] **A2P 10DLC + payment SMS** — compliance pages only; SMS paused.
- [ ] **In-app voicemail access (high owner-impact)** — calls forward to the app, bypassing native iPhone voicemail; voicemails are only listenable on the web app. Add in-app playback + a new-voicemail notification; verify whether native carrier voicemail can be restored.
- [ ] **Future verticals** — insurance_agent + HVAC (extraction only).

## 5. iOS / infra
- [ ] **iOS incoming-call ring bug** — memory says no ring / no CallKit screen (APNs sandbox↔prod suspected). Verify — recent live calls worked, may be stale.
- [ ] **In-app VoIP token endpoint 503s** until Twilio SIDs set (voice.js:28-42).
- [ ] **Outbound dial** — point Twilio TwiML App Voice URL at `/api/voice/outbound`; keep caller ID +18155030701 Verified.
- [ ] **iOS JWT auth** — verify current attachment state.
- [ ] **LeadFlow→Stream rebrand in iOS** — bundle id/types still "LeadFlow." Cosmetic.
- [ ] **APNs prod toggle** — `APNS_PRODUCTION` (apns.js:5).

## 6. Cleanup / dead code / stale docs
- [ ] Delete dead client code: `LeadDetailPage.jsx`, `LeadCardExpanded.jsx`, `ConfidenceMeter.jsx`; unused `sendPaymentSms` import (webhook.js:12).
- [ ] Legacy auto-dealer UI behind the "Auto Dealer" tab — vestigial, still reachable.
- [ ] Vestigial schema fields (assigned_dumpster_id, needs_dumpster_assignment, duplicate ALTER, retired mid-states).
- [ ] Stale comments: pricingService.js:15/:89 "Prompt B not wired" (overage IS wired).
- [ ] Rewrite or delete stale `README.md`.

## 7. Already built / by-design — DO NOT chase
- Overage pricing IS wired (jobLifecycle.js:205-235). Online card payment IS live (Stripe Connect/publicInvoices). Inventory is intentionally pool-based. Multi-job = read-time engagements. Call-intent Part 1/2 + swap fixes shipped.
