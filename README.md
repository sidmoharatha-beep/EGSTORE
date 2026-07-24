# EGSTORE — Engineering Store Inventory Management

Single Cloudflare Worker (API + static frontend) backed by D1. No build step —
deploy with `wrangler` the same way you deploy Sentinel.

## What it does

- **Item master** — all 2,111 items from your store register (SAP code, description,
  UoM, price, ROL/ROQ, vendor, machine/location, etc.)
- **Dashboard** — total items, stock value, items below ROL (reorder level), pending
  approvals, open purchase indents.
- **Issue workflow** — an **issuer** logs in, searches an item (or scans its QR code),
  requests a quantity. A **store incharge** sees the pending queue, approves or
  rejects. On approval, stock is deducted automatically and logged to a stock ledger.
- **Auto low-stock → purchase indent** — when an approval drops stock to/below ROL,
  a purchase indent is auto-created (qty = ROQ). Store incharge can also bulk-generate
  indents for everything currently below threshold. Marking an indent "received"
  adds the received qty back to stock.
- **QR codes per item** — Store Incharge → "QR Codes": search/select items, generate
  a printable label grid, print, and stick them on the racks. Each code encodes
  `<your-app-url>#/item/<sap_code>`. Scanning it (any phone camera or QR app) opens
  that item's screen directly — store incharge sees receive-stock / edit-threshold
  actions, issuer sees stock + a "Request Issue" shortcut.
- **Issue Log with CSV download** — Store Incharge → "Issue Log": every issue
  record (who requested it, who approved it, quantity, purpose/machine, timestamps),
  filterable by date range, status, and item/requester text search. "Download CSV"
  pulls the full filtered set (not just the 200-row on-screen preview) as a file —
  the report for "who issued what, when, and for what purpose."
  already in the register (your 2,112th item onward), with its own ROL/ROQ set at
  creation.
- **Bulk receipt via Excel + Workers AI** — Store Incharge → "Bulk Receipt (AI)":
  upload the purchase/GRN excel as received from a vendor, in whatever column layout
  it comes in. The file is parsed client-side (SheetJS) and sent to Cloudflare
  Workers AI (`@cf/meta/llama-3.1-8b-instruct`), which maps the columns to
  SAP code / description / quantity. **Nothing is written to the database until
  the store incharge reviews and edits the extracted table and clicks Confirm** —
  AI extraction from messy spreadsheets isn't 100% reliable, so this is a
  human-in-the-loop step, not a blind auto-import. Matched SAP codes get stock
  added; unmatched rows create new items.
- **Roles**: `admin`, `store_incharge`, `issuer` — each sees only the nav items
  relevant to their role. **User creation and password resets are restricted to
  `store_incharge`** (issuers cannot create accounts or reset passwords).

## 1. Prerequisites

```bash
npm install -g wrangler
wrangler login
```

## 2. Create the D1 database

```bash
cd egstore
npm install
wrangler d1 create egstore-db
```

Copy the `database_id` it prints into `wrangler.toml` (replace
`REPLACE_WITH_YOUR_D1_DATABASE_ID`).

## 3. Set the JWT secret

```bash
wrangler secret put JWT_SECRET
# paste any long random string when prompted
```

## 3b. Workers AI (for Bulk Receipt)

No extra signup needed — Workers AI is enabled by the `[ai]` binding already in
`wrangler.toml`. It's billed per request on Cloudflare's usual Workers AI pricing;
check current rates at https://developers.cloudflare.com/workers-ai/platform/pricing/
before rolling it out at volume.

## 4. Load schema + your data

```bash
npm run db:schema        # creates tables
npm run db:seed-items    # loads all 2,111 items from your CSV
npm run db:seed-users    # creates 3 starter accounts
```

Starter accounts (all use password `ChangeMe123!` — **change immediately**):

| username | role |
|---|---|
| admin | admin |
| store1 | store_incharge |
| issuer1 | issuer |

To add real staff accounts, log in as `admin` and use the **Users** tab in the app
(or POST to `/api/users`).

## 5. Deploy

```bash
npm run deploy
```

Wrangler will print your live URL, e.g. `https://egstore.<your-subdomain>.workers.dev`
(you can also point a custom domain at it later, same as you did for Sentinel).

## 6. Local testing before you deploy

```bash
npm run db:schema:local
npm run db:seed-items:local
npm run db:seed-users:local
npm run dev
```

Opens on `http://localhost:8787`.

## Re-syncing data from Excel later

Whenever the manual Excel register is updated, export it to CSV in the same column
layout and re-run:

```bash
python3 scripts/csv_to_sql.py path/to/new_export.csv seed_data.sql
```

This regenerates `seed_data.sql` with de-duplicated SAP codes. **Important:** re-running
`db:seed-items` will fail on duplicate primary keys — for updates rather than a fresh
load, tell me and I'll write an `INSERT OR REPLACE` / upsert variant instead of a
straight re-seed, so you don't wipe stock levels that have moved since the export.

## Fixes applied (July 2026)

Two issues were reported on the live deployment — "pages not responding" and
"QR codes not generating" — both traced to the same root cause plus one
routing gap:

1. **QR codes / bulk-receipt Excel parsing failing silently.** The app was
   loading the `qrcode` and `xlsx` JS libraries from `cdn.jsdelivr.net` at
   runtime. On a managed/enterprise browser (the kind that shows "Action
   required" in the toolbar, common on company laptops), IT policy often
   blocks unlisted CDN domains — the script tag fails, `QRCodeLib`/`XLSX`
   never get defined, and clicking "Generate Labels" or uploading an Excel
   file does nothing with no visible error to the user. **Fix:** both
   libraries are now bundled and served from the app itself
   (`public/vendor/qrcode.min.js`, `public/vendor/xlsx.min.js`) — zero
   external network calls at runtime, works on any restricted network.
   Tailwind is left on its CDN since it loaded fine in your screenshot; if
   that ever gets blocked too, say so and it can be self-hosted the same way.

2. **`/api/*` requests could be swallowed by static-asset routing.**
   `wrangler.toml` had `not_found_handling = "single-page-application"`,
   which returns `index.html` for *any* unmatched path — including API calls,
   since they don't correspond to a physical file. The app's `fetch()` helper
   was tolerant of a bad JSON response (defaults to `{}`) rather than
   surfacing an error, so a page could silently render with no data instead
   of failing loudly. Since navigation here is hash-based (`#/item/...`),
   there was never a need for SPA path fallback in the first place — it's
   removed, and `/api/*` is now pinned with `run_worker_first` so it always
   reaches the Worker directly.

3. **Logo.** Your EGSTORE mark is now the favicon and appears in the header
   and login screen (`public/logo-header.png`, `public/favicon*.png`).

4. **Deploy error: `assets.run_worker_first` type mismatch.** Your installed
   Wrangler is v3.114.17, and the array form (`["/api/*"]`) is a Wrangler v4
   feature — v3 only accepts `true`/`false`. Fixed by using
   `run_worker_first = true` (works on v3 and v4) and having the Worker itself
   serve static files via `env.ASSETS.fetch(request)` for any path that isn't
   `/api/*`. No Wrangler upgrade required, though upgrading later
   (`npm install --save-dev wrangler@4`) is still worth doing at some point —
   Cloudflare's warning about v3 going out of date is real.

5. **`node_modules` got committed to GitHub** (that 42 MB push, and the 70 MB
   `workerd.exe` warning) — it was already tracked in git *before* `.gitignore`
   was added, so the ignore rule didn't retroactively remove it. Clean it up
   once from `D:\egstore`:
   ```powershell
   git rm -r --cached node_modules
   git commit -m "Stop tracking node_modules"
   git push
   ```
   `.gitignore` already lists `node_modules/`, so it won't come back.

6. **Mobile responsiveness.** The nav bar had 9 tabs in a single row with no
   wrap handling — fine on desktop, broken on a phone. It now collapses into
   a hamburger menu below `md` breakpoint (tap the ☰ icon top-right), the
   login card no longer overflows narrow screens, and the QR label preview
   grid adjusts from 2 columns on phones up to 4 on desktop. Data tables
   (Items, Issue Log, Approvals, Purchase Indents) scroll horizontally on
   narrow screens rather than breaking layout — standard pattern for
   dense tabular data on mobile, though if you'd rather have a card-style
   layout for those on phones specifically, say so and I'll build it.

### If you update the QR/Excel libraries later

```powershell
npm install qrcode xlsx esbuild --no-save
node_modules/.bin/esbuild node_modules/qrcode/lib/browser.js --bundle --minify --format=iife --global-name=QRCodeLib --outfile=public/vendor/qrcode.min.js
cp node_modules/xlsx/dist/xlsx.full.min.js public/vendor/xlsx.min.js
```

## Architecture

```
Browser (public/index.html — vanilla JS, no build step)
   │  fetch() calls to /api/*
   ▼
Cloudflare Worker (src/index.js)
   │  - JWT auth (HMAC-SHA256, Web Crypto — no external deps)
   │  - PBKDF2 password hashing
   │  - REST API: items, issues, approvals, purchase indents, dashboard
   ▼
Cloudflare D1 (SQLite) — schema.sql
```

## What's intentionally left for a next pass

- No self-service "change my own password" screen for issuers — store incharge
  resets it for them via Users → Reset Password. Fine for a small team; say the
  word if you want issuers to change their own.
- No CSV export of current stock back out of the app (easy to add — a
  `/api/items/export` endpoint streaming CSV).
- No email/SMS notification when stock crosses threshold — currently it's
  dashboard-only. Could hook into a mail API from the Worker if wanted.
- No photo/attachment per item.
- Single "store" — if you eventually run multiple physical stores, items would need
  a `store_id` column and the whole schema would need light rework.
- Bulk Receipt AI extraction is capped at ~400 rows per upload to keep the prompt
  size reasonable — for bigger GRNs, split the file or ask me to add chunked
  processing.
- QR label print layout is a plain 3-column grid — if you want it sized to specific
  label sheets (e.g. 3M/Avery sticker rolls), tell me the label dimensions and I'll
  tune the print CSS.

Tell me which of these matters most and I'll build it next.
