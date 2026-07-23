-- EGSTORE Inventory Management Schema (Cloudflare D1 / SQLite)

DROP TABLE IF EXISTS stock_transactions;
DROP TABLE IF EXISTS issue_requests;
DROP TABLE IF EXISTS purchase_indents;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS users;

CREATE TABLE items (
  sap_code            TEXT PRIMARY KEY,
  uom                 TEXT,
  description         TEXT NOT NULL,
  net_price           REAL DEFAULT 0,
  specs_make          TEXT,
  rol                 INTEGER DEFAULT 0,   -- Reorder Level = low stock threshold
  roq                 INTEGER DEFAULT 0,   -- Reorder Quantity = suggested purchase qty
  current_stock       INTEGER DEFAULT 0,
  order_qty_pending   INTEGER DEFAULT 0,
  critical_category   TEXT,                -- '', 'CRITICAL', 'MOST CRITICAL'
  process_details     TEXT,
  vendor_code         TEXT,
  vendor_name         TEXT,
  vendor_email        TEXT,
  vendor_phone        TEXT,
  function_area       TEXT,                -- MECH / ELECT / UTILITY ...
  location            TEXT,                -- PROCESS / PKG etc.
  machine_equipment   TEXT,
  sub_equipment       TEXT,
  original_part_name  TEXT,
  fpr_name            TEXT,
  set_by              TEXT,
  remarks             TEXT,
  updated_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_items_desc ON items(description);
CREATE INDEX idx_items_stock ON items(current_stock);
CREATE INDEX idx_items_machine ON items(machine_equipment);
CREATE INDEX idx_items_location ON items(location);

CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  name           TEXT,
  role           TEXT NOT NULL CHECK(role IN ('admin','store_incharge','issuer')),
  active         INTEGER DEFAULT 1,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE issue_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sap_code       TEXT NOT NULL REFERENCES items(sap_code),
  qty_requested  INTEGER NOT NULL,
  requested_by   INTEGER NOT NULL REFERENCES users(id),
  purpose        TEXT,
  machine_ref    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','issued')),
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TEXT,
  issued_at      TEXT,
  remarks        TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_issue_status ON issue_requests(status);
CREATE INDEX idx_issue_sap ON issue_requests(sap_code);

CREATE TABLE stock_transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sap_code       TEXT NOT NULL REFERENCES items(sap_code),
  txn_type       TEXT NOT NULL CHECK(txn_type IN ('issue','receipt','adjustment')),
  qty_change     INTEGER NOT NULL,     -- negative for issue, positive for receipt
  balance_after  INTEGER NOT NULL,
  reference_id   INTEGER,              -- issue_requests.id or purchase_indents.id
  performed_by   INTEGER REFERENCES users(id),
  notes          TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_txn_sap ON stock_transactions(sap_code);
CREATE INDEX idx_txn_date ON stock_transactions(created_at);

CREATE TABLE purchase_indents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sap_code       TEXT NOT NULL REFERENCES items(sap_code),
  qty_suggested  INTEGER,
  status         TEXT DEFAULT 'pending' CHECK(status IN ('pending','ordered','received','cancelled')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT
);

CREATE INDEX idx_indent_status ON purchase_indents(status);
