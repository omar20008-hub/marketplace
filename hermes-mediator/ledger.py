"""Prepaid credit ledger for the Hermes mediator (SQLite, stdlib only).

Money is stored as integer micro-USD (1 USD = 1_000_000) so there is no float drift.
Every balance change happens inside BEGIN IMMEDIATE, so a reservation and its
settlement are atomic even with concurrent requests.
"""
import sqlite3
import threading

MICRO_PER_MTOK = 1000000

SCHEMA = """
CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    token_sha256 TEXT NOT NULL UNIQUE,
    balance_micro INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost_micro INTEGER NOT NULL,
    status INTEGER NOT NULL
);
"""


def cost_micro(prompt_tokens, completion_tokens, price):
    """Cost in micro-USD, rounded up so the mediator never under-charges."""
    raw = (prompt_tokens * price["in_micro_per_mtok"]
           + completion_tokens * price["out_micro_per_mtok"])
    return -(-raw // MICRO_PER_MTOK)


class Ledger:
    def __init__(self, path):
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._lock = threading.Lock()
        self._db.executescript(SCHEMA)

    def close(self):
        with self._lock:
            self._db.close()

    def _tx(self, fn):
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                result = fn(self._db)
                self._db.execute("COMMIT")
                return result
            except Exception:
                self._db.execute("ROLLBACK")
                raise

    def create_tenant(self, tenant_id, token_sha256, balance_micro, now):
        def op(db):
            db.execute(
                "INSERT INTO tenants (id, token_sha256, balance_micro, enabled, created_at)"
                " VALUES (?, ?, ?, 1, ?)",
                (tenant_id, token_sha256, balance_micro, now))
        self._tx(op)

    def add_credit(self, tenant_id, amount_micro):
        def op(db):
            cur = db.execute(
                "UPDATE tenants SET balance_micro = balance_micro + ? WHERE id = ?",
                (amount_micro, tenant_id))
            if cur.rowcount != 1:
                raise KeyError(tenant_id)
            row = db.execute("SELECT balance_micro FROM tenants WHERE id = ?",
                             (tenant_id,)).fetchone()
            return row[0]
        return self._tx(op)

    def set_enabled(self, tenant_id, enabled):
        def op(db):
            cur = db.execute("UPDATE tenants SET enabled = ? WHERE id = ?",
                             (1 if enabled else 0, tenant_id))
            if cur.rowcount != 1:
                raise KeyError(tenant_id)
        self._tx(op)

    def tenant_by_token_hash(self, token_sha256):
        row = self._db.execute(
            "SELECT id, enabled FROM tenants WHERE token_sha256 = ?",
            (token_sha256,)).fetchone()
        return (row[0], bool(row[1])) if row else None

    def balance(self, tenant_id):
        row = self._db.execute("SELECT balance_micro FROM tenants WHERE id = ?",
                               (tenant_id,)).fetchone()
        if row is None:
            raise KeyError(tenant_id)
        return row[0]

    def list_tenants(self):
        return self._db.execute(
            "SELECT id, balance_micro, enabled FROM tenants ORDER BY id").fetchall()

    def reserve(self, tenant_id, amount_micro):
        """Hold `amount_micro` from the balance. Returns False if credit is insufficient."""
        def op(db):
            cur = db.execute(
                "UPDATE tenants SET balance_micro = balance_micro - ?"
                " WHERE id = ? AND enabled = 1 AND balance_micro >= ?",
                (amount_micro, tenant_id, amount_micro))
            return cur.rowcount == 1
        return self._tx(op)

    def settle(self, tenant_id, reserved_micro, actual_micro, model,
               prompt_tokens, completion_tokens, status, now):
        """Replace a reservation with the actual cost and record the usage row."""
        def op(db):
            db.execute(
                "UPDATE tenants SET balance_micro = balance_micro + ? WHERE id = ?",
                (reserved_micro - actual_micro, tenant_id))
            db.execute(
                "INSERT INTO usage (tenant_id, ts, model, prompt_tokens,"
                " completion_tokens, cost_micro, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (tenant_id, now, model, prompt_tokens, completion_tokens,
                 actual_micro, status))
        self._tx(op)
