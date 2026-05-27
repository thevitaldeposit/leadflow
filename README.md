# LeadFlow

AI-powered CRM lead extraction for automotive dealerships. Extracts structured customer and deal data from sales call transcripts and handwritten up sheet photos using the Anthropic Claude API.

## Setup

### 1. Install dependencies

```bash
npm run setup
```

This installs all packages (server + client) and initializes the SQLite database.

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and add your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3001
DATABASE_PATH=./server/db/leadflow.db
```

### 3. Run the app

```bash
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start both server and client in development mode |
| `npm run server` | Start only the Express backend |
| `npm run client` | Start only the Vite frontend |
| `npm run setup` | Install all dependencies and initialize DB |
| `npm run init-db` | Re-run database migrations |

---

## Testing

### Test with the sample transcript

1. Go to **New Lead → Transcript**
2. Click **Load Sample** to pre-fill the sample transcript below
3. Click **Extract Lead**
4. Review the extracted fields and confidence scores

**Expected extraction from sample:**
- Customer: Mike Patterson
- Phone: 555-312-8847
- Email: mike.patterson@gmail.com
- Vehicle: 2024 Chevrolet Silverado RST (Black, Stock #7842)
- Trade: 2019 Ford F-150, ~62k miles, small dent, ~$12k payoff
- Budget: ~$600/month, $3k down
- Appointment: Saturday at 2pm
- Intent: Warm (shopping 2 weeks), Salesperson: Derek

### Sample transcript

```
[Receptionist]: Thank you for calling Riverside Motors, how can I direct your call?

[Customer]: Yeah hi, I'm calling about a truck I saw on your website. A Silverado, I think it was black.

[Receptionist]: Sure, let me transfer you to our sales team. Can I get your name?

[Customer]: It's Mike. Mike Patterson.

[Receptionist]: One moment please, Mike.

[pause — transfer]

[Salesperson]: Hey this is Derek in sales, how can I help you?

[Customer]: Hey Derek, yeah I was looking online and you guys have a black Silverado listed, I think it was like a 2024? The RST trim?

[Salesperson]: Yeah! I think I know the one you're talking about. Let me pull it up. Yeah, 2024 Silverado RST, black, we've got it right here. Stock number 7842. That's a sharp truck. Are you looking to come take a look at it?

[Customer]: Yeah definitely. I've been shopping around for about two weeks now. I've got a 2019 F-150 I'd be trading in. It's got about 62 thousand miles on it. It's in pretty good shape, just a small dent on the rear bumper.

[Salesperson]: Okay nice, we can definitely take a look at your trade. Do you know if you owe anything on it still?

[Customer]: Yeah I think I still owe about twelve grand on it.

[Salesperson]: Got it. And are you looking to finance the Silverado or...?

[Customer]: Yeah I'd need to finance. I'm trying to stay somewhere around 600 a month if possible. I could probably put about 3 grand down.

[Salesperson]: Okay that gives me a good picture. We can definitely work with that. When were you thinking about coming in?

[Customer]: Well I need to bring my wife to see it too. Could we do Saturday around 2?

[Salesperson]: Saturday at 2 works perfect. Let me get your number so I can confirm with you Friday.

[Customer]: Sure it's 555-312-8847.

[Salesperson]: Got it. And just in case we get disconnected, do you have an email?

[Customer]: Yeah it's mike.patterson@gmail.com

[Salesperson]: Perfect Mike, we'll see you Saturday at 2. I'll have the Silverado pulled up front for you.

[Customer]: Sounds good, thanks Derek.

[Salesperson]: Thank you, have a good one.
```

### Test with an up sheet photo

1. Go to **New Lead → Up Sheet Photo**
2. Upload any photo of a handwritten up sheet (JPG, PNG, or HEIC from your phone)
3. Click **Extract Lead**
4. Compare extracted fields to the original image

---

## Architecture

```
leadflow/
├── client/                    # React + Vite + Tailwind frontend
│   └── src/
│       ├── components/        # Reusable UI components
│       ├── pages/             # Route-level page components
│       └── utils/api.js       # Typed API client
├── server/                    # Express backend
│   ├── routes/
│   │   ├── leads.js           # CRUD + list/filter
│   │   └── extract.js         # AI extraction endpoints
│   ├── services/
│   │   └── extractionEngine.js  # Claude API integration
│   ├── db/
│   │   ├── database.js        # node:sqlite connection (no build tools needed)
│   │   └── schema.sql         # Full leads schema with confidence scores
│   └── prompts/
│       └── extractionPrompt.js  # System prompt for AI extraction
└── .env                       # API key + config (not committed)
```

## Tech Stack

- **Frontend**: React 19, Vite, Tailwind CSS, React Router
- **Backend**: Node.js, Express
- **Database**: SQLite via Node.js built-in `node:sqlite` (no native compilation required)
- **AI**: Anthropic Claude API (`claude-sonnet-4-20250514`)
- **File uploads**: multer

## Upgrading the AI Model

Change the `MODEL` constant in `server/services/extractionEngine.js` to use a different Claude model. Available options:

- `claude-sonnet-4-20250514` — current (fast, accurate)
- `claude-opus-4-5` — highest accuracy, slower

## Migrating to PostgreSQL

The SQL schema uses standard SQL compatible with PostgreSQL. To migrate:
1. Replace `INTEGER PRIMARY KEY AUTOINCREMENT` with `SERIAL PRIMARY KEY`
2. Replace `node:sqlite` with `pg` in `server/db/database.js`
3. Update queries to use `$1, $2` instead of `?` for parameters
