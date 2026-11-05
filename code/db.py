"""SQLite-Zugriff und Passwort-Hashing (nur Standardbibliothek)."""
import hashlib
import hmac
import os
import secrets
import sqlite3
from pathlib import Path

DB_PATH = Path(os.environ["APP_DATA"]) / "kalender.db"

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash    TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_events_range ON events(start_date, end_date);
CREATE TABLE IF NOT EXISTS marks (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    status     TEXT NOT NULL CHECK (status IN ('geplant', 'gebucht')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, event_id)
);
-- Aktivitätsprotokoll (Admin-Seite)
CREATE TABLE IF NOT EXISTS activity (
    id       INTEGER PRIMARY KEY,
    ts       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL DEFAULT '',
    action   TEXT NOT NULL,
    detail   TEXT NOT NULL DEFAULT '',
    ip       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity(action, id);
-- Änderungszähler: jede Änderung an Events/Markierungen erhöht ihn (für Live-Aktualisierung im Browser)
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (k, v) VALUES ('version', 0);
CREATE TRIGGER IF NOT EXISTS ver_events_insert AFTER INSERT ON events BEGIN UPDATE meta SET v = v + 1 WHERE k = 'version'; END;
CREATE TRIGGER IF NOT EXISTS ver_events_update AFTER UPDATE ON events BEGIN UPDATE meta SET v = v + 1 WHERE k = 'version'; END;
CREATE TRIGGER IF NOT EXISTS ver_events_delete AFTER DELETE ON events BEGIN UPDATE meta SET v = v + 1 WHERE k = 'version'; END;
CREATE TRIGGER IF NOT EXISTS ver_marks_insert AFTER INSERT ON marks BEGIN UPDATE meta SET v = v + 1 WHERE k = 'version'; END;
CREATE TRIGGER IF NOT EXISTS ver_marks_update AFTER UPDATE ON marks BEGIN UPDATE meta SET v = v + 1 WHERE k = 'version'; END;
CREATE TRIGGER IF NOT EXISTS ver_marks_delete AFTER DELETE ON marks BEGIN UPDATE meta SET v = v + 1 WHERE k = 'version'; END;
"""


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as con:
        con.executescript(SCHEMA)


# scrypt: n=2^14, r=8, p=1 -> ~16 MB RAM pro Hash
_N, _R, _P = 2**14, 8, 1


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, dk = stored.split("$")
        test = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt),
                              n=int(n), r=int(r), p=int(p), dklen=len(dk) // 2)
        return hmac.compare_digest(test.hex(), dk)
    except Exception:
        return False


# Dummy-Hash, damit Login für unbekannte User gleich lang dauert
DUMMY_HASH = hash_password(secrets.token_hex(8))
