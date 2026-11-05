"""Jahreskalender – FastAPI-Anwendung (nativeai: uvicorn startet app:app in code/)."""
import datetime as dt
import os
import re
import secrets
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

import db

YEAR = int(os.environ.get("KAL_YEAR", "2027"))
SESSION_DAYS = 30
COOKIE = "kal_session"
STATIC = Path(__file__).resolve().parent / "static"
ACTIVITY_DAYS = 180                      # Protokolleinträge älter als das werden gelöscht

NAME_RE = re.compile(r"^[A-Za-z0-9._-]{2,64}$")
MIN_PW = 10


def _bootstrap_admin(con) -> None:
    """Erster Admin aus .env (ADMIN_USER, ADMIN_PASSWORD), nur solange es noch keine Benutzer gibt."""
    name = os.environ.get("ADMIN_USER", "").strip()
    pw = os.environ.get("ADMIN_PASSWORD", "")
    if not name or con.execute("SELECT 1 FROM users LIMIT 1").fetchone():
        return
    if not NAME_RE.match(name) or len(pw) < MIN_PW:
        print("ADMIN_USER/ADMIN_PASSWORD ungültig (Name 2–64 Zeichen A–Z a–z 0–9 . _ -, Passwort ≥ 10 Zeichen)")
        return
    con.execute("INSERT INTO users (username, pw_hash, is_admin) VALUES (?, ?, 1)", (name, db.hash_password(pw)))
    print(f"Erster Admin angelegt: {name}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    with db.connect() as con:
        con.execute("DELETE FROM activity WHERE ts < datetime('now', ?)", (f"-{ACTIVITY_DAYS} days",))
        _bootstrap_admin(con)
    yield


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---------- Auth ----------

class User(BaseModel):
    id: int
    username: str
    is_admin: bool


def _user_from_request(request: Request) -> Optional[User]:
    return _user_from_token(request.cookies.get(COOKIE))


def _user_from_token(token: Optional[str]) -> Optional[User]:
    if not token:
        return None
    with db.connect() as con:
        row = con.execute(
            "SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ? AND s.expires_at > datetime('now')", (token,)).fetchone()
    return User(id=row["id"], username=row["username"], is_admin=bool(row["is_admin"])) if row else None


def current_user(request: Request) -> User:
    u = _user_from_request(request)
    if not u:
        raise HTTPException(401, "Nicht angemeldet")
    return u


def admin_user(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Nur für Admins")
    return user


def _ip(request: Request) -> str:
    # uvicorn setzt client.host hinter dem Proxy aus X-Forwarded-For (--proxy-headers)
    return request.client.host if request.client else ""


def log(request: Request, user: Optional[User], action: str, detail: str = "", username: str = "") -> None:
    """Eigene Verbindung, damit der Eintrag auch bei anschließendem Fehler (z. B. 401) bestehen bleibt."""
    with db.connect() as con:
        con.execute("INSERT INTO activity (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)",
                    (user.id if user else None, user.username if user else username[:64], action,
                     detail[:300], _ip(request)))


def _require_json(request: Request) -> None:
    # CSRF-Schutz: Formular-POSTs fremder Seiten können kein application/json senden
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(415, "JSON erwartet")


_fails: dict[str, list[float]] = defaultdict(list)
MAX_FAILS, WINDOW = 10, 600


class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


@app.post("/api/login", dependencies=[Depends(_require_json)])
def login(data: LoginIn, request: Request, response: Response):
    ip = _ip(request)
    now = time.time()
    _fails[ip] = [t for t in _fails[ip] if now - t < WINDOW]
    if len(_fails[ip]) >= MAX_FAILS:
        log(request, None, "login_gesperrt", username=data.username.strip())
        raise HTTPException(429, "Zu viele Fehlversuche, bitte später erneut versuchen")

    with db.connect() as con:
        row = con.execute("SELECT id, pw_hash FROM users WHERE username = ?", (data.username.strip(),)).fetchone()
        ok = db.verify_password(data.password, row["pw_hash"] if row else db.DUMMY_HASH) and row is not None
        if not ok:
            _fails[ip].append(now)
            log(request, None, "login_fehlgeschlagen", username=data.username.strip())
            raise HTTPException(401, "Benutzername oder Passwort falsch")
        token = secrets.token_urlsafe(32)
        con.execute("DELETE FROM sessions WHERE expires_at <= datetime('now')")
        con.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
                    (token, row["id"], f"+{SESSION_DAYS} days"))
    _fails.pop(ip, None)
    u = _user_from_token(token)
    log(request, u, "login", request.headers.get("user-agent", "")[:200])
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                        secure=request.url.scheme == "https", samesite="lax", path="/")
    return {"ok": True}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        u = _user_from_token(token)
        if u:
            log(request, u, "logout")
        with db.connect() as con:
            con.execute("DELETE FROM sessions WHERE token = ?", (token,))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/me")
def me(user: User = Depends(current_user)):
    return {**user.model_dump(), "year": YEAR}


class OwnPasswordIn(BaseModel):
    old_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


@app.post("/api/password", dependencies=[Depends(_require_json)])
def change_password(data: OwnPasswordIn, request: Request, user: User = Depends(current_user)):
    """Eigenes Passwort ändern. Andere Sitzungen werden beendet, die aktuelle bleibt."""
    if len(data.new_password) < MIN_PW:
        raise HTTPException(400, f"Neues Passwort muss mindestens {MIN_PW} Zeichen haben")
    with db.connect() as con:
        row = con.execute("SELECT pw_hash FROM users WHERE id = ?", (user.id,)).fetchone()
        if not db.verify_password(data.old_password, row["pw_hash"]):
            log(request, user, "passwort_fehlgeschlagen")
            raise HTTPException(400, "Bisheriges Passwort ist falsch")
        con.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (db.hash_password(data.new_password), user.id))
        con.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (user.id, request.cookies.get(COOKIE)))
    log(request, user, "passwort_geaendert")
    return {"ok": True}


@app.get("/api/users")
def users(_: User = Depends(current_user)):
    """Nur Namen – für den Teilnehmer-Filter."""
    with db.connect() as con:
        return [r["username"] for r in con.execute("SELECT username FROM users ORDER BY username COLLATE NOCASE")]


# ---------- Events ----------

class EventIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    start_date: dt.date
    end_date: dt.date
    note: str = Field(default="", max_length=2000)

    @field_validator("title", "note")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("end_date")
    @classmethod
    def _order(cls, v: dt.date, info):
        start = info.data.get("start_date")
        if start and v < start:
            raise ValueError("Ende liegt vor dem Beginn")
        return v


class MarkIn(BaseModel):
    status: Optional[Literal["geplant", "gebucht"]] = None


def _load_events(con, user: User, event_id: Optional[int] = None) -> list[dict]:
    first, last = f"{YEAR}-01-01", f"{YEAR}-12-31"
    where = "e.id = ?" if event_id else "e.end_date >= ? AND e.start_date <= ?"
    args = (event_id,) if event_id else (first, last)
    rows = con.execute(f"SELECT e.id, e.title, e.start_date, e.end_date, e.note, e.created_by, "
                       f"u.username AS creator FROM events e LEFT JOIN users u ON u.id = e.created_by "
                       f"WHERE {where} ORDER BY e.start_date, e.end_date DESC, e.title", args).fetchall()
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    marks = con.execute(
        f"SELECT m.event_id, m.status, u.id AS uid, u.username FROM marks m JOIN users u ON u.id = m.user_id "
        f"WHERE m.event_id IN ({','.join('?' * len(ids))}) ORDER BY u.username", ids).fetchall()
    by_event: dict[int, list] = defaultdict(list)
    for m in marks:
        by_event[m["event_id"]].append(m)
    out = []
    for r in rows:
        ms = by_event[r["id"]]
        mine = next((m["status"] for m in ms if m["uid"] == user.id), None)
        ev = dict(r)
        ev["can_edit"] = user.is_admin or ev.pop("created_by") == user.id
        out.append({**ev, "my_status": mine,
                    "participants": [{"username": m["username"], "status": m["status"]} for m in ms]})
    return out


def _check_edit(con, event_id: int, user: User) -> None:
    row = con.execute("SELECT created_by FROM events WHERE id = ?", (event_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Event nicht gefunden")
    if not user.is_admin and row["created_by"] != user.id:
        raise HTTPException(403, "Nur der Ersteller oder ein Admin darf das Event ändern")


@app.get("/api/version")
def version(user: User = Depends(current_user)):
    with db.connect() as con:
        return {"v": con.execute("SELECT v FROM meta WHERE k = 'version'").fetchone()[0]}


@app.get("/api/events")
def list_events(user: User = Depends(current_user)):
    with db.connect() as con:
        return _load_events(con, user)


@app.post("/api/events", dependencies=[Depends(_require_json)])
def create_event(data: EventIn, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        cur = con.execute("INSERT INTO events (title, start_date, end_date, note, created_by) VALUES (?, ?, ?, ?, ?)",
                          (data.title, data.start_date.isoformat(), data.end_date.isoformat(), data.note, user.id))
        ev = _load_events(con, user, cur.lastrowid)[0]
    log(request, user, "event_angelegt", f"{data.title} ({data.start_date} – {data.end_date})")
    return ev


@app.put("/api/events/{event_id}", dependencies=[Depends(_require_json)])
def update_event(event_id: int, data: EventIn, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        _check_edit(con, event_id, user)
        old = con.execute("SELECT title, start_date, end_date FROM events WHERE id = ?", (event_id,)).fetchone()
        con.execute("UPDATE events SET title = ?, start_date = ?, end_date = ?, note = ?, "
                    "updated_at = datetime('now') WHERE id = ?",
                    (data.title, data.start_date.isoformat(), data.end_date.isoformat(), data.note, event_id))
        ev = _load_events(con, user, event_id)[0]
    log(request, user, "event_geaendert",
        f"{old['title']} ({old['start_date']} – {old['end_date']}) → {data.title} ({data.start_date} – {data.end_date})")
    return ev


@app.delete("/api/events/{event_id}")
def delete_event(event_id: int, request: Request, user: User = Depends(current_user)):
    _require_json(request)
    with db.connect() as con:
        _check_edit(con, event_id, user)
        old = con.execute("SELECT title, start_date, end_date FROM events WHERE id = ?", (event_id,)).fetchone()
        con.execute("DELETE FROM events WHERE id = ?", (event_id,))
    log(request, user, "event_geloescht", f"{old['title']} ({old['start_date']} – {old['end_date']})")
    return {"ok": True}


@app.put("/api/events/{event_id}/mark", dependencies=[Depends(_require_json)])
def mark_event(event_id: int, data: MarkIn, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        row = con.execute("SELECT title FROM events WHERE id = ?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Event nicht gefunden")
        if data.status is None:
            con.execute("DELETE FROM marks WHERE user_id = ? AND event_id = ?", (user.id, event_id))
        else:
            con.execute("INSERT INTO marks (user_id, event_id, status) VALUES (?, ?, ?) "
                        "ON CONFLICT(user_id, event_id) DO UPDATE SET status = excluded.status, "
                        "updated_at = datetime('now')", (user.id, event_id, data.status))
        ev = _load_events(con, user, event_id)[0]
    log(request, user, "status", f"{row['title']} → {data.status or 'offen'}")
    return ev


# ---------- Aktivität ----------

CLIENT_ACTIONS = {"ansicht_jahr", "ansicht_woche", "ansicht_monat", "event_angesehen"}


class LogIn(BaseModel):
    action: str = Field(max_length=40)
    detail: str = Field(default="", max_length=200)


@app.post("/api/log", dependencies=[Depends(_require_json)])
def client_log(data: LogIn, request: Request, user: User = Depends(current_user)):
    if data.action not in CLIENT_ACTIONS:
        raise HTTPException(400, "Unbekannte Aktion")
    log(request, user, data.action, data.detail)
    return {"ok": True}


@app.get("/api/admin/activity")
def admin_activity(user_id: Optional[int] = None, action: Optional[str] = None,
                   before: Optional[int] = None, limit: int = 200, _: User = Depends(admin_user)):
    where, args = [], []
    if user_id:
        where.append("user_id = ?"); args.append(user_id)
    if action:
        where.append("action = ?"); args.append(action)
    if before:
        where.append("id < ?"); args.append(before)
    sql = "SELECT id, ts, user_id, username, action, detail, ip FROM activity"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(max(1, min(limit, 1000)))
    with db.connect() as con:
        return [dict(r) for r in con.execute(sql, args)]


@app.get("/api/admin/users")
def admin_users(_: User = Depends(admin_user)):
    with db.connect() as con:
        rows = con.execute("""
            SELECT u.id, u.username, u.is_admin, u.created_at,
                   (SELECT MAX(ts) FROM activity a WHERE a.user_id = u.id AND a.action = 'login') AS last_login,
                   (SELECT MAX(ts) FROM activity a WHERE a.user_id = u.id) AS last_seen,
                   (SELECT COUNT(*) FROM activity a WHERE a.user_id = u.id AND a.action = 'login') AS logins,
                   (SELECT COUNT(*) FROM activity a WHERE a.user_id = u.id) AS actions,
                   (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions,
                   (SELECT COUNT(*) FROM marks m WHERE m.user_id = u.id AND m.status = 'geplant') AS geplant,
                   (SELECT COUNT(*) FROM marks m WHERE m.user_id = u.id AND m.status = 'gebucht') AS gebucht,
                   (SELECT COUNT(*) FROM events e WHERE e.created_by = u.id) AS events
            FROM users u ORDER BY u.username""").fetchall()
        return [dict(r) for r in rows]


# ---------- Benutzerverwaltung (Admin) ----------

class NewUserIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)
    is_admin: bool = False


class PasswordIn(BaseModel):
    password: str = Field(max_length=256)


class AdminFlagIn(BaseModel):
    is_admin: bool


def _check_pw(pw: str) -> None:
    if len(pw) < MIN_PW:
        raise HTTPException(400, f"Passwort muss mindestens {MIN_PW} Zeichen haben")


def _get_user(con, user_id: int):
    row = con.execute("SELECT id, username, is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Benutzer nicht gefunden")
    return row


@app.post("/api/admin/users", dependencies=[Depends(_require_json)])
def admin_add_user(data: NewUserIn, request: Request, admin: User = Depends(admin_user)):
    name = data.username.strip()
    if not NAME_RE.match(name):
        raise HTTPException(400, "Name: 2–64 Zeichen, erlaubt sind A–Z, a–z, 0–9, Punkt, Unterstrich, Bindestrich")
    _check_pw(data.password)
    with db.connect() as con:
        if con.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
            raise HTTPException(409, f"Benutzer „{name}“ existiert bereits")
        con.execute("INSERT INTO users (username, pw_hash, is_admin) VALUES (?, ?, ?)",
                    (name, db.hash_password(data.password), int(data.is_admin)))
    log(request, admin, "benutzer_angelegt", f"{name}{' (Admin)' if data.is_admin else ''}")
    return {"ok": True}


@app.put("/api/admin/users/{user_id}/password", dependencies=[Depends(_require_json)])
def admin_set_password(user_id: int, data: PasswordIn, request: Request, admin: User = Depends(admin_user)):
    _check_pw(data.password)
    with db.connect() as con:
        u = _get_user(con, user_id)
        con.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (db.hash_password(data.password), user_id))
        con.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    log(request, admin, "benutzer_passwort", u["username"])
    return {"ok": True}


@app.put("/api/admin/users/{user_id}/admin", dependencies=[Depends(_require_json)])
def admin_set_flag(user_id: int, data: AdminFlagIn, request: Request, admin: User = Depends(admin_user)):
    if user_id == admin.id and not data.is_admin:
        raise HTTPException(400, "Das eigene Admin-Recht kann man nicht entziehen")
    with db.connect() as con:
        u = _get_user(con, user_id)
        con.execute("UPDATE users SET is_admin = ? WHERE id = ?", (int(data.is_admin), user_id))
    log(request, admin, "benutzer_rolle", f"{u['username']} → {'Admin' if data.is_admin else 'Benutzer'}")
    return {"ok": True}


@app.post("/api/admin/users/{user_id}/logout", dependencies=[Depends(_require_json)])
def admin_logout_user(user_id: int, request: Request, admin: User = Depends(admin_user)):
    with db.connect() as con:
        u = _get_user(con, user_id)
        n = con.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,)).rowcount
    log(request, admin, "benutzer_abgemeldet", f"{u['username']} ({n} Sitzung(en))")
    return {"ok": True, "sessions": n}


@app.delete("/api/admin/users/{user_id}", dependencies=[Depends(_require_json)])
def admin_delete_user(user_id: int, request: Request, admin: User = Depends(admin_user)):
    if user_id == admin.id:
        raise HTTPException(400, "Den eigenen Benutzer kann man nicht löschen")
    with db.connect() as con:
        u = _get_user(con, user_id)
        con.execute("DELETE FROM users WHERE id = ?", (user_id,))
    log(request, admin, "benutzer_geloescht", u["username"])
    return {"ok": True}


# ---------- Seiten ----------

# Smartphones (nicht Tablets): "Mobi" steht in fast allen Handy-Browsern, iPhone/iPod zur Sicherheit extra
_MOBILE_RE = re.compile(r"Mobi|iPhone|iPod|Windows Phone", re.I)
VIEW_COOKIE = "kal_ansicht"


def _wants_mobile(request: Request) -> bool:
    choice = request.cookies.get(VIEW_COOKIE)
    if choice in ("mobil", "desktop"):
        return choice == "mobil"
    return bool(_MOBILE_RE.search(request.headers.get("user-agent", "")))


@app.get("/")
def index(request: Request, ansicht: Optional[str] = None):
    if ansicht in ("mobil", "desktop", "auto"):        # manuelle Umschaltung, wird per Cookie gemerkt
        resp = RedirectResponse("/", status_code=303)
        if ansicht == "auto":
            resp.delete_cookie(VIEW_COOKIE, path="/")
        else:
            resp.set_cookie(VIEW_COOKIE, ansicht, max_age=365 * 86400, samesite="lax", path="/")
        return resp
    if not _user_from_request(request):
        return RedirectResponse("/login", status_code=303)
    page = "mobile.html" if _wants_mobile(request) else "index.html"
    return FileResponse(STATIC / page, headers={"Cache-Control": "no-store", "Vary": "User-Agent, Cookie"})


@app.get("/admin")
def admin_page(request: Request):
    u = _user_from_request(request)
    if not u:
        return RedirectResponse("/login", status_code=303)
    if not u.is_admin:
        return RedirectResponse("/", status_code=303)
    return FileResponse(STATIC / "admin.html", headers={"Cache-Control": "no-store"})


@app.get("/login")
def login_page(request: Request):
    if _user_from_request(request):
        return RedirectResponse("/", status_code=303)
    return FileResponse(STATIC / "login.html", headers={"Cache-Control": "no-store"})


_SEC_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"same-origin"),
    (b"x-frame-options", b"DENY"),
    (b"content-security-policy", b"default-src 'self'; img-src 'self' data:; frame-ancestors 'none'"),
]


class SecurityHeaders:
    """Reine ASGI-Middleware (statt BaseHTTPMiddleware): reicht Antworten unverändert durch und
    hängt nur Header an. Vermeidet 'Response content shorter than Content-Length' bei Dateien."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", [])) + _SEC_HEADERS
            await send(message)

        await self.app(scope, receive, send_with_headers)


app.add_middleware(SecurityHeaders)
