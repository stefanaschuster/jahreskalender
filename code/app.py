"""racingkalender.de – Jahreskalender mit öffentlichen, Gruppen- und privaten Events.
nativeai: uvicorn startet app:app in code/."""
import datetime as dt
import hashlib
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
import ics
import mail
from texts import T, lang_of

YEAR = int(os.environ.get("KAL_YEAR", "2027"))
SESSION_DAYS = 30
COOKIE = "kal_session"
STATIC = Path(__file__).resolve().parent / "static"
VERSION = (Path(__file__).resolve().parent / "VERSION").read_text().strip()
ACTIVITY_DAYS = 180                      # Protokolleinträge älter als das werden gelöscht
GROUP_COLORS = 10                        # Anzahl Gruppenfarben in der Palette (style.css)
MAX_GROUPS_PER_USER = 30

NAME_RE = re.compile(r"^[A-Za-z0-9._-]{2,64}$")
CODE_RE = re.compile(r"^[A-Za-z0-9_-]{8,32}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
MIN_PW = 8
REGISTER_HOURS = 24                      # Gültigkeit des Bestätigungslinks
RESET_HOURS = 1                          # Gültigkeit des Passwort-Links


def _bootstrap_admin(con) -> None:
    """Admin aus .env (ADMIN_USER, ADMIN_PASSWORD) anlegen, falls es diesen Benutzer noch nicht gibt.
    Ein bestehender Benutzer wird nicht verändert."""
    name = os.environ.get("ADMIN_USER", "").strip()
    pw = os.environ.get("ADMIN_PASSWORD", "")
    if not name or con.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
        return
    if not NAME_RE.match(name) or len(pw) < MIN_PW:
        print(f"ADMIN_USER/ADMIN_PASSWORD ungültig (Name 2–64 Zeichen A–Z a–z 0–9 . _ -, Passwort ≥ {MIN_PW} Zeichen)")
        return
    con.execute("INSERT INTO users (username, pw_hash, is_admin) VALUES (?, ?, 1)", (name, db.hash_password(pw)))
    print(f"Erster Admin angelegt: {name}")


def _init_eventmanager(con) -> None:
    """Rolle Eventmanager: Benutzer darf öffentliche Events bestimmter Veranstalter anlegen, ändern, löschen
    und die Angaben dieser Veranstalter pflegen."""
    con.execute("CREATE TABLE IF NOT EXISTS organizer_managers ("
                "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                "organizer_id INTEGER NOT NULL REFERENCES organizers(id) ON DELETE CASCADE, "
                "PRIMARY KEY (user_id, organizer_id))")
    con.execute("CREATE INDEX IF NOT EXISTS idx_managers_org ON organizer_managers(organizer_id)")
    for op in ("INSERT", "UPDATE", "DELETE"):       # Rechte ändern sich → Browser laden neu
        con.execute(f"CREATE TRIGGER IF NOT EXISTS ver_organizer_managers_{op.lower()} AFTER {op} ON organizer_managers "
                    f"BEGIN UPDATE meta SET v = v + 1 WHERE k = 'version'; END")


def err(status: int, key: str, **values) -> HTTPException:
    """Fehlermeldung als Textschlüssel (static/texts.json); die Seite übersetzt sie in die gewählte Sprache."""
    return HTTPException(status, {"key": key, "values": values} if values else key)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    with db.connect() as con:
        _init_eventmanager(con)
        con.execute("DELETE FROM activity WHERE ts < datetime('now', ?)", (f"-{ACTIVITY_DAYS} days",))
        _bootstrap_admin(con)
    yield


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/version")
def app_version():                       # Fußzeile
    return {"version": VERSION, "site": os.environ.get("INSTANTRUN_SITE", "")}


# ---------- Auth ----------

class User(BaseModel):
    id: int
    username: str
    is_admin: bool
    managed: list[int] = []              # Veranstalter, für die der Benutzer Eventmanager ist


def _user_from_request(request: Request) -> Optional[User]:
    return _user_from_token(request.cookies.get(COOKIE))


def _managed(con, user_id: int) -> list[int]:
    return [r["organizer_id"] for r in con.execute(
        "SELECT organizer_id FROM organizer_managers WHERE user_id = ?", (user_id,))]


def _user_from_token(token: Optional[str]) -> Optional[User]:
    if not token:
        return None
    with db.connect() as con:
        row = con.execute(
            "SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ? AND s.expires_at > datetime('now')", (token,)).fetchone()
        if not row:
            return None
        return User(id=row["id"], username=row["username"], is_admin=bool(row["is_admin"]),
                    managed=_managed(con, row["id"]))


def current_user(request: Request) -> User:
    u = _user_from_request(request)
    if not u:
        raise err(401, "err.not_logged_in")
    return u


# Nicht angemeldete Besucher sehen den Kalender (nur öffentliche Events, ohne Teilnehmer), dürfen aber nichts ändern
GUEST = User(id=0, username="", is_admin=False)


def viewer(request: Request) -> User:
    return _user_from_request(request) or GUEST


def admin_user(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise err(403, "err.admin_only")
    return user


def _ip(request: Request) -> str:
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
        raise err(415, "err.json_expected")


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
        raise err(429, "err.too_many_fails")

    name = data.username.strip()
    with db.connect() as con:
        row = con.execute("SELECT id, pw_hash FROM users WHERE username = ? OR (? LIKE '%@%' AND email = ?)",
                          (name, name, name.lower())).fetchone()
        ok = db.verify_password(data.password, row["pw_hash"] if row else db.DUMMY_HASH) and row is not None
        if not ok:
            _fails[ip].append(now)
            log(request, None, "login_fehlgeschlagen", username=name)
            raise err(401, "err.bad_login")
        token = _start_session(con, row["id"], request, response)
    _fails.pop(ip, None)
    log(request, _user_from_token(token), "login", request.headers.get("user-agent", "")[:200])
    return {"ok": True}


def _start_session(con, user_id: int, request: Request, response: Response) -> str:
    token = secrets.token_urlsafe(32)
    con.execute("DELETE FROM sessions WHERE expires_at <= datetime('now')")
    con.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
                (token, user_id, f"+{SESSION_DAYS} days"))
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                        secure=request.url.scheme == "https", samesite="lax", path="/")
    return token


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
def me(user: User = Depends(viewer)):
    out = user.model_dump()
    out["managed_organizers"] = out.pop("managed")
    return {**out, "guest": user.id == 0, "year": YEAR, "group_colors": GROUP_COLORS}


class OwnPasswordIn(BaseModel):
    old_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


@app.post("/api/password", dependencies=[Depends(_require_json)])
def change_password(data: OwnPasswordIn, request: Request, user: User = Depends(current_user)):
    """Eigenes Passwort ändern. Andere Sitzungen werden beendet, die aktuelle bleibt."""
    if len(data.new_password) < MIN_PW:
        raise err(400, "err.new_pw_short", n=MIN_PW)
    with db.connect() as con:
        row = con.execute("SELECT pw_hash FROM users WHERE id = ?", (user.id,)).fetchone()
        if not db.verify_password(data.old_password, row["pw_hash"]):
            log(request, user, "passwort_fehlgeschlagen")
            raise err(400, "err.old_pw_wrong")
        con.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (db.hash_password(data.new_password), user.id))
        con.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (user.id, request.cookies.get(COOKIE)))
    log(request, user, "passwort_geaendert")
    return {"ok": True}


# ---------- Selbst-Registrierung und Passwort vergessen (Mail über Brevo) ----------

_mail_hits: dict[str, list[float]] = defaultdict(list)
MAIL_PER_HOUR = 5                        # Mail-auslösende Anfragen pro IP und Stunde


def _mail_limit(request: Request) -> None:
    ip, now = _ip(request), time.time()
    _mail_hits[ip] = [t for t in _mail_hits[ip] if now - t < 3600]
    if len(_mail_hits[ip]) >= MAIL_PER_HOUR:
        raise err(429, "err.too_many_requests")
    _mail_hits[ip].append(now)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _base_url(request: Request) -> str:
    url = os.environ.get("PUBLIC_URL", "").strip().rstrip("/")
    if url:
        return url
    host = request.headers.get("host", "")
    scheme = "http" if host.startswith(("localhost", "127.0.0.1")) else "https"
    return f"{scheme}://{host}"


def _clean_email(v: str) -> str:
    v = v.strip().lower()
    if len(v) > 254 or not EMAIL_RE.match(v):
        raise err(400, "err.email_invalid")
    return v


def _send_or_502(request: Request, to: str, kind: str, link: str, **values) -> None:
    """Mail an den Nutzer in dessen Sprache; Texte mail.<kind>.subject/.text/.button aus texts.json."""
    lang = lang_of(request)
    try:
        mail.send(to, T(lang, f"mail.{kind}.subject"), T(lang, f"mail.{kind}.text", **values), link,
                  T(lang, f"mail.{kind}.button"), lang)
    except mail.MailError as ex:
        log(request, None, "mail_fehler", str(ex)[:300])
        raise err(502, "err.mail_failed")


def _admin_addresses(con) -> list[str]:
    env = [a.strip().lower() for a in os.environ.get("ADMIN_EMAIL", "").split(",") if a.strip()]
    if env:
        return env
    return [r["email"] for r in con.execute("SELECT email FROM users WHERE is_admin = 1 AND email IS NOT NULL")]


@app.get("/api/config")
def public_config():
    ok = mail.configured()
    return {"registration": ok and os.environ.get("REGISTRATION_OPEN", "1") != "0", "reset": ok,
            "videos": _video_info()}


class RegisterIn(BaseModel):
    username: str = Field(max_length=64)
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)


@app.post("/api/register", dependencies=[Depends(_require_json)])
def register(data: RegisterIn, request: Request):
    if not public_config()["registration"]:
        raise err(503, "err.registration_closed")
    name = data.username.strip()
    if not NAME_RE.match(name):
        raise err(400, "err.username_rule")
    if len(data.password) < MIN_PW:
        raise err(400, "err.pw_short", n=MIN_PW)
    email = _clean_email(data.email)
    with db.connect() as con:
        if con.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
            raise err(409, "err.username_taken", name=name)
    _mail_limit(request)
    base = _base_url(request)
    with db.connect() as con:
        taken = con.execute("SELECT username FROM users WHERE email = ?", (email,)).fetchone()
    if taken:
        # Nicht verraten, dass die Adresse schon registriert ist – stattdessen Hinweis an die Adresse selbst
        _send_or_502(request, email, "exists", f"{base}/login#forgot", username=taken["username"])
        log(request, None, "registrierung_angefragt", username=name)
        return {"ok": True}
    token = secrets.token_urlsafe(32)
    with db.connect() as con:
        con.execute("DELETE FROM registrations WHERE email = ? OR expires_at <= datetime('now')", (email,))
        con.execute("INSERT INTO registrations (token_hash, username, email, pw_hash, expires_at) "
                    "VALUES (?, ?, ?, ?, datetime('now', ?))",
                    (_token_hash(token), name, email, db.hash_password(data.password), f"+{REGISTER_HOURS} hours"))
    try:
        _send_or_502(request, email, "confirm", f"{base}/login#confirm={token}", name=name, hours=REGISTER_HOURS)
    except HTTPException:
        with db.connect() as con:
            con.execute("DELETE FROM registrations WHERE token_hash = ?", (_token_hash(token),))
        raise
    log(request, None, "registrierung_angefragt", username=name)
    return {"ok": True}


class TokenIn(BaseModel):
    token: str = Field(min_length=20, max_length=100)


@app.post("/api/register/confirm", dependencies=[Depends(_require_json)])
def confirm_registration(data: TokenIn, request: Request, response: Response):
    with db.connect() as con:
        reg = con.execute("SELECT * FROM registrations WHERE token_hash = ? AND expires_at > datetime('now')",
                          (_token_hash(data.token),)).fetchone()
        if not reg:
            raise err(404, "err.confirm_invalid")
        con.execute("DELETE FROM registrations WHERE token_hash = ?", (reg["token_hash"],))
        if con.execute("SELECT 1 FROM users WHERE username = ?", (reg["username"],)).fetchone():
            raise err(409, "err.username_taken_meanwhile", name=reg["username"])
        if con.execute("SELECT 1 FROM users WHERE email = ?", (reg["email"],)).fetchone():
            raise err(409, "err.email_has_account")
        cur = con.execute("INSERT INTO users (username, pw_hash, is_admin, email) VALUES (?, ?, 0, ?)",
                          (reg["username"], reg["pw_hash"], reg["email"]))
        uid = cur.lastrowid
        _start_session(con, uid, request, response)
        admins = _admin_addresses(con)
    user = User(id=uid, username=reg["username"], is_admin=False)
    log(request, user, "registriert")
    for to in admins:                                    # Info an den Admin (auf Deutsch); Fehler hier sind egal
        try:
            mail.send(to, T("de", "mail.newuser.subject", name=user.username),
                      T("de", "mail.newuser.text", name=user.username),
                      f"{_base_url(request)}/admin", T("de", "mail.newuser.button"), "de")
        except mail.MailError as ex:
            log(request, None, "mail_fehler", str(ex)[:300])
    return {"ok": True}


class ForgotIn(BaseModel):
    login: str = Field(max_length=254)


@app.post("/api/password/forgot", dependencies=[Depends(_require_json)])
def forgot_password(data: ForgotIn, request: Request):
    """Antwortet immer gleich – verrät nicht, ob es Benutzer oder Adresse gibt."""
    if not mail.configured():
        raise err(503, "err.reset_not_configured")
    _mail_limit(request)
    key = data.login.strip()
    with db.connect() as con:
        u = con.execute("SELECT id, username, email FROM users WHERE (username = ? OR email = ?) AND email IS NOT NULL",
                        (key, key.lower())).fetchone()
        if not u:
            log(request, None, "passwort_vergessen", username=key[:64])
            return {"ok": True}
        token = secrets.token_urlsafe(32)
        con.execute("DELETE FROM pw_resets WHERE user_id = ? OR expires_at <= datetime('now')", (u["id"],))
        con.execute("INSERT INTO pw_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
                    (_token_hash(token), u["id"], f"+{RESET_HOURS} hours"))
    _send_or_502(request, u["email"], "reset", f"{_base_url(request)}/login#reset={token}",
                 name=u["username"], hours=RESET_HOURS)
    log(request, User(id=u["id"], username=u["username"], is_admin=False), "passwort_vergessen")
    return {"ok": True}


class ResetIn(BaseModel):
    token: str = Field(min_length=20, max_length=100)
    password: str = Field(max_length=256)


@app.post("/api/password/reset", dependencies=[Depends(_require_json)])
def reset_password(data: ResetIn, request: Request, response: Response):
    if len(data.password) < MIN_PW:
        raise err(400, "err.pw_short", n=MIN_PW)
    with db.connect() as con:
        r = con.execute("SELECT p.user_id, u.username, u.is_admin FROM pw_resets p JOIN users u ON u.id = p.user_id "
                        "WHERE p.token_hash = ? AND p.expires_at > datetime('now')", (_token_hash(data.token),)).fetchone()
        if not r:
            raise err(404, "err.reset_invalid")
        con.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (db.hash_password(data.password), r["user_id"]))
        con.execute("DELETE FROM pw_resets WHERE user_id = ?", (r["user_id"],))
        con.execute("DELETE FROM sessions WHERE user_id = ?", (r["user_id"],))
        _start_session(con, r["user_id"], request, response)
    log(request, User(id=r["user_id"], username=r["username"], is_admin=bool(r["is_admin"])), "passwort_zurueckgesetzt")
    return {"ok": True}


# ---------- Sichtbarkeit ----------

# Events, die der Benutzer :uid sehen darf
VISIBLE = ("(e.visibility = 'public' "
           "OR (e.visibility = 'private' AND e.created_by = :uid) "
           "OR (e.visibility = 'group' AND e.group_id IN (SELECT group_id FROM group_members WHERE user_id = :uid)))")


def _is_member(con, group_id: int, user_id: int) -> bool:
    return con.execute("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
                       (group_id, user_id)).fetchone() is not None


def _prune_marks(con, event_id: int) -> None:
    """Markierungen von Benutzern entfernen, die das Event nicht (mehr) sehen dürfen."""
    ev = con.execute("SELECT visibility, group_id, created_by FROM events WHERE id = ?", (event_id,)).fetchone()
    if not ev:
        return
    if ev["visibility"] == "private":
        con.execute("DELETE FROM marks WHERE event_id = ? AND user_id IS NOT ?", (event_id, ev["created_by"]))
    elif ev["visibility"] == "group":
        con.execute("DELETE FROM marks WHERE event_id = ? AND user_id NOT IN "
                    "(SELECT user_id FROM group_members WHERE group_id = ?)", (event_id, ev["group_id"]))
    # Gruppen-Teilnahme gilt nur für öffentliche Events oder die eigenen Events der Gruppe
    if ev["visibility"] != "public":
        con.execute("DELETE FROM group_events WHERE event_id = ? AND group_id IS NOT ?", (event_id, ev["group_id"]))


def _label(row) -> str:
    """Event-Bezeichnung fürs Admin-Protokoll: Titel nur bei öffentlichen Events."""
    if row["visibility"] == "public":
        return f"{row['title']} ({row['start_date']} – {row['end_date']})"
    return "(privat)" if row["visibility"] == "private" else f"(Gruppe #{row['group_id']})"


# ---------- Events ----------

class EventIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    start_date: dt.date
    end_date: dt.date
    note: str = Field(default="", max_length=2000)
    visibility: Literal["public", "group", "private"] = "private"
    group_id: Optional[int] = None
    organizer_id: Optional[int] = None
    track_id: Optional[int] = None

    @field_validator("title", "note")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("end_date")
    @classmethod
    def _order(cls, v: dt.date, info):
        start = info.data.get("start_date")
        if start and v < start:
            raise ValueError("err.end_before_start")
        return v


class MarkIn(BaseModel):
    status: Optional[Literal["geplant", "gebucht"]] = None


def _check_target(con, data: EventIn, user: User) -> Optional[int]:
    """Prüft, ob der Benutzer in die gewählte Sichtbarkeit schreiben darf; liefert group_id."""
    if data.visibility == "public":
        if user.is_admin:
            return None
        if not user.managed:
            raise err(403, "err.public_admin_only")
        if not data.organizer_id or data.organizer_id not in user.managed:
            raise err(403, "err.manager_pick_organizer")
        return None
    if data.visibility == "group":
        if not data.group_id or not _is_member(con, data.group_id, user.id):
            raise err(403, "err.not_group_member")
        return data.group_id
    return None


def _check_refs(con, data: EventIn) -> None:
    """Veranstalter und Rennstrecke müssen in den Stammdaten existieren (oder leer sein)."""
    if data.organizer_id and not con.execute("SELECT 1 FROM organizers WHERE id = ?", (data.organizer_id,)).fetchone():
        raise err(400, "err.organizer_not_found")
    if data.track_id and not con.execute("SELECT 1 FROM tracks WHERE id = ?", (data.track_id,)).fetchone():
        raise err(400, "err.track_not_found")


def _load_events(con, user: User, event_id: Optional[int] = None) -> list[dict]:
    args = {"uid": user.id}
    if event_id:
        where = "e.id = :id"
        args["id"] = event_id
    else:
        where = "e.end_date >= :first AND e.start_date <= :last"
        args.update(first=f"{YEAR}-01-01", last=f"{YEAR}-12-31")
    rows = con.execute(
        f"SELECT e.id, e.title, e.start_date, e.end_date, e.note, e.visibility, e.group_id, e.created_by, "
        f"u.username AS creator, g.name AS group_name, g.color AS group_color, "
        f"(SELECT gm.is_owner FROM group_members gm WHERE gm.group_id = e.group_id AND gm.user_id = :uid) AS group_owner, "
        f"e.organizer_id, o.name AS organizer_name, e.track_id, t.name AS track_name "
        f"FROM events e LEFT JOIN users u ON u.id = e.created_by LEFT JOIN groups_ g ON g.id = e.group_id "
        f"LEFT JOIN organizers o ON o.id = e.organizer_id LEFT JOIN tracks t ON t.id = e.track_id "
        f"WHERE {where} AND {VISIBLE} ORDER BY e.start_date, e.end_date DESC, e.title", args).fetchall()
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    # Status (geplant/gebucht) anderer nur sichtbar, wenn man mit ihnen in einer Gruppe ist
    marks = con.execute(
        f"SELECT m.event_id, m.status, u.id AS uid, u.username FROM marks m JOIN users u ON u.id = m.user_id "
        f"WHERE m.event_id IN ({','.join('?' * len(ids))}) AND (m.user_id = ? OR m.user_id IN "
        f"(SELECT m2.user_id FROM group_members m1 JOIN group_members m2 ON m2.group_id = m1.group_id "
        f"WHERE m1.user_id = ?)) ORDER BY u.username COLLATE NOCASE", [*ids, user.id, user.id]).fetchall()
    by_event: dict[int, list] = defaultdict(list)
    for m in marks:
        by_event[m["event_id"]].append(m)
    # Teilnehmende Gruppen – nur die, in denen der Benutzer selbst Mitglied ist
    groups_in: dict[int, list] = defaultdict(list)
    for g in con.execute(
            f"SELECT ge.event_id, ge.group_id FROM group_events ge JOIN group_members gm "
            f"ON gm.group_id = ge.group_id AND gm.user_id = ? WHERE ge.event_id IN ({','.join('?' * len(ids))})",
            [user.id, *ids]):
        groups_in[g["event_id"]].append(g["group_id"])
    out = []
    for r in rows:
        ms = by_event[r["id"]]
        ev = dict(r)
        creator_id, is_group_owner = ev.pop("created_by"), bool(ev.pop("group_owner"))
        if ev["visibility"] == "public":
            can_edit = user.is_admin or (ev["organizer_id"] is not None and ev["organizer_id"] in user.managed)
        elif ev["visibility"] == "private":
            can_edit = creator_id == user.id
        else:
            can_edit = creator_id == user.id or is_group_owner
        out.append({**ev, "can_edit": can_edit, "groups_in": groups_in[r["id"]],
                    "my_status": next((m["status"] for m in ms if m["uid"] == user.id), None),
                    "participants": [{"username": m["username"], "status": m["status"]} for m in ms]})
    return out


def _visible_event(con, event_id: int, user: User):
    row = con.execute(f"SELECT e.* FROM events e WHERE e.id = :id AND {VISIBLE}",
                      {"id": event_id, "uid": user.id}).fetchone()
    if not row:
        raise err(404, "err.event_not_found")
    return row


def _check_edit(con, event_id: int, user: User):
    row = _visible_event(con, event_id, user)
    ev = _load_events(con, user, event_id)[0]
    if not ev["can_edit"]:
        raise err(403, "err.event_no_edit")
    return row


@app.get("/api/version")
def version(user: User = Depends(viewer)):
    with db.connect() as con:
        return {"v": con.execute("SELECT v FROM meta WHERE k = 'version'").fetchone()[0]}


@app.get("/api/events")
def list_events(user: User = Depends(viewer)):
    with db.connect() as con:
        return _load_events(con, user)


@app.post("/api/events", dependencies=[Depends(_require_json)])
def create_event(data: EventIn, request: Request, user: User = Depends(current_user)):
    # Jeder angemeldete Benutzer: private Termine (nur für ihn sichtbar).
    # Öffentlich: Admin oder Eventmanager des Veranstalters. Gruppen-Events: nur Admin.
    if not user.is_admin and data.visibility == "group":
        raise err(403, "err.group_events_admin_only")
    with db.connect() as con:
        gid = _check_target(con, data, user)
        _check_refs(con, data)
        cur = con.execute("INSERT INTO events (title, start_date, end_date, note, visibility, group_id, created_by, "
                          "organizer_id, track_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                          (data.title, data.start_date.isoformat(), data.end_date.isoformat(), data.note,
                           data.visibility, gid, user.id, data.organizer_id or None, data.track_id or None))
        ev = _load_events(con, user, cur.lastrowid)[0]
        row = con.execute("SELECT * FROM events WHERE id = ?", (cur.lastrowid,)).fetchone()
    log(request, user, "event_angelegt", _label(row))
    return ev


@app.put("/api/events/{event_id}", dependencies=[Depends(_require_json)])
def update_event(event_id: int, data: EventIn, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        old = _check_edit(con, event_id, user)
        if old["visibility"] == "public" and data.visibility != "public" and not user.is_admin:
            raise err(403, "err.public_stays_public")
        if old["visibility"] == "private" and data.visibility != "private" and not user.is_admin:
            raise err(403, "err.private_stays_private")
        gid = _check_target(con, data, user)
        _check_refs(con, data)
        # Wird ein Event privat, gehört es danach dem, der es privat gemacht hat
        owner = user.id if data.visibility == "private" and old["visibility"] != "private" else old["created_by"]
        con.execute("UPDATE events SET title = ?, start_date = ?, end_date = ?, note = ?, visibility = ?, "
                    "group_id = ?, created_by = ?, organizer_id = ?, track_id = ?, updated_at = datetime('now') "
                    "WHERE id = ?",
                    (data.title, data.start_date.isoformat(), data.end_date.isoformat(), data.note,
                     data.visibility, gid, owner, data.organizer_id or None, data.track_id or None, event_id))
        _prune_marks(con, event_id)
        ev = _load_events(con, user, event_id)[0]
        new = con.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    log(request, user, "event_geaendert", f"{_label(old)} → {_label(new)}")
    return ev


@app.delete("/api/events/{event_id}")
def delete_event(event_id: int, request: Request, user: User = Depends(current_user)):
    _require_json(request)
    with db.connect() as con:
        old = _check_edit(con, event_id, user)
        con.execute("DELETE FROM events WHERE id = ?", (event_id,))
    log(request, user, "event_geloescht", _label(old))
    return {"ok": True}


@app.put("/api/events/{event_id}/mark", dependencies=[Depends(_require_json)])
def mark_event(event_id: int, data: MarkIn, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        row = _visible_event(con, event_id, user)
        if data.status is None:
            con.execute("DELETE FROM marks WHERE user_id = ? AND event_id = ?", (user.id, event_id))
        else:
            con.execute("INSERT INTO marks (user_id, event_id, status) VALUES (?, ?, ?) "
                        "ON CONFLICT(user_id, event_id) DO UPDATE SET status = excluded.status, "
                        "updated_at = datetime('now')", (user.id, event_id, data.status))
        ev = _load_events(con, user, event_id)[0]
    log(request, user, "status", f"{_label(row)} → {data.status or 'offen'}")
    return ev


class ParticipationIn(BaseModel):
    participates: bool


@app.put("/api/events/{event_id}/groups/{group_id}", dependencies=[Depends(_require_json)])
def set_group_participation(event_id: int, group_id: int, data: ParticipationIn, request: Request,
                            user: User = Depends(current_user)):
    """Owner einer Gruppe legen fest, ob die Gruppe an einem Event teilnimmt."""
    with db.connect() as con:
        _group(con, group_id, user, owner=True)
        row = _visible_event(con, event_id, user)
        if row["visibility"] == "private" or (row["visibility"] == "group" and row["group_id"] != group_id):
            raise err(400, "err.participation_rule")
        if data.participates:
            con.execute("INSERT OR IGNORE INTO group_events (group_id, event_id) VALUES (?, ?)", (group_id, event_id))
        else:
            con.execute("DELETE FROM group_events WHERE group_id = ? AND event_id = ?", (group_id, event_id))
        ev = _load_events(con, user, event_id)[0]
    log(request, user, "gruppe_teilnahme", f"#{group_id} {'nimmt teil' if data.participates else 'nimmt nicht teil'}: {_label(row)}")
    return ev


# ---------- Gruppen ----------

class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("err.name_missing")
        return v


class JoinIn(BaseModel):
    code: str = Field(max_length=64)


def _new_code() -> str:
    return secrets.token_urlsafe(9)          # 12 Zeichen, ~72 Bit


def _group(con, group_id: int, user: User, owner: bool = False):
    g = con.execute("SELECT * FROM groups_ WHERE id = ?", (group_id,)).fetchone()
    if not g or not _is_member(con, group_id, user.id):
        raise err(404, "err.group_not_found")
    if owner and not _is_owner(con, group_id, user.id):
        raise err(403, "err.owner_only")
    return g


def _is_owner(con, group_id: int, user_id: int) -> bool:
    return con.execute("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND is_owner = 1",
                       (group_id, user_id)).fetchone() is not None


def _pick_color(con, user_id: int) -> int:
    """Farbe, die in den Gruppen des Benutzers am seltensten vorkommt (bei Gleichstand global seltenste)."""
    mine = defaultdict(int)
    for r in con.execute("SELECT g.color FROM groups_ g JOIN group_members m ON m.group_id = g.id "
                         "WHERE m.user_id = ?", (user_id,)):
        mine[r["color"]] += 1
    glob = defaultdict(int)
    for r in con.execute("SELECT color, COUNT(*) AS n FROM groups_ GROUP BY color"):
        glob[r["color"]] = r["n"]
    return min(range(GROUP_COLORS), key=lambda c: (mine[c], glob[c], c))


def _leave(con, group_id: int, user_id: int) -> str:
    """Mitglied entfernen; dessen Markierungen an Gruppen-Events löschen.
    Bleibt danach kein Owner übrig, wird das am längsten dabei befindliche Mitglied Owner.
    Ist niemand mehr übrig, wird die Gruppe samt Events gelöscht."""
    con.execute("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", (group_id, user_id))
    con.execute("DELETE FROM marks WHERE user_id = ? AND event_id IN (SELECT id FROM events WHERE group_id = ?)",
                (user_id, group_id))
    nxt = con.execute("SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at, user_id LIMIT 1",
                      (group_id,)).fetchone()
    if not nxt:
        con.execute("DELETE FROM groups_ WHERE id = ?", (group_id,))
        return "geloescht"
    if not con.execute("SELECT 1 FROM group_members WHERE group_id = ? AND is_owner = 1", (group_id,)).fetchone():
        con.execute("UPDATE group_members SET is_owner = 1 WHERE group_id = ? AND user_id = ?", (group_id, nxt["user_id"]))
    con.execute("UPDATE groups_ SET owner_id = ? WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)",
                (nxt["user_id"], group_id, user_id))
    return "verlassen"


@app.get("/api/groups")
def list_groups(user: User = Depends(viewer)):
    if user.id == 0:
        return []
    with db.connect() as con:
        groups = con.execute("""
            SELECT g.id, g.name, g.color, g.invite_code, m.is_owner,
                   (SELECT COUNT(*) FROM events e WHERE e.group_id = g.id) AS events
            FROM groups_ g JOIN group_members m ON m.group_id = g.id
            WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE""", (user.id,)).fetchall()
        out = []
        for g in groups:
            members = con.execute("SELECT u.id, u.username, m.is_owner FROM group_members m JOIN users u ON u.id = m.user_id "
                                  "WHERE m.group_id = ? ORDER BY m.joined_at, u.id", (g["id"],)).fetchall()
            out.append({"id": g["id"], "name": g["name"], "color": g["color"], "invite_code": g["invite_code"],
                        "is_owner": bool(g["is_owner"]), "events": g["events"],
                        "members": [{"id": m["id"], "username": m["username"], "is_owner": bool(m["is_owner"])}
                                    for m in members]})
        return out


@app.post("/api/groups", dependencies=[Depends(_require_json)])
def create_group(data: GroupIn, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        n = con.execute("SELECT COUNT(*) FROM group_members WHERE user_id = ?", (user.id,)).fetchone()[0]
        if n >= MAX_GROUPS_PER_USER:
            raise err(400, "err.max_groups", n=MAX_GROUPS_PER_USER)
        cur = con.execute("INSERT INTO groups_ (name, color, invite_code, owner_id) VALUES (?, ?, ?, ?)",
                          (data.name, _pick_color(con, user.id), _new_code(), user.id))
        con.execute("INSERT INTO group_members (group_id, user_id, is_owner) VALUES (?, ?, 1)", (cur.lastrowid, user.id))
    log(request, user, "gruppe_angelegt", f"#{cur.lastrowid}")
    return {"id": cur.lastrowid}


@app.get("/api/groups/preview")
def preview_group(code: str, user: User = Depends(current_user)):
    if not CODE_RE.match(code):
        raise err(404, "err.invite_invalid")
    with db.connect() as con:
        g = con.execute("SELECT id, name, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS members "
                        "FROM groups_ g WHERE invite_code = ?", (code,)).fetchone()
        if not g:
            raise err(404, "err.invite_invalid")
        return {"id": g["id"], "name": g["name"], "members": g["members"],
                "already_member": _is_member(con, g["id"], user.id)}


@app.post("/api/groups/join", dependencies=[Depends(_require_json)])
def join_group(data: JoinIn, request: Request, user: User = Depends(current_user)):
    code = data.code.strip()
    with db.connect() as con:
        g = con.execute("SELECT id FROM groups_ WHERE invite_code = ?", (code,)).fetchone() if CODE_RE.match(code) else None
        if not g:
            log(request, user, "gruppe_beitritt_fehlgeschlagen")
            raise err(404, "err.invite_invalid")
        if not _is_member(con, g["id"], user.id):
            n = con.execute("SELECT COUNT(*) FROM group_members WHERE user_id = ?", (user.id,)).fetchone()[0]
            if n >= MAX_GROUPS_PER_USER:
                raise err(400, "err.max_groups", n=MAX_GROUPS_PER_USER)
            con.execute("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)", (g["id"], user.id))
    log(request, user, "gruppe_beigetreten", f"#{g['id']}")
    return {"id": g["id"]}


@app.put("/api/groups/{group_id}", dependencies=[Depends(_require_json)])
def rename_group(group_id: int, data: GroupIn, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        _group(con, group_id, user, owner=True)
        con.execute("UPDATE groups_ SET name = ? WHERE id = ?", (data.name, group_id))
    log(request, user, "gruppe_umbenannt", f"#{group_id}")
    return {"ok": True}


@app.post("/api/groups/{group_id}/code", dependencies=[Depends(_require_json)])
def renew_code(group_id: int, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        _group(con, group_id, user, owner=True)
        code = _new_code()
        con.execute("UPDATE groups_ SET invite_code = ? WHERE id = ?", (code, group_id))
    log(request, user, "gruppe_neuer_code", f"#{group_id}")
    return {"invite_code": code}


@app.post("/api/groups/{group_id}/leave", dependencies=[Depends(_require_json)])
def leave_group(group_id: int, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        _group(con, group_id, user)
        result = _leave(con, group_id, user.id)
    log(request, user, "gruppe_verlassen", f"#{group_id}{' (aufgelöst)' if result == 'geloescht' else ''}")
    return {"ok": True, "result": result}


@app.delete("/api/groups/{group_id}/members/{member_id}", dependencies=[Depends(_require_json)])
def remove_member(group_id: int, member_id: int, request: Request, user: User = Depends(current_user)):
    if member_id == user.id:
        raise err(400, "err.use_leave")
    with db.connect() as con:
        _group(con, group_id, user, owner=True)
        if not _is_member(con, group_id, member_id):
            raise err(404, "err.member_not_found")
        if _is_owner(con, group_id, member_id):
            raise err(400, "err.owner_not_removable")
        _leave(con, group_id, member_id)
    log(request, user, "gruppe_mitglied_entfernt", f"#{group_id}")
    return {"ok": True}


class OwnerIn(BaseModel):
    is_owner: bool


@app.put("/api/groups/{group_id}/members/{member_id}/owner", dependencies=[Depends(_require_json)])
def set_group_owner(group_id: int, member_id: int, data: OwnerIn, request: Request, user: User = Depends(current_user)):
    """Ein Owner macht ein anderes Mitglied zum Owner oder entzieht das Recht. Mindestens ein Owner bleibt."""
    with db.connect() as con:
        _group(con, group_id, user, owner=True)
        if not _is_member(con, group_id, member_id):
            raise err(404, "err.member_not_found")
        if not data.is_owner:
            n = con.execute("SELECT COUNT(*) FROM group_members WHERE group_id = ? AND is_owner = 1", (group_id,)).fetchone()[0]
            if n <= 1 and _is_owner(con, group_id, member_id):
                raise err(400, "err.need_owner")
        con.execute("UPDATE group_members SET is_owner = ? WHERE group_id = ? AND user_id = ?",
                    (int(data.is_owner), group_id, member_id))
    log(request, user, "gruppe_owner", f"#{group_id}: Mitglied #{member_id} {'ist Owner' if data.is_owner else 'kein Owner mehr'}")
    return {"ok": True}


@app.delete("/api/groups/{group_id}", dependencies=[Depends(_require_json)])
def delete_group(group_id: int, request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        _group(con, group_id, user, owner=True)
        con.execute("DELETE FROM groups_ WHERE id = ?", (group_id,))     # Events + Mitgliedschaften per CASCADE
    log(request, user, "gruppe_geloescht", f"#{group_id}")
    return {"ok": True}


# ---------- Kalender-Abo (ICS-Feed mit geheimem Link, ohne Login abrufbar) ----------

FEED_RE = re.compile(r"^[A-Za-z0-9_-]{30,64}$")
FEED_REFRESH_MIN = 60
_STATUS_ICS = {"geplant": "TENTATIVE", "gebucht": "CONFIRMED"}


def _feed_token(con, user_id: int, renew: bool = False) -> str:
    row = con.execute("SELECT feed_token FROM users WHERE id = ?", (user_id,)).fetchone()
    if row["feed_token"] and not renew:
        return row["feed_token"]
    token = secrets.token_urlsafe(32)
    con.execute("UPDATE users SET feed_token = ? WHERE id = ?", (token, user_id))
    return token


@app.get("/api/feed")
def feed_info(request: Request, user: User = Depends(current_user)):
    with db.connect() as con:
        token = _feed_token(con, user.id)
    return {"url": f"{_base_url(request)}/ical/{token}.ics"}


@app.post("/api/feed/renew", dependencies=[Depends(_require_json)])
def feed_renew(request: Request, user: User = Depends(current_user)):
    """Neuer Link – der alte funktioniert danach nicht mehr (z. B. wenn er weitergegeben wurde)."""
    with db.connect() as con:
        token = _feed_token(con, user.id, renew=True)
    log(request, user, "abo_neu")
    return {"url": f"{_base_url(request)}/ical/{token}.ics"}


@app.get("/ical/{token}.ics")
def ical_feed(token: str, request: Request, umfang: str = "meine", gruppe: Optional[int] = None, lang: str = "de"):
    """umfang=meine: eigene Markierungen, eigene private Events und Events, an denen eine eigene Gruppe teilnimmt.
    umfang=alle: alles, was der Benutzer sieht. gruppe=ID: Events der Gruppe und Events, an denen sie teilnimmt.
    lang=en: Texte auf Englisch (Kalender-Apps schicken kein Sprach-Cookie; ohne Angabe Deutsch wie bisher)."""
    lang = lang if lang in ("de", "en") else "de"
    if not FEED_RE.match(token):
        raise err(404, "err.unknown_calendar")
    with db.connect() as con:
        row = con.execute("SELECT id, username, is_admin FROM users WHERE feed_token = ?", (token,)).fetchone()
        if not row:
            raise err(404, "err.unknown_calendar")
        user = User(id=row["id"], username=row["username"], is_admin=bool(row["is_admin"]))
        events = _load_events(con, user)
        groups = {g["id"]: g["name"] for g in con.execute(
            "SELECT g.id, g.name FROM groups_ g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ?", (user.id,))}
        meta = {r["id"]: r for r in con.execute(
            "SELECT e.id, e.updated_at, e.ics_uid, t.location FROM events e LEFT JOIN tracks t ON t.id = e.track_id "
            "WHERE e.end_date >= ? AND e.start_date <= ?", (f"{YEAR}-01-01", f"{YEAR}-12-31"))}
    if gruppe is not None:
        if gruppe not in groups:
            raise err(404, "err.group_not_found")
        events = [e for e in events if gruppe in e["groups_in"] or e["group_id"] == gruppe]
        name = T(lang, "feed.name.group", name=groups[gruppe])
    elif umfang == "alle":
        name = T(lang, "feed.name.all")
    else:
        events = [e for e in events if e["my_status"] or e["groups_in"] or e["visibility"] == "private"]
        name = T(lang, "feed.name.mine")
    base = _base_url(request)
    out = []
    for e in events:
        status = e["my_status"]
        status_text = T(lang, f"status.{status}") if status else ""
        lines = []
        if status:
            lines.append(T(lang, "feed.line.status", status=status_text))
        if e["organizer_name"]:
            lines.append(T(lang, "feed.line.organizer", name=e["organizer_name"]))
        if e["track_name"]:
            lines.append(T(lang, "feed.line.track", name=e["track_name"]))
        teil = [groups[g] for g in e["groups_in"] if g in groups]
        if teil:
            lines.append(T(lang, "feed.line.groups", names=", ".join(teil)))
        if e["note"]:
            lines.append("")
            lines.append(e["note"])
        m = meta.get(e["id"])
        out.append({"uid": (m["ics_uid"] if m and m["ics_uid"] else f"jahresplaner-{e['id']}@jahresplaner"),
                    "title": (f"[{status_text}] " if status else "") + e["title"],
                    "start_date": e["start_date"], "end_date": e["end_date"], "note": "\n".join(lines).strip(),
                    "location": ", ".join(x for x in (e["track_name"], m["location"] if m else "") if x),
                    "status": _STATUS_ICS.get(status, ""), "url": f"{base}/"})
    return Response(ics.build(out, name, FEED_REFRESH_MIN), media_type="text/calendar; charset=utf-8",
                    headers={"Cache-Control": "no-store", "Content-Disposition": 'inline; filename="racingkalender.ics"'})


# ---------- Stammdaten: Veranstalter und Rennstrecken (Admin pflegt, alle lesen) ----------

def _clean_url(v: str) -> str:
    v = v.strip()
    if v and not re.match(r"^https?://", v, re.I):
        v = "https://" + v
    return v


class OrganizerIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    website: str = Field(default="", max_length=300)
    email: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=60)
    note: str = Field(default="", max_length=2000)

    @field_validator("name", "email", "phone", "note")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("website")
    @classmethod
    def _url(cls, v: str) -> str:
        return _clean_url(v)


class OrganizerDetailsIn(BaseModel):
    """Angaben, die ein Eventmanager zu seinem Veranstalter pflegen darf (Name bleibt beim Admin)."""
    website: str = Field(default="", max_length=300)
    email: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=60)
    note: str = Field(default="", max_length=2000)


class TrackIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    location: str = Field(default="", max_length=200)
    length: str = Field(default="", max_length=60)
    website: str = Field(default="", max_length=300)
    note: str = Field(default="", max_length=2000)

    @field_validator("name", "location", "length", "note")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("website")
    @classmethod
    def _url(cls, v: str) -> str:
        return _clean_url(v)


REF_TABLES = {
    "organizers": (OrganizerIn, ["name", "website", "email", "phone", "note"], "veranstalter"),
    "tracks": (TrackIn, ["name", "location", "length", "website", "note"], "strecke"),
}


def _ref_list(con, table: str) -> list[dict]:
    col = "organizer_id" if table == "organizers" else "track_id"
    rows = con.execute(f"SELECT r.*, (SELECT COUNT(*) FROM events e WHERE e.{col} = r.id) AS events "
                       f"FROM {table} r ORDER BY r.name COLLATE NOCASE").fetchall()
    return [dict(r) for r in rows]


@app.get("/api/organizers")
def list_organizers(user: User = Depends(viewer)):
    with db.connect() as con:
        return [{k: v for k, v in r.items() if k != "events" or user.is_admin} for r in _ref_list(con, "organizers")]


@app.get("/api/tracks")
def list_tracks(user: User = Depends(viewer)):
    with db.connect() as con:
        return [{k: v for k, v in r.items() if k != "events" or user.is_admin} for r in _ref_list(con, "tracks")]


def _ref_save(table: str, ref_id: Optional[int], payload: dict, request: Request, admin: User):
    model, cols, label = REF_TABLES[table]
    data = model(**payload).model_dump()
    with db.connect() as con:
        dup = con.execute(f"SELECT id FROM {table} WHERE name = ? AND id IS NOT ?", (data["name"], ref_id)).fetchone()
        if dup:
            raise err(409, "err.exists", name=data["name"])
        if ref_id is None:
            cur = con.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                              [data[c] for c in cols])
            ref_id = cur.lastrowid
            action = f"{label}_angelegt"
        else:
            if not con.execute(f"SELECT 1 FROM {table} WHERE id = ?", (ref_id,)).fetchone():
                raise err(404, "err.not_found")
            con.execute(f"UPDATE {table} SET {', '.join(c + ' = ?' for c in cols)} WHERE id = ?",
                        [data[c] for c in cols] + [ref_id])
            action = f"{label}_geaendert"
    log(request, admin, action, data["name"])
    return {"id": ref_id}


def _ref_delete(table: str, ref_id: int, request: Request, admin: User):
    _, _, label = REF_TABLES[table]
    with db.connect() as con:
        row = con.execute(f"SELECT name FROM {table} WHERE id = ?", (ref_id,)).fetchone()
        if not row:
            raise err(404, "err.not_found")
        con.execute(f"DELETE FROM {table} WHERE id = ?", (ref_id,))      # Events behalten, Feld wird leer
    log(request, admin, f"{label}_geloescht", row["name"])
    return {"ok": True}


@app.put("/api/organizers/{ref_id}", dependencies=[Depends(_require_json)])
def manager_edit_organizer(ref_id: int, data: OrganizerDetailsIn, request: Request, user: User = Depends(current_user)):
    """Eventmanager (und Admins) pflegen Website, E-Mail, Telefon und Notiz ihres Veranstalters."""
    if not user.is_admin and ref_id not in user.managed:
        raise err(403, "err.organizer_no_edit")
    with db.connect() as con:
        row = con.execute("SELECT name FROM organizers WHERE id = ?", (ref_id,)).fetchone()
    if not row:
        raise err(404, "err.organizer_not_found")
    return _ref_save("organizers", ref_id, {**data.model_dump(), "name": row["name"]}, request, user)


@app.post("/api/admin/organizers", dependencies=[Depends(_require_json)])
def add_organizer(data: OrganizerIn, request: Request, admin: User = Depends(admin_user)):
    return _ref_save("organizers", None, data.model_dump(), request, admin)


@app.put("/api/admin/organizers/{ref_id}", dependencies=[Depends(_require_json)])
def edit_organizer(ref_id: int, data: OrganizerIn, request: Request, admin: User = Depends(admin_user)):
    return _ref_save("organizers", ref_id, data.model_dump(), request, admin)


@app.delete("/api/admin/organizers/{ref_id}", dependencies=[Depends(_require_json)])
def delete_organizer(ref_id: int, request: Request, admin: User = Depends(admin_user)):
    return _ref_delete("organizers", ref_id, request, admin)


@app.post("/api/admin/tracks", dependencies=[Depends(_require_json)])
def add_track(data: TrackIn, request: Request, admin: User = Depends(admin_user)):
    return _ref_save("tracks", None, data.model_dump(), request, admin)


@app.put("/api/admin/tracks/{ref_id}", dependencies=[Depends(_require_json)])
def edit_track(ref_id: int, data: TrackIn, request: Request, admin: User = Depends(admin_user)):
    return _ref_save("tracks", ref_id, data.model_dump(), request, admin)


@app.delete("/api/admin/tracks/{ref_id}", dependencies=[Depends(_require_json)])
def delete_track(ref_id: int, request: Request, admin: User = Depends(admin_user)):
    return _ref_delete("tracks", ref_id, request, admin)


# ---------- ICS Import / Export (Admin, nur öffentliche Events) ----------

OWN_UID = re.compile(r"^jahresplaner-(\d+)@jahresplaner$")


@app.get("/api/admin/export.ics")
def export_ics(request: Request, admin: User = Depends(admin_user)):
    with db.connect() as con:
        rows = con.execute(
            "SELECT e.id, e.title, e.start_date, e.end_date, e.note, e.ics_uid, o.name AS organizer, "
            "t.name AS track, t.location AS track_location FROM events e "
            "LEFT JOIN organizers o ON o.id = e.organizer_id LEFT JOIN tracks t ON t.id = e.track_id "
            "WHERE e.visibility = 'public' ORDER BY e.start_date, e.title").fetchall()
    events = [{"uid": r["ics_uid"] or f"jahresplaner-{r['id']}@jahresplaner", "title": r["title"],
               "start_date": r["start_date"], "end_date": r["end_date"], "note": r["note"],
               "location": ", ".join(x for x in (r["track"], r["track_location"]) if x),
               "organizer": r["organizer"] or "", "track": r["track"] or ""} for r in rows]
    log(request, admin, "ics_export", f"{len(events)} Events")
    return Response(ics.build(events, T(lang_of(request), "feed.name.public")), media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="racingkalender-{dt.date.today()}.ics"',
                             "Cache-Control": "no-store"})


class IcsIn(BaseModel):
    ics: str = Field(max_length=5_000_000)
    create_refs: bool = False              # unbekannte Veranstalter/Strecken als Stammdaten anlegen


def _ref_id(con, table: str, name: str, create: bool, created: list, location: str = "", lang: str = "de") -> Optional[int]:
    name = (name or "").strip()[:100]
    if not name:
        return None
    row = con.execute(f"SELECT id FROM {table} WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    if not create:
        return None
    if table == "tracks":
        cur = con.execute("INSERT INTO tracks (name, location) VALUES (?, ?)", (name, location[:200]))
    else:
        cur = con.execute(f"INSERT INTO {table} (name) VALUES (?)", (name,))
    created.append(T(lang, "import.ref.track" if table == "tracks" else "import.ref.organizer", name=name))
    return cur.lastrowid


def _ref_norm(s: str) -> str:
    s = s.lower().replace("ß", "ss")
    for a, b in (("ä", "a"), ("ö", "o"), ("ü", "u"), ("ae", "a"), ("oe", "o"), ("ue", "u")):
        s = s.replace(a, b)
    return " " + re.sub(r"[^a-z0-9]+", " ", s).strip() + " "


def _ref_keys(con, table: str) -> list[tuple[str, int]]:
    """Suchschlüssel für bekannte Stammdaten im Freitext (längste zuerst)."""
    keys = []
    for r in con.execute(f"SELECT id, name FROM {table}"):
        n = _ref_norm(r["name"]).strip()
        if len(n) >= 3:
            keys.append((n, r["id"]))
        if table == "tracks" and n.endswith("ring") and len(n) >= 9:
            keys.append((n[:-4].strip(), r["id"]))          # Hockenheimring ↔ Hockenheim
    return sorted(keys, key=lambda k: -len(k[0]))


def _ref_in_text(keys: list[tuple[str, int]], text: str) -> Optional[int]:
    t = _ref_norm(text)
    return next((i for k, i in keys if f" {k} " in t), None)


@app.post("/api/admin/import", dependencies=[Depends(_require_json)])
def import_ics(data: IcsIn, request: Request, admin: User = Depends(admin_user)):
    """Importiert VEVENTs als öffentliche Events. Gleiche UID → bestehendes Event wird aktualisiert."""
    if "BEGIN:VCALENDAR" not in data.ics.upper():
        raise err(400, "err.not_ics")
    items = ics.parse(data.ics)
    lang = lang_of(request)
    res = {"neu": 0, "aktualisiert": 0, "uebersprungen": [], "unbekannt": [], "angelegt": [], "ohne_zuordnung": 0}
    unknown = set()
    with db.connect() as con:
        for it in items:
            label = it["title"] or it["uid"] or T(lang, "import.untitled")
            if it["skip"]:
                key, values = it["skip"]
                res["uebersprungen"].append(f"{label}: {T(lang, key, **values)}")
                continue
            note = it["note"]
            # Strecke: eigenes Feld bzw. „Strecke: …“ im Text, sonst LOCATION (ganz oder Teil vor dem ersten Komma)
            tid = None
            if it["location"]:
                tid = _ref_id(con, "tracks", it["location"], False, [])
            if tid is None and it["track"]:
                loc_rest = it["location"].split(",", 1)[1].strip() if it["track_from_location"] and "," in it["location"] else ""
                tid = _ref_id(con, "tracks", it["track"], data.create_refs, res["angelegt"], loc_rest, lang)
            oid = _ref_id(con, "organizers", it["organizer"], data.create_refs, res["angelegt"], lang=lang)
            # Nichts Ausdrückliches gefunden → bekannte Namen in Titel, Beschreibung und Ort suchen
            text = f"{it['title']} {note} {it['location']}"
            if tid is None:
                tid = _ref_in_text(_ref_keys(con, "tracks"), text)
            if oid is None:
                oid = _ref_in_text(_ref_keys(con, "organizers"), text)
            if tid is None and it["track"]:
                unknown.add(T(lang, "import.ref.track", name=it["track"]))
            if oid is None and it["organizer"]:
                unknown.add(T(lang, "import.ref.organizer", name=it["organizer"]))
            if tid is None and it["location"]:              # Ort nicht verlieren, wenn er keiner Strecke zugeordnet ist
                note = f"Ort: {it['location']}\n{note}".strip()
            if tid is None and oid is None:
                res["ohne_zuordnung"] += 1

            title, note = it["title"][:120], note[:2000]
            start, end = it["start"].isoformat(), it["end"].isoformat()
            existing = None
            if (m := OWN_UID.match(it["uid"])):
                existing = con.execute("SELECT id, visibility FROM events WHERE id = ?", (int(m[1]),)).fetchone()
            if existing is None and it["uid"]:
                existing = con.execute("SELECT id, visibility FROM events WHERE ics_uid = ?", (it["uid"][:300],)).fetchone()
            if existing is not None:
                if existing["visibility"] != "public":
                    res["uebersprungen"].append(f"{label}: {T(lang, 'import.skip.uid_private')}")
                    continue
                con.execute("UPDATE events SET title = ?, start_date = ?, end_date = ?, note = ?, "
                            "organizer_id = COALESCE(?, organizer_id), track_id = COALESCE(?, track_id), updated_at = datetime('now') WHERE id = ?",
                            (title, start, end, note, oid, tid, existing["id"]))
                res["aktualisiert"] += 1
            else:
                con.execute("INSERT INTO events (title, start_date, end_date, note, visibility, created_by, "
                            "organizer_id, track_id, ics_uid) VALUES (?, ?, ?, ?, 'public', ?, ?, ?, ?)",
                            (title, start, end, note, admin.id, oid, tid,
                             it["uid"][:300] if it["uid"] and not OWN_UID.match(it["uid"]) else None))
                res["neu"] += 1
    res["unbekannt"] = sorted(unknown)
    log(request, admin, "ics_import", f"{res['neu']} neu, {res['aktualisiert']} aktualisiert, "
                                      f"{len(res['uebersprungen'])} übersprungen")
    return res


# ---------- Aktivität ----------

CLIENT_ACTIONS = {"ansicht_jahr", "ansicht_woche", "ansicht_monat", "event_angesehen", "video_angesehen"}


class LogIn(BaseModel):
    action: str = Field(max_length=40)
    detail: str = Field(default="", max_length=200)


@app.post("/api/log", dependencies=[Depends(_require_json)])
def client_log(data: LogIn, request: Request, user: User = Depends(viewer)):
    if data.action not in CLIENT_ACTIONS:
        raise err(400, "err.unknown_action")
    if user.id == 0:                               # Besucher ohne Konto werden nicht protokolliert
        return {"ok": True}
    detail = data.detail
    if data.action == "event_angesehen":           # Client schickt die ID; Titel nur bei öffentlichen Events
        try:
            with db.connect() as con:
                detail = _label(_visible_event(con, int(data.detail), user))
        except (ValueError, HTTPException):
            return {"ok": True}
    log(request, user, data.action, detail)
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
            SELECT u.id, u.username, u.is_admin, u.created_at, u.email,
                   (SELECT MAX(ts) FROM activity a WHERE a.user_id = u.id AND a.action = 'login') AS last_login,
                   (SELECT MAX(ts) FROM activity a WHERE a.user_id = u.id) AS last_seen,
                   (SELECT COUNT(*) FROM activity a WHERE a.user_id = u.id AND a.action = 'login') AS logins,
                   (SELECT COUNT(*) FROM activity a WHERE a.user_id = u.id) AS actions,
                   (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions,
                   (SELECT COUNT(*) FROM marks m WHERE m.user_id = u.id AND m.status = 'geplant') AS geplant,
                   (SELECT COUNT(*) FROM marks m WHERE m.user_id = u.id AND m.status = 'gebucht') AS gebucht,
                   (SELECT COUNT(*) FROM events e WHERE e.created_by = u.id) AS events,
                   (SELECT COUNT(*) FROM group_members g WHERE g.user_id = u.id) AS groups
            FROM users u ORDER BY u.username""").fetchall()
        orgs: dict[int, list] = defaultdict(list)
        for r in con.execute("SELECT m.user_id, o.id, o.name FROM organizer_managers m "
                             "JOIN organizers o ON o.id = m.organizer_id ORDER BY o.name COLLATE NOCASE"):
            orgs[r["user_id"]].append({"id": r["id"], "name": r["name"]})
        return [{**dict(r), "organizers": orgs[r["id"]]} for r in rows]


# ---------- Benutzerverwaltung (Admin) ----------

class NewUserIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)
    is_admin: bool = False
    email: str = Field(default="", max_length=254)


class EmailIn(BaseModel):
    email: str = Field(default="", max_length=254)


class PasswordIn(BaseModel):
    password: str = Field(max_length=256)


class AdminFlagIn(BaseModel):
    is_admin: bool


class ManagerIn(BaseModel):
    organizer_ids: list[int] = Field(default=[], max_length=500)


def _check_pw(pw: str) -> None:
    if len(pw) < MIN_PW:
        raise err(400, "err.pw_short", n=MIN_PW)


def _get_user(con, user_id: int):
    row = con.execute("SELECT id, username, is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise err(404, "err.user_not_found")
    return row


@app.post("/api/admin/users", dependencies=[Depends(_require_json)])
def admin_add_user(data: NewUserIn, request: Request, admin: User = Depends(admin_user)):
    name = data.username.strip()
    if not NAME_RE.match(name):
        raise err(400, "err.username_rule")
    _check_pw(data.password)
    email = _clean_email(data.email) if data.email.strip() else None
    with db.connect() as con:
        if con.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
            raise err(409, "err.user_exists", name=name)
        if email and con.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise err(409, "err.email_taken")
        con.execute("INSERT INTO users (username, pw_hash, is_admin, email) VALUES (?, ?, ?, ?)",
                    (name, db.hash_password(data.password), int(data.is_admin), email))
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


@app.put("/api/admin/users/{user_id}/email", dependencies=[Depends(_require_json)])
def admin_set_email(user_id: int, data: EmailIn, request: Request, admin: User = Depends(admin_user)):
    email = _clean_email(data.email) if data.email.strip() else None
    with db.connect() as con:
        u = _get_user(con, user_id)
        if email and con.execute("SELECT 1 FROM users WHERE email = ? AND id != ?", (email, user_id)).fetchone():
            raise err(409, "err.email_taken")
        con.execute("UPDATE users SET email = ? WHERE id = ?", (email, user_id))
    log(request, admin, "benutzer_email", f"{u['username']}: {'gesetzt' if email else 'entfernt'}")
    return {"ok": True}


@app.put("/api/admin/users/{user_id}/admin", dependencies=[Depends(_require_json)])
def admin_set_flag(user_id: int, data: AdminFlagIn, request: Request, admin: User = Depends(admin_user)):
    if user_id == admin.id and not data.is_admin:
        raise err(400, "err.own_admin")
    with db.connect() as con:
        u = _get_user(con, user_id)
        con.execute("UPDATE users SET is_admin = ? WHERE id = ?", (int(data.is_admin), user_id))
    log(request, admin, "benutzer_rolle", f"{u['username']} → {'Admin' if data.is_admin else 'Benutzer'}")
    return {"ok": True}


@app.put("/api/admin/users/{user_id}/organizers", dependencies=[Depends(_require_json)])
def admin_set_manager(user_id: int, data: ManagerIn, request: Request, admin: User = Depends(admin_user)):
    """Rolle Eventmanager: legt fest, für welche Veranstalter der Benutzer Events anlegen, ändern und löschen darf."""
    ids = sorted(set(data.organizer_ids))
    with db.connect() as con:
        u = _get_user(con, user_id)
        if ids:
            found = {r["id"]: r["name"] for r in con.execute(
                f"SELECT id, name FROM organizers WHERE id IN ({','.join('?' * len(ids))})", ids)}
            if len(found) != len(ids):
                raise err(400, "err.organizer_not_found")
        else:
            found = {}
        con.execute("DELETE FROM organizer_managers WHERE user_id = ?", (user_id,))
        con.executemany("INSERT INTO organizer_managers (user_id, organizer_id) VALUES (?, ?)",
                        [(user_id, i) for i in ids])
    names = ", ".join(sorted(found.values(), key=str.lower)) or "keine"
    log(request, admin, "benutzer_eventmanager", f"{u['username']}: {names}")
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
        raise err(400, "err.own_delete")
    with db.connect() as con:
        u = _get_user(con, user_id)
        con.execute("DELETE FROM events WHERE visibility = 'private' AND created_by = ?", (user_id,))
        for g in con.execute("SELECT group_id FROM group_members WHERE user_id = ?", (user_id,)).fetchall():
            _leave(con, g["group_id"], user_id)
        con.execute("DELETE FROM users WHERE id = ?", (user_id,))
    log(request, admin, "benutzer_geloescht", u["username"])
    return {"ok": True}


# ---------- Seiten ----------

# Smartphones (nicht Tablets): "Mobi" steht in fast allen Handy-Browsern
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
    page = "mobile.html" if _wants_mobile(request) else "index.html"
    return FileResponse(STATIC / page, headers={"Cache-Control": "no-store", "Vary": "User-Agent, Cookie"})


# ---------- Erklär-Videos (vom Admin hochgeladen, liegen in APP_DATA/media) ----------
MEDIA = Path(os.environ["APP_DATA"]) / "media"
VIDEOS = {"desktop": "teaser-desktop.mp4", "mobil": "teaser-mobil.mp4"}
MAX_VIDEO = 9 * 1024 * 1024              # unter der Upload-Grenze von 10 MB pro Request


def _video_info() -> dict:
    out = {}
    for kind, name in VIDEOS.items():
        p = MEDIA / name
        if p.is_file():
            st = p.stat()
            out[kind] = {"url": f"/media/{name}?v={int(st.st_mtime)}", "size": st.st_size}
    return out


@app.get("/media/{name}")
def media_file(name: str):
    if name not in VIDEOS.values() or not (MEDIA / name).is_file():
        raise err(404, "err.not_found")
    return FileResponse(MEDIA / name, media_type="video/mp4", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/admin/videos")
def admin_videos(user: User = Depends(admin_user)):
    return _video_info()


@app.put("/api/admin/videos/{kind}")
async def upload_video(kind: str, request: Request, user: User = Depends(admin_user)):
    # Rohdaten mit Content-Type video/mp4: fremde Seiten können das nicht ohne CORS-Freigabe senden
    if kind not in VIDEOS:
        raise err(404, "err.unknown_video")
    if request.headers.get("content-type", "").split(";")[0].strip() != "video/mp4":
        raise err(415, "err.mp4_required")
    MEDIA.mkdir(parents=True, exist_ok=True)
    tmp, size, head = MEDIA / f"{VIDEOS[kind]}.part", 0, b""
    try:
        with open(tmp, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_VIDEO:
                    raise err(413, "err.video_too_big", n=MAX_VIDEO // (1024 * 1024))
                if len(head) < 12:
                    head += chunk[:12]
                f.write(chunk)
        if head[4:8] != b"ftyp":
            raise err(415, "err.not_mp4")
        os.replace(tmp, MEDIA / VIDEOS[kind])
    finally:
        tmp.unlink(missing_ok=True)
    log(request, user, "video_hochgeladen", f"{kind}, {size // 1024} KB")
    return _video_info()


@app.delete("/api/admin/videos/{kind}", dependencies=[Depends(_require_json)])
def delete_video(kind: str, request: Request, user: User = Depends(admin_user)):
    if kind not in VIDEOS:
        raise err(404, "err.unknown_video")
    (MEDIA / VIDEOS[kind]).unlink(missing_ok=True)
    log(request, user, "video_entfernt", kind)
    return _video_info()


@app.get("/join/{code}")
def join_link(code: str):
    """Einladungslink: Code im Fragment weiterreichen (überlebt den Umweg über /login)."""
    if not CODE_RE.match(code):
        return RedirectResponse("/", status_code=303)
    return RedirectResponse(f"/#join={code}", status_code=303)


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
    """Reine ASGI-Middleware: hängt nur Header an.
    /static/*: no-cache – Browser fragen jedes Mal nach (meist 304), damit nach einem Deploy
    nie alte und neue JS-Dateien gemischt werden."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        static = scope.get("path", "").startswith("/static/")

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", [])) + _SEC_HEADERS
                if static and not any(k.lower() == b"cache-control" for k, _ in headers):
                    headers.append((b"cache-control", b"no-cache"))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


app.add_middleware(SecurityHeaders)
