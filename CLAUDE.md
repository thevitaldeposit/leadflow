# Claude Code Instructions

> These operating rules OVERRIDE default behavior and must be followed exactly.

## Git
- Always commit directly to the `main` branch
- Never create new branches unless explicitly asked
- Always push to `origin main` after committing
- Commit message should be concise and descriptive
- Always commit and push when done with a task

## General
- Do **not** touch Auto Dealer components, Twilio routing, recording, or caller ID
  unless explicitly asked. (The Twilio call flow in `server/routes/webhook.js`,
  `server/services/callService.js`, and the auto-dealer extraction path are
  load-bearing and easy to break — leave them alone unless the task names them.)

---

# Project State (context for future sessions)

_Last updated: 2026-06-15. This section is a living summary of the whole system.
The `README.md` is **stale** (it still describes the original single-vertical
auto-dealer tool) — trust this file and the code over the README._

## What it is

**LeadFlow** (repo/internal name) ships publicly as **Stream** (brand;
marketing + app at **joinstream.app**). It's a multi-tenant, multi-vertical
AI lead-capture CRM for service businesses. A business forwards its phone number
to a Twilio number; Stream records + transcribes calls, uses Claude to extract a
structured lead, scores intent, decides the next action, and (for dumpster
rental) can auto-book a job and text a payment link. First/anchor customer is
**Valley Binz** (a dumpster-rental business), seeded as `business_id = 1`, which
doubles as the Stream **admin** account.

Two names you'll see:
- **Stream** = the public brand (landing page, signup, billing, customer-facing).
- **LeadFlow** = the dashboard/app internals and the repo.

## Tech stack

- **Backend**: Node.js (>=22) + Express. Realtime via Socket.io.
- **Frontend**: React 19 + Vite + Tailwind + React Router (`client/`).
- **DB**: SQLite via the **built-in `node:sqlite`** (`DatabaseSync`) — no native
  compilation. WAL mode, `foreign_keys = ON`.
- **AI extraction**: Anthropic Claude **`claude-sonnet-4-6`** (extraction engines
  + morning brief).
- **Transcription**: OpenAI Whisper (default) or Deepgram (`TRANSCRIPTION_PROVIDER`).
- **Telephony/SMS**: Twilio. **Payments**: Stripe ($149/mo). **Email**: Resend.
- **Push**: APNs (iOS morning-priorities notification).
- **iOS app**: Swift/SwiftUI in `leadflow-ios/` (CallKit call recording).

## Deployment

- Hosted on **Railway** (`railway.json`: NIXPACKS, `npm start`, healthcheck
  `/api/health`, restart on failure).
- Production host: `https://leadflow-production-9c02.up.railway.app`
  (hardcoded as `PAYMENT_BASE_URL` in `server/services/smsService.js`).
  Customer-facing URLs (`DASHBOARD_URL`, `SIGNUP_URL`, `PORTAL_RETURN_URL`,
  password-reset base) are hardcoded to `https://joinstream.app/...` in
  `server/routes/billing.js` and `server/services/authService.js`.
- **DB persistence depends on a mounted Railway volume** at the `DATABASE_PATH`
  directory (e.g. `/data/leadflow.db`). If the volume isn't writable, the server
  falls back to a local DB and logs a loud warning — **data won't survive
  redeploys** in that state (`server/db/database.js`). On boot the server also
  writes a best-effort JSON backup (`leadflow-backup.json`) next to the DB.
- Build serves the React app from `client/dist` (built via `npm run build`).

## Environment variables

Required / used (see `.env.example`, but it is **incomplete** — the full set is):

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude extraction + morning brief (**required**) |
| `OPENAI_API_KEY` | Whisper transcription (default provider) |
| `DEEPGRAM_API_KEY` | Alternate transcription provider |
| `TRANSCRIPTION_PROVIDER` | `openai` (default) or `deepgram` |
| `PORT` | Server port (default 3001) |
| `DATABASE_PATH` | SQLite file path; point at the Railway volume in prod |
| `JWT_SECRET` | **Required for auth** — read lazily; auth endpoints fail clearly if unset |
| `NODE_ENV` | `production` → Secure auth cookies |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | Twilio API + caller ID |
| `USER_PHONE_NUMBER` | Owner cell that inbound calls forward to (E.164) |
| `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` / `STRIPE_WEBHOOK_SECRET` | Billing (all three required for billing) |
| `RESEND_API_KEY` | Transactional email (welcome, password reset) |
| `LEADFLOW_DEFAULT_VERTICAL` | Vertical for Twilio-captured leads (`auto_dealer` default; set `home_services` for Valley Binz) |
| `LEADFLOW_DEFAULT_SUB_VERTICAL` | e.g. `dumpster_rental` |
| `LEADFLOW_DISABLE_MORNING_PUSH` | Disable the 8am APNs push |
| `APNS_PRODUCTION` / `APNS_BUNDLE_ID` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_KEY_CONTENT` or `APNS_KEY_PATH` | iOS push credentials |

## Repo layout

```
server/
  index.js                     # Express app, route mounting, startup (DB retry, backup, cron starts)
  db/
    database.js                # node:sqlite connection (lazy proxy + initDatabase)
    schema.sql                 # LEGACY auto-dealer base table only
    migrations.js              # the REAL schema: all ALTERs, new tables, multi-tenancy, backfills
    clearSeedData.js / seed*.js
  middleware/auth.js           # requireAuth / attachBusiness / requireAdmin
  routes/                      # leads, extract, webhook, upload, devices, inventory, schedule,
                               # settings, payment, auth, signups, contact, dashboard, billing, admin
  services/                    # extractionEngine (auto), verticalExtractionEngine, transcriptionService,
                               # callService, smsService, emailService, businesses, authService,
                               # inventoryService, activityLog, morningBrief, morningPriorities,
                               # recordingCleanup, apns, settingsService, imageProcessor
  prompts/extractionPrompt.js
  public/                      # Twilio audio assets (voicemail greeting, recording notice)
client/src/
  App.jsx                      # routes (guest vs authed, SubscriptionGate)
  pages/ components/ context/AuthContext.jsx utils/verticalConfig.js
leadflow-ios/                  # Swift/SwiftUI CallKit app
```

## Data model

- The real schema = `schema.sql` (base `leads` table, auto-dealer-shaped) **plus**
  everything in `migrations.js`, which runs on every boot and is idempotent
  (attempts `ALTER`/`CREATE`, swallows "duplicate column"/"already exists").
- Key tables: `leads`, `businesses`, `users`, `inventory_pool`, `activity_log`,
  `call_sessions`, `devices`, `settings`, `signups`.
- **Leads** carry flat auto-dealer columns (legacy) **and** a `vertical` /
  `sub_vertical` plus a JSON `vertical_data` blob for vertical-specific fields.
  Home-services promotes key fields to flat columns too (`outcome`, `job_status`,
  `delivery_date`, `scheduled_time`, `pickup_date`, `estimated_revenue`,
  `auto_booked`, `follow_up_date`, `call_type`, etc.).
- `settings` and `inventory_pool` use composite **`UNIQUE(business_id, key|size)`**
  (rebuilt from the old global-unique constraints by a migration).
- `activity_log` is the per-lead timeline (calls, SMS, status changes, notes),
  `ON DELETE CASCADE` with the lead.

## Multi-tenancy & auth

- Every tenant table has a `business_id`. Phase 1 added the tables + columns and
  backfilled existing rows to Valley Binz; Phase 2 wired auth, scoped all queries,
  and scoped Socket.io to per-business rooms (`emitToBusiness`).
- **Auth** (`services/authService.js`, `middleware/auth.js`): JWT (7-day) via
  bcrypt-hashed passwords. Token travels as `Authorization: Bearer` **or** an
  httpOnly `token` cookie. `JWT_SECRET` is read lazily.
  - `requireAuth` — hard guard; attaches `req.user` + `req.business` or 401.
  - `attachBusiness` — soft resolver for shared routes still called without a
    token (the **iOS app**, pre-login web); falls back to the default business
    (Valley Binz). Never 401s.
  - `requireAdmin` — only `business_id = 1` (Stream admin) may reach `/api/admin`.
- Twilio webhooks resolve the tenant by the dialed number
  (`getBusinessIdByTwilioNumber`), falling back to the default business.

## Billing (Stripe, $149/mo)

- `server/routes/billing.js`. Stripe client is lazy (server boots without keys;
  authed billing endpoints return 503 if unconfigured).
- **Signup payment** is embedded (Stripe Elements / PaymentElement): the public,
  unauthenticated `POST /api/billing/public/create-subscription` creates a
  customer + incomplete subscription and returns a PaymentIntent `client_secret`.
  It uses a **second Stripe client pinned to API version `2024-06-20`** so the
  `latest_invoice.payment_intent` expand path stays stable. `POST /api/auth/register`
  then creates the account with the returned Stripe ids and `subscription_status='active'`.
- Also: authed checkout sessions, customer portal, and live status sync.
- **Webhook**: `POST /api/webhook/stripe`, mounted with `express.raw()` **before**
  `express.json()` in `index.js` (signature needs the raw body). Handles
  `checkout.session.completed`, `customer.subscription.updated/deleted`,
  `invoice.payment_failed`.
- **Gating**: `subscription_status` on the business drives a full-screen
  `SubscriptionGate` (client). `/billing` stays reachable outside the gate so a
  blocked account can re-subscribe. Admin-set `trial_days` / `trial_end_date`
  grant beta trials.

## Call-capture pipeline (Twilio) — ⚠️ don't modify unless asked

`server/routes/webhook.js`:
1. Inbound call → `POST /twilio/voice`: plays a recording notice, 2s pause, then
   `<Dial>`s the owner's cell with **caller-ID passthrough** (STIR/SHAKEN intact),
   `record-from-answer-dual`, with a dial-action + dial-status callback.
2. `/twilio/dial-action`: if the owner answered then hung up → `<Hangup>` (no
   voicemail); if the owner never answered → play voicemail greeting + `<Record>`.
3. `/twilio/dial-status`: owner leg ended unanswered → create a **missed-call**
   lead (no voicemail).
4. `/twilio/recording`: download → transcribe → extract → insert lead, emit
   `new_lead`. Answered conversations supersede/merge a recent missed-call
   placeholder from the same number.
5. `/twilio/voicemail-recording`: same, flagged as voicemail (intent capped at
   warm, never auto-booked).
- `call_sessions` stashes caller ID + `business_id` at `/twilio/voice` time for
  the later callbacks (which omit `From`).
- **Click-to-call** (`services/callService.js`): calls the owner first, whispers,
  then dials the lead presenting the Twilio number. Separate from inbound routing.
- **Payment SMS** (`services/smsService.js`): texts a `…/pay/:id` link; respects
  the per-business `smsEnabled` setting.
- **Recording cleanup** (`services/recordingCleanup.js`): daily 2am delete of
  Twilio recordings older than 30 days.

## AI extraction & verticals

- **Verticals**: `auto_dealer` (original, `services/extractionEngine.js`),
  `home_services` (with sub-verticals `dumpster_rental` and `hvac`), and
  `insurance_agent` (config exists). `services/verticalExtractionEngine.js` holds
  the vertical/sub-vertical prompts + output schemas and the post-processing.
- Extraction prompt rules of note: **speaker 0 = business owner**; a
  **business-relevance gate** (`businessRelevant:false` → auto-discard non-business
  calls); confidence 0 → auto-discard personal calls.
- **Home Services intelligence** (in the vertical engine):
  - `intentLevel` (high/warm/cold), `urgency`, `followUpSignal` → an absolute
    `followUpDate` computed in Node (`computeFollowUpDate`), capped so it never
    lands on/after the delivery deadline.
  - **Booking detection**: 5 signals (price agreed, size, date, location, payment
    intent). All 5 → `autoBooked` + `job_status='booked'`; 4 → high-intent
    opportunity. Auto-booking is then **availability-checked** against the
    inventory pool (`inventoryService.enforceAutoBookAvailability`) before any
    payment link is sent.
  - **Dead-end leads** (`requiresFollowUp:false`): kept in All Leads but excluded
    from the Action Queue (follow-up date cleared, intent → cold).
  - Date math (delivery/pickup/rental duration) is recomputed in Node, not trusted
    from the model.

## Home Services dashboard & action logic

- `client/src/utils/verticalConfig.js` is the shared brain for the web UI:
  job-status/intent/urgency vocab + styles, per-sub-vertical **field packs**
  (which fields render on the detail view) and **terminology** (dumpster vs HVAC
  wording), and **`getLeadActionState()`** — the prioritization engine that
  produces the Action Queue buckets (`asap`, `follow_up_due`, `voicemail`,
  `high_intent_new`, `no_delivery_date`, `stale`, `waiting`) and priority scores.
- **Morning Brief** (`services/morningBrief.js`, `GET /api/dashboard/morning-brief`):
  AI COO-style briefing, cached per local day, gated until 6am local.
- **Morning Priorities** (`services/morningPriorities.js`): 8am APNs push to iOS.
- Inventory is **pool-based** (count per size); availability is computed on demand
  from owned quantity vs overlapping active jobs (no per-unit assignment).

## Web app surface

- Routing in `client/src/App.jsx`. Guests get the public site
  (`/` landing, `/login`, `/forgot-password`, `/reset-password`) plus always-public
  `/signup`, `/privacy`, `/terms`, `/contact`. Authed users get the dashboard
  behind `SubscriptionGate` (except `/billing`).
- Authed pages: dashboard home, new lead, lead detail, lead list, settings,
  inventory, schedule, insights, all-leads, filtered views
  (`/action-queue`, `/opportunities`, `/booked`, `/completed`), and `/admin`.
- **Admin panel** (`/admin`, `routes/admin.js`, business 1 only): manage Stream
  customer accounts (set trial, reset password, view signups).
- **Onboarding**: `businesses.onboarding_complete` gates a post-signup banner.

## iOS app

- `leadflow-ios/` — SwiftUI + CallKit, records calls and posts them to the API.
- Backend base URL is user-configurable (`LocalStorageService.backendURL`).
- **Known gap**: the iOS app does **not** send a JWT yet, so its requests resolve
  to the default business (Valley Binz) via `attachBusiness`. Real multi-tenant
  iOS needs token auth.

## Known issues / what to do next

1. **Operational config that must exist in Railway env**: `JWT_SECRET` (auth is
   dead without it) and `STRIPE_WEBHOOK_SECRET` + a Stripe webhook endpoint
   pointing at `/api/webhook/stripe` (statuses won't sync without it).
2. **iOS token auth** — make the app authenticate so it isn't pinned to Valley Binz.
3. **Hardcoded URLs** — `PAYMENT_BASE_URL` and the `joinstream.app` URLs are
   string constants; move to env/config if hosts change.
4. **Stale `README.md`** — rewrite to describe Stream / multi-vertical, or delete.
5. **DB durability** — confirm the Railway volume is mounted/writable so the
   fallback-DB path never silently activates.
6. `schema.sql` is legacy auto-dealer shape; the source of truth for new
   columns/tables is `migrations.js`. Add new schema changes there (idempotent ALTERs).
7. Untracked artifacts exist in the working tree (a voicemail `.m4a`,
   `leadflow-backup.json`, a dashboard reference image) — leave unless asked.
