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
-- Gruppen: Beitritt nur per Einladungscode, Farbe automatisch aus Palette
CREATE TABLE IF NOT EXISTS groups_ (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    color       INTEGER NOT NULL DEFAULT 0,
    invite_code TEXT NOT NULL UNIQUE,
    owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS group_members (
    group_id  INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON group_members(user_id);
-- visibility: public (alle, nur Admin legt an), group (Mitglieder), private (nur Ersteller)
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'group', 'private')),
    group_id   INTEGER REFERENCES groups_(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (end_date >= start_date),
    CHECK ((visibility = 'group') = (group_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_events_range ON events(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_events_group ON events(group_id);
CREATE INDEX IF NOT EXISTS idx_events_owner ON events(created_by, visibility);
CREATE TABLE IF NOT EXISTS marks (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    status     TEXT NOT NULL CHECK (status IN ('geplant', 'gebucht')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, event_id)
);
-- Aktivitätsprotokoll (Admin-Seite) – ohne Titel privater oder Gruppen-Events
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
-- Stammdaten (vom Admin gepflegt): Veranstalter und Rennstrecken
CREATE TABLE IF NOT EXISTS organizers (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    website TEXT NOT NULL DEFAULT '',
    email   TEXT NOT NULL DEFAULT '',
    phone   TEXT NOT NULL DEFAULT '',
    note    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tracks (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    location TEXT NOT NULL DEFAULT '',
    length   TEXT NOT NULL DEFAULT '',
    website  TEXT NOT NULL DEFAULT '',
    note     TEXT NOT NULL DEFAULT ''
);
-- Gruppen-Teilnahme: der Gründer einer Gruppe legt fest, ob seine Gruppe an einem Event teilnimmt
CREATE TABLE IF NOT EXISTS group_events (
    group_id INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_group_events_event ON group_events(event_id);
-- Selbst-Registrierung: wartet auf Bestätigung per Mail-Link (nur Hash des Tokens gespeichert)
CREATE TABLE IF NOT EXISTS registrations (
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL COLLATE NOCASE,
    email      TEXT NOT NULL,
    pw_hash    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);
-- Passwort vergessen: Einmal-Links (nur Hash des Tokens gespeichert)
CREATE TABLE IF NOT EXISTS pw_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
-- Änderungszähler für die Live-Aktualisierung im Browser
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (k, v) VALUES ('version', 0);
"""

_TRIGGERS = ["events", "marks", "groups_", "group_members", "organizers", "tracks", "group_events"]

# Spalten, die später zu events dazukamen (additiv, idempotent)
_EVENT_COLUMNS = {
    "organizer_id": "INTEGER REFERENCES organizers(id) ON DELETE SET NULL",
    "track_id": "INTEGER REFERENCES tracks(id) ON DELETE SET NULL",
    "ics_uid": "TEXT",                     # UID aus importierten ICS-Dateien (für erneuten Import)
}


# Spalten, die später zu users dazukamen
_USER_COLUMNS = {
    "email": "TEXT",                       # klein geschrieben; optional (ältere Benutzer haben keine)
    "feed_token": "TEXT",                  # geheimer Schlüssel für das Kalender-Abo (ICS-Feed)
}


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
        have = {r["name"] for r in con.execute("PRAGMA table_info(events)")}
        for col, decl in _EVENT_COLUMNS.items():
            if col not in have:
                con.execute(f"ALTER TABLE events ADD COLUMN {col} {decl}")
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_ics_uid ON events(ics_uid)")
        have = {r["name"] for r in con.execute("PRAGMA table_info(users)")}
        for col, decl in _USER_COLUMNS.items():
            if col not in have:
                con.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL")
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_feed ON users(feed_token) WHERE feed_token IS NOT NULL")
        have = {r["name"] for r in con.execute("PRAGMA table_info(group_members)")}
        if "is_owner" not in have:              # mehrere Owner pro Gruppe; bisheriger Gründer wird Owner
            con.execute("ALTER TABLE group_members ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0")
            con.execute("UPDATE group_members SET is_owner = 1 WHERE EXISTS (SELECT 1 FROM groups_ g "
                        "WHERE g.id = group_members.group_id AND g.owner_id = group_members.user_id)")
            # Gruppen ohne Gründer (Konto gelöscht): ältestes Mitglied wird Owner
            con.execute("UPDATE group_members SET is_owner = 1 WHERE rowid IN (SELECT (SELECT gm.rowid FROM "
                        "group_members gm WHERE gm.group_id = g.id ORDER BY gm.joined_at, gm.user_id LIMIT 1) "
                        "FROM groups_ g WHERE NOT EXISTS (SELECT 1 FROM group_members x "
                        "WHERE x.group_id = g.id AND x.is_owner = 1))")
        con.execute("DELETE FROM registrations WHERE expires_at <= datetime('now')")
        con.execute("DELETE FROM pw_resets WHERE expires_at <= datetime('now')")
        for t in _TRIGGERS:
            for op in ("INSERT", "UPDATE", "DELETE"):
                con.execute(f"CREATE TRIGGER IF NOT EXISTS ver_{t}_{op.lower()} AFTER {op} ON {t} "
                            f"BEGIN UPDATE meta SET v = v + 1 WHERE k = 'version'; END")


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
