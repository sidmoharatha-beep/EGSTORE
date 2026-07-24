// EGSTORE - Engineering Store Inventory Management
// Cloudflare Worker API backed by D1

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ---------- Password hashing (PBKDF2 via Web Crypto, no external deps) ----------
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex
    ? new Uint8Array(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const saltOut = [...salt].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${saltOut}:${hashHex}`;
}
async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const recomputed = await hashPassword(password, saltHex);
  return recomputed === stored;
}

// ---------- JWT (HMAC-SHA256, no external deps) ----------
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
async function signJWT(payload, secret, expSeconds = 60 * 60 * 12) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expSeconds };
  const enc = new TextEncoder();
  const h64 = b64url(enc.encode(JSON.stringify(header)));
  const p64 = b64url(enc.encode(JSON.stringify(body)));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${h64}.${p64}`));
  const s64 = b64url(new Uint8Array(sig));
  return `${h64}.${p64}.${s64}`;
}
async function verifyJWT(token, secret) {
  const [h64, p64, s64] = token.split(".");
  if (!h64 || !p64 || !s64) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify("HMAC", key, b64urlToBytes(s64), enc.encode(`${h64}.${p64}`));
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p64)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function requireAuth(req, env, roles = null) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { error: err("Not authenticated", 401) };
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return { error: err("Invalid or expired token", 401) };
  if (roles && !roles.includes(payload.role)) return { error: err("Forbidden", 403) };
  return { user: payload };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Everything that isn't an API call is a static asset (index.html, favicon, /vendor/*, etc.)
    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    let response;
    try {
      response = await route(request, env, url, path);
    } catch (e) {
      response = err("Server error: " + e.message, 500);
    }
    Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  },
};

async function route(request, env, url, path) {
  const method = request.method;

  // ---------------- AUTH ----------------
  if (path === "/api/auth/login" && method === "POST") {
    const { username, password } = await request.json();
    if (!username || !password) return err("username and password required");
    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND active = 1")
      .bind(username).first();
    if (!user) return err("Invalid credentials", 401);
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return err("Invalid credentials", 401);
    const token = await signJWT({ id: user.id, username: user.username, role: user.role, name: user.name }, env.JWT_SECRET);
    return json({ token, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
  }

  if (path === "/api/auth/me" && method === "GET") {
    const { user, error } = await requireAuth(request, env);
    if (error) return error;
    return json({ user });
  }

  // ---------------- USERS (creation + password reset: store_incharge only) ----------------
  if (path === "/api/users" && method === "POST") {
    const { user, error } = await requireAuth(request, env, ["store_incharge"]);
    if (error) return error;
    const { username, password, name, role } = await request.json();
    if (!["issuer", "store_incharge", "admin"].includes(role)) return err("invalid role");
    if (!username || !password) return err("username and password required");
    const hash = await hashPassword(password);
    try {
      await env.DB.prepare("INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)")
        .bind(username, hash, name || username, role).run();
    } catch (e) {
      return err("Username already exists");
    }
    return json({ ok: true });
  }

  if (path === "/api/users" && method === "GET") {
    const { error } = await requireAuth(request, env, ["store_incharge"]);
    if (error) return error;
    const { results } = await env.DB.prepare(
      "SELECT id, username, name, role, active, created_at FROM users ORDER BY id"
    ).all();
    return json({ users: results });
  }

  if (path.match(/^\/api\/users\/\d+\/reset-password$/) && method === "POST") {
    const { error } = await requireAuth(request, env, ["store_incharge"]);
    if (error) return error;
    const id = parseInt(path.split("/")[3]);
    const { new_password } = await request.json();
    if (!new_password || new_password.length < 6) return err("Password must be at least 6 characters");
    const hash = await hashPassword(new_password);
    const result = await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, id).run();
    if (!result.meta.changes) return err("User not found", 404);
    return json({ ok: true });
  }

  if (path.match(/^\/api\/users\/\d+\/active$/) && method === "PUT") {
    const { error } = await requireAuth(request, env, ["store_incharge"]);
    if (error) return error;
    const id = parseInt(path.split("/")[3]);
    const { active } = await request.json();
    await env.DB.prepare("UPDATE users SET active = ? WHERE id = ?").bind(active ? 1 : 0, id).run();
    return json({ ok: true });
  }

  // ---------------- DASHBOARD ----------------
  if (path === "/api/dashboard/summary" && method === "GET") {
    const { error } = await requireAuth(request, env);
    if (error) return error;
    const totals = await env.DB.prepare(
      "SELECT COUNT(*) as total_items, SUM(current_stock * net_price) as stock_value FROM items"
    ).first();
    const low = await env.DB.prepare(
      "SELECT COUNT(*) as low_stock_count FROM items WHERE current_stock <= rol"
    ).first();
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) as pending_approvals FROM issue_requests WHERE status = 'pending'"
    ).first();
    const indents = await env.DB.prepare(
      "SELECT COUNT(*) as open_indents FROM purchase_indents WHERE status = 'pending'"
    ).first();
    return json({
      total_items: totals.total_items,
      stock_value: Math.round(totals.stock_value || 0),
      low_stock_count: low.low_stock_count,
      pending_approvals: pending.pending_approvals,
      open_indents: indents.open_indents,
    });
  }

  if (path === "/api/dashboard/low-stock" && method === "GET") {
    const { error } = await requireAuth(request, env);
    if (error) return error;
    const { results } = await env.DB.prepare(
      `SELECT sap_code, description, uom, current_stock, rol, roq, critical_category, vendor_name
       FROM items WHERE current_stock <= rol ORDER BY (current_stock - rol) ASC LIMIT 500`
    ).all();
    return json({ items: results });
  }

  // ---------------- ITEMS ----------------
  if (path === "/api/items" && method === "GET") {
    const { error } = await requireAuth(request, env);
    if (error) return error;
    const q = url.searchParams.get("q") || "";
    const location = url.searchParams.get("location") || "";
    const machine = url.searchParams.get("machine") || "";
    const lowStock = url.searchParams.get("low_stock") === "true";
    const page = parseInt(url.searchParams.get("page") || "1");
    const pageSize = Math.min(parseInt(url.searchParams.get("page_size") || "50"), 200);
    const offset = (page - 1) * pageSize;

    let where = [];
    let binds = [];
    if (q) {
      where.push("(description LIKE ? OR sap_code LIKE ? OR original_part_name LIKE ? OR machine_equipment LIKE ?)");
      const like = `%${q}%`;
      binds.push(like, like, like, like);
    }
    if (location) { where.push("location = ?"); binds.push(location); }
    if (machine) { where.push("machine_equipment = ?"); binds.push(machine); }
    if (lowStock) { where.push("current_stock <= rol"); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const countRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM items ${whereSql}`).bind(...binds).first();
    const { results } = await env.DB.prepare(
      `SELECT * FROM items ${whereSql} ORDER BY description LIMIT ? OFFSET ?`
    ).bind(...binds, pageSize, offset).all();

    return json({ items: results, total: countRow.c, page, page_size: pageSize });
  }

  if (path.startsWith("/api/items/") && method === "GET") {
    const { error } = await requireAuth(request, env);
    if (error) return error;
    const sapCode = decodeURIComponent(path.split("/api/items/")[1]);
    const item = await env.DB.prepare("SELECT * FROM items WHERE sap_code = ?").bind(sapCode).first();
    if (!item) return err("Item not found", 404);
    const { results: history } = await env.DB.prepare(
      "SELECT * FROM stock_transactions WHERE sap_code = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(sapCode).all();
    return json({ item, history });
  }

  if (path === "/api/items" && method === "POST") {
    const { error } = await requireAuth(request, env, ["admin", "store_incharge"]);
    if (error) return error;
    const b = await request.json();
    if (!b.sap_code || !b.description) return err("sap_code and description required");
    try {
      await env.DB.prepare(
        `INSERT INTO items (sap_code, uom, description, net_price, specs_make, rol, roq, current_stock,
          critical_category, vendor_name, vendor_email, vendor_phone, function_area, location,
          machine_equipment, sub_equipment, original_part_name, fpr_name, remarks)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        b.sap_code, b.uom || null, b.description, b.net_price || 0, b.specs_make || null,
        b.rol || 0, b.roq || 0, b.current_stock || 0, b.critical_category || null,
        b.vendor_name || null, b.vendor_email || null, b.vendor_phone || null,
        b.function_area || null, b.location || null, b.machine_equipment || null,
        b.sub_equipment || null, b.original_part_name || null, b.fpr_name || null, b.remarks || null
      ).run();
    } catch (e) {
      return err("Item with this SAP code already exists");
    }
    return json({ ok: true });
  }

  if (path.startsWith("/api/items/") && method === "PUT") {
    const { error } = await requireAuth(request, env, ["admin", "store_incharge"]);
    if (error) return error;
    const sapCode = decodeURIComponent(path.split("/api/items/")[1]);
    const b = await request.json();
    const fields = ["uom","description","net_price","specs_make","rol","roq","critical_category",
      "vendor_name","vendor_email","vendor_phone","function_area","location","machine_equipment",
      "sub_equipment","original_part_name","fpr_name","remarks"];
    const sets = [];
    const binds = [];
    for (const f of fields) {
      if (b[f] !== undefined) { sets.push(`${f} = ?`); binds.push(b[f]); }
    }
    if (!sets.length) return err("No fields to update");
    sets.push("updated_at = datetime('now')");
    binds.push(sapCode);
    await env.DB.prepare(`UPDATE items SET ${sets.join(", ")} WHERE sap_code = ?`).bind(...binds).run();
    return json({ ok: true });
  }

  // Manual stock adjustment / receipt (store incharge receiving purchased goods)
  if (path === "/api/stock/receipt" && method === "POST") {
    const { user, error } = await requireAuth(request, env, ["admin", "store_incharge"]);
    if (error) return error;
    const { sap_code, qty, notes, indent_id } = await request.json();
    if (!sap_code || !qty || qty <= 0) return err("sap_code and positive qty required");
    const item = await env.DB.prepare("SELECT current_stock FROM items WHERE sap_code = ?").bind(sap_code).first();
    if (!item) return err("Item not found", 404);
    const newStock = item.current_stock + qty;
    await env.DB.batch([
      env.DB.prepare("UPDATE items SET current_stock = ?, updated_at = datetime('now') WHERE sap_code = ?")
        .bind(newStock, sap_code),
      env.DB.prepare(
        "INSERT INTO stock_transactions (sap_code, txn_type, qty_change, balance_after, reference_id, performed_by, notes) VALUES (?,?,?,?,?,?,?)"
      ).bind(sap_code, "receipt", qty, newStock, indent_id || null, user.id, notes || null),
    ]);
    if (indent_id) {
      await env.DB.prepare("UPDATE purchase_indents SET status = 'received', updated_at = datetime('now') WHERE id = ?")
        .bind(indent_id).run();
    }
    return json({ ok: true, new_stock: newStock });
  }

  // ---------------- ISSUE REQUESTS ----------------
  if (path === "/api/issues" && method === "POST") {
    const { user, error } = await requireAuth(request, env, ["issuer", "store_incharge", "admin"]);
    if (error) return error;
    const { sap_code, qty_requested, purpose, machine_ref } = await request.json();
    if (!sap_code || !qty_requested || qty_requested <= 0) return err("sap_code and positive qty_requested required");
    const item = await env.DB.prepare("SELECT sap_code FROM items WHERE sap_code = ?").bind(sap_code).first();
    if (!item) return err("Item not found", 404);
    const result = await env.DB.prepare(
      "INSERT INTO issue_requests (sap_code, qty_requested, requested_by, purpose, machine_ref) VALUES (?,?,?,?,?)"
    ).bind(sap_code, qty_requested, user.id, purpose || null, machine_ref || null).run();
    return json({ ok: true, id: result.meta.last_row_id });
  }

  if (path === "/api/issues" && method === "GET") {
    const { user, error } = await requireAuth(request, env);
    if (error) return error;
    const status = url.searchParams.get("status");
    const mine = url.searchParams.get("mine") === "true";
    const from = url.searchParams.get("from");   // YYYY-MM-DD
    const to = url.searchParams.get("to");       // YYYY-MM-DD
    const q = url.searchParams.get("q");         // item description / sap code / requester name
    let where = [];
    let binds = [];
    if (status) { where.push("ir.status = ?"); binds.push(status); }
    if (mine) { where.push("ir.requested_by = ?"); binds.push(user.id); }
    if (from) { where.push("date(ir.created_at) >= date(?)"); binds.push(from); }
    if (to) { where.push("date(ir.created_at) <= date(?)"); binds.push(to); }
    if (q) {
      where.push("(i.description LIKE ? OR i.sap_code LIKE ? OR ru.name LIKE ?)");
      const like = `%${q}%`; binds.push(like, like, like);
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const { results } = await env.DB.prepare(
      `SELECT ir.*, i.description, i.uom, i.current_stock, ru.name as requested_by_name, au.name as approved_by_name
       FROM issue_requests ir
       JOIN items i ON i.sap_code = ir.sap_code
       JOIN users ru ON ru.id = ir.requested_by
       LEFT JOIN users au ON au.id = ir.approved_by
       ${whereSql}
       ORDER BY ir.created_at DESC LIMIT 200`
    ).bind(...binds).all();
    return json({ issues: results });
  }

  // Full, unpaginated CSV export of issue records — who issued what, when, and why.
  if (path === "/api/issues/export" && method === "GET") {
    const { error } = await requireAuth(request, env, ["store_incharge", "admin"]);
    if (error) return error;
    const status = url.searchParams.get("status");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const q = url.searchParams.get("q");
    let where = [];
    let binds = [];
    if (status) { where.push("ir.status = ?"); binds.push(status); }
    if (from) { where.push("date(ir.created_at) >= date(?)"); binds.push(from); }
    if (to) { where.push("date(ir.created_at) <= date(?)"); binds.push(to); }
    if (q) {
      where.push("(i.description LIKE ? OR i.sap_code LIKE ? OR ru.name LIKE ?)");
      const like = `%${q}%`; binds.push(like, like, like);
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const { results } = await env.DB.prepare(
      `SELECT ir.id, ir.sap_code, i.description, ir.qty_requested, i.uom,
              ru.name as requested_by_name, ir.status,
              au.name as approved_by_name, ir.purpose, ir.machine_ref,
              ir.created_at, ir.approved_at, ir.issued_at, ir.remarks
       FROM issue_requests ir
       JOIN items i ON i.sap_code = ir.sap_code
       JOIN users ru ON ru.id = ir.requested_by
       LEFT JOIN users au ON au.id = ir.approved_by
       ${whereSql}
       ORDER BY ir.created_at DESC`
    ).bind(...binds).all();

    const cols = ["ID","SAP Code","Item Description","Qty","UoM","Requested By","Status",
      "Approved By","Purpose","Machine/Equipment","Requested At","Approved At","Issued At","Remarks"];
    const csvEsc = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.join(",")];
    for (const r of results) {
      lines.push([
        r.id, r.sap_code, r.description, r.qty_requested, r.uom, r.requested_by_name, r.status,
        r.approved_by_name || "", r.purpose || "", r.machine_ref || "",
        r.created_at, r.approved_at || "", r.issued_at || "", r.remarks || "",
      ].map(csvEsc).join(","));
    }
    const csv = lines.join("\n");
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="egstore_issue_log_${new Date().toISOString().slice(0,10)}.csv"`,
      },
    });
  }

  if (path.match(/^\/api\/issues\/\d+\/approve$/) && method === "POST") {
    const { user, error } = await requireAuth(request, env, ["store_incharge", "admin"]);
    if (error) return error;
    const id = parseInt(path.split("/")[3]);
    const reqRow = await env.DB.prepare("SELECT * FROM issue_requests WHERE id = ?").bind(id).first();
    if (!reqRow) return err("Request not found", 404);
    if (reqRow.status !== "pending") return err("Request already processed");
    const item = await env.DB.prepare("SELECT current_stock, rol, roq, description FROM items WHERE sap_code = ?")
      .bind(reqRow.sap_code).first();
    if (item.current_stock < reqRow.qty_requested) {
      return err(`Insufficient stock: only ${item.current_stock} available`);
    }
    const newStock = item.current_stock - reqRow.qty_requested;
    const batch = [
      env.DB.prepare(
        "UPDATE issue_requests SET status='issued', approved_by=?, approved_at=datetime('now'), issued_at=datetime('now') WHERE id=?"
      ).bind(user.id, id),
      env.DB.prepare("UPDATE items SET current_stock = ?, updated_at = datetime('now') WHERE sap_code = ?")
        .bind(newStock, reqRow.sap_code),
      env.DB.prepare(
        "INSERT INTO stock_transactions (sap_code, txn_type, qty_change, balance_after, reference_id, performed_by, notes) VALUES (?,?,?,?,?,?,?)"
      ).bind(reqRow.sap_code, "issue", -reqRow.qty_requested, newStock, id, user.id, reqRow.purpose || null),
    ];
    // Auto-create a purchase indent if stock has now dropped to/below ROL and no open indent exists
    if (newStock <= item.rol) {
      const existing = await env.DB.prepare(
        "SELECT id FROM purchase_indents WHERE sap_code = ? AND status = 'pending'"
      ).bind(reqRow.sap_code).first();
      if (!existing) {
        batch.push(
          env.DB.prepare(
            "INSERT INTO purchase_indents (sap_code, qty_suggested, created_by) VALUES (?,?,?)"
          ).bind(reqRow.sap_code, item.roq || 0, user.id)
        );
      }
    }
    await env.DB.batch(batch);
    return json({ ok: true, new_stock: newStock });
  }

  if (path.match(/^\/api\/issues\/\d+\/reject$/) && method === "POST") {
    const { user, error } = await requireAuth(request, env, ["store_incharge", "admin"]);
    if (error) return error;
    const id = parseInt(path.split("/")[3]);
    const { remarks } = await request.json().catch(() => ({}));
    const reqRow = await env.DB.prepare("SELECT status FROM issue_requests WHERE id = ?").bind(id).first();
    if (!reqRow) return err("Request not found", 404);
    if (reqRow.status !== "pending") return err("Request already processed");
    await env.DB.prepare(
      "UPDATE issue_requests SET status='rejected', approved_by=?, approved_at=datetime('now'), remarks=? WHERE id=?"
    ).bind(user.id, remarks || null, id).run();
    return json({ ok: true });
  }

  // ---------------- PURCHASE INDENTS ----------------
  if (path === "/api/purchase-indents" && method === "GET") {
    const { error } = await requireAuth(request, env, ["store_incharge", "admin"]);
    if (error) return error;
    const status = url.searchParams.get("status");
    let where = "";
    let binds = [];
    if (status) { where = "WHERE pi.status = ?"; binds.push(status); }
    const { results } = await env.DB.prepare(
      `SELECT pi.*, i.description, i.uom, i.current_stock, i.rol, i.vendor_name, i.vendor_email, i.net_price
       FROM purchase_indents pi JOIN items i ON i.sap_code = pi.sap_code
       ${where} ORDER BY pi.created_at DESC LIMIT 500`
    ).bind(...binds).all();
    return json({ indents: results });
  }

  // Generate indents for every below-threshold item that doesn't already have a pending indent
  if (path === "/api/purchase-indents/generate" && method === "POST") {
    const { user, error } = await requireAuth(request, env, ["store_incharge", "admin"]);
    if (error) return error;
    const { results: lowItems } = await env.DB.prepare(
      `SELECT sap_code, roq FROM items WHERE current_stock <= rol
       AND sap_code NOT IN (SELECT sap_code FROM purchase_indents WHERE status = 'pending')`
    ).all();
    if (!lowItems.length) return json({ ok: true, created: 0 });
    const batch = lowItems.map((it) =>
      env.DB.prepare("INSERT INTO purchase_indents (sap_code, qty_suggested, created_by) VALUES (?,?,?)")
        .bind(it.sap_code, it.roq || 0, user.id)
    );
    await env.DB.batch(batch);
    return json({ ok: true, created: lowItems.length });
  }

  if (path.match(/^\/api\/purchase-indents\/\d+$/) && method === "PUT") {
    const { error } = await requireAuth(request, env, ["store_incharge", "admin"]);
    if (error) return error;
    const id = parseInt(path.split("/")[3]);
    const { status } = await request.json();
    if (!["pending", "ordered", "received", "cancelled"].includes(status)) return err("invalid status");
    await env.DB.prepare("UPDATE purchase_indents SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(status, id).run();
    return json({ ok: true });
  }

  // ---------------- AI BULK RECEIPT (upload purchase excel -> extract -> preview -> apply) ----------------
  // Client parses the .xlsx into rows client-side (SheetJS) and posts the raw rows here.
  // Workers AI maps whatever columns the vendor/staff used onto {sap_code, description, qty}.
  // Nothing is written to the DB at this step — store incharge reviews/edits, then calls /apply.
  if (path === "/api/ai/bulk-receipt/parse" && method === "POST") {
    const { error } = await requireAuth(request, env, ["store_incharge"]);
    if (error) return error;
    const { rows } = await request.json();
    if (!Array.isArray(rows) || !rows.length) return err("rows required");
    if (!env.AI) return err("Workers AI binding not configured (see wrangler.toml [ai])", 500);

    const capped = rows.slice(0, 400); // keep prompt size sane; batch larger files client-side
    const tableText = capped.map((r) => r.join(" | ")).join("\n");

    const prompt = `You are extracting a goods-received list from a spreadsheet export pasted below (rows separated by newline, cells separated by " | "). The sheet may use inconsistent or messy headers.
For every data row (skip header/blank rows) output one object with:
- "sap_code": the item/SAP/material code if present, else null
- "description": item description/name if present, else null
- "qty": the received quantity as a number (required; skip the row if you cannot find a quantity)

Return ONLY a JSON array of these objects, no prose, no markdown fences.

SPREADSHEET:
${tableText}`;

    const aiResp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4000,
    });
    let text = (aiResp.response || "").trim();
    text = text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    let extracted;
    try {
      extracted = JSON.parse(text);
    } catch (e) {
      return err("AI could not parse this file into a table. Try a simpler export (SAP code / description / qty columns).", 422);
    }
    if (!Array.isArray(extracted)) return err("AI extraction did not return a list", 422);

    // Cross-check each extracted sap_code against the item master so the UI can flag new vs existing
    const codes = extracted.map((r) => r.sap_code).filter(Boolean);
    let existingMap = {};
    if (codes.length) {
      const placeholders = codes.map(() => "?").join(",");
      const { results } = await env.DB.prepare(
        `SELECT sap_code, description, current_stock, uom FROM items WHERE sap_code IN (${placeholders})`
      ).bind(...codes).all();
      existingMap = Object.fromEntries(results.map((r) => [r.sap_code, r]));
    }
    const preview = extracted
      .filter((r) => r.qty !== null && r.qty !== undefined && !isNaN(parseFloat(r.qty)))
      .map((r) => {
        const match = r.sap_code ? existingMap[r.sap_code] : null;
        return {
          sap_code: r.sap_code || "",
          description: r.description || (match ? match.description : ""),
          qty: Math.round(parseFloat(r.qty)),
          uom: match ? match.uom : "",
          current_stock: match ? match.current_stock : null,
          status: match ? "existing" : "new",
        };
      });

    return json({ preview, rows_seen: capped.length, rows_total: rows.length });
  }

  // Commit the (possibly store-incharge-edited) preview list: increments stock for existing
  // SAP codes, creates new item records for unmatched ones, and logs every change to the ledger.
  if (path === "/api/ai/bulk-receipt/apply" && method === "POST") {
    const { user, error } = await requireAuth(request, env, ["store_incharge"]);
    if (error) return error;
    const { items } = await request.json();
    if (!Array.isArray(items) || !items.length) return err("items required");

    const batch = [];
    const summary = { updated: 0, created: 0, skipped: 0 };

    for (const it of items) {
      const sapCode = (it.sap_code || "").trim();
      const qty = Math.round(Number(it.qty));
      if (!qty || qty <= 0) { summary.skipped++; continue; }

      if (sapCode) {
        const existing = await env.DB.prepare("SELECT current_stock FROM items WHERE sap_code = ?").bind(sapCode).first();
        if (existing) {
          const newStock = existing.current_stock + qty;
          batch.push(env.DB.prepare("UPDATE items SET current_stock = ?, updated_at = datetime('now') WHERE sap_code = ?").bind(newStock, sapCode));
          batch.push(env.DB.prepare(
            "INSERT INTO stock_transactions (sap_code, txn_type, qty_change, balance_after, performed_by, notes) VALUES (?,?,?,?,?,?)"
          ).bind(sapCode, "receipt", qty, newStock, user.id, "Bulk receipt (AI-assisted Excel upload)"));
          summary.updated++;
          continue;
        }
      }
      // No matching SAP code -> create a new item. Needs at least a description.
      if (!it.description) { summary.skipped++; continue; }
      const newCode = sapCode || `NEW${Date.now()}${Math.floor(Math.random() * 1000)}`;
      batch.push(env.DB.prepare(
        `INSERT OR IGNORE INTO items (sap_code, description, uom, current_stock, rol, roq)
         VALUES (?,?,?,?,?,?)`
      ).bind(newCode, it.description, it.uom || null, qty, it.rol || 0, it.roq || 0));
      batch.push(env.DB.prepare(
        "INSERT INTO stock_transactions (sap_code, txn_type, qty_change, balance_after, performed_by, notes) VALUES (?,?,?,?,?,?)"
      ).bind(newCode, "receipt", qty, qty, user.id, "New item created via bulk receipt (AI-assisted Excel upload)"));
      summary.created++;
    }

    if (batch.length) await env.DB.batch(batch);
    return json({ ok: true, summary });
  }

  // ---------------- FILTER META (for dropdowns) ----------------
  if (path === "/api/meta/filters" && method === "GET") {
    const { error } = await requireAuth(request, env);
    if (error) return error;
    const locations = await env.DB.prepare(
      "SELECT DISTINCT location FROM items WHERE location IS NOT NULL AND location != '' ORDER BY location"
    ).all();
    const machines = await env.DB.prepare(
      "SELECT DISTINCT machine_equipment FROM items WHERE machine_equipment IS NOT NULL AND machine_equipment != '' ORDER BY machine_equipment LIMIT 300"
    ).all();
    return json({
      locations: locations.results.map((r) => r.location),
      machines: machines.results.map((r) => r.machine_equipment),
    });
  }

  return err("Not found", 404);
}
