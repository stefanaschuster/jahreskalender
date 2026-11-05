#!/usr/bin/env python3
"""Benutzerverwaltung für den Jahreskalender auf der Kommandozeile (selbst gehostet).
Alternativ: Admin-Seite im Browser.

  python3 user.py add <name> [--admin]   Benutzer anlegen (Passwort wird abgefragt)
  python3 user.py passwd <name>          Passwort ändern (meldet alle Sitzungen ab)
  python3 user.py admin <name> on|off    Admin-Recht setzen/entziehen
  python3 user.py del <name>             Benutzer löschen (inkl. Markierungen)
  python3 user.py list                   Benutzer auflisten
  python3 user.py logout <name>          Alle Sitzungen eines Benutzers beenden
"""
import argparse
import getpass
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("APP_DATA", str(ROOT / "data"))
sys.path.insert(0, str(ROOT / "code"))
import db  # noqa: E402

NAME_RE = re.compile(r"^[A-Za-z0-9._-]{2,64}$")


def ask_password() -> str:
    pw = getpass.getpass("Passwort: ")
    if len(pw) < 10:
        sys.exit("Passwort muss mindestens 10 Zeichen haben.")
    if getpass.getpass("Wiederholen: ") != pw:
        sys.exit("Passwörter stimmen nicht überein.")
    return pw


def get_user(con, name):
    row = con.execute("SELECT id, username, is_admin FROM users WHERE username = ?", (name,)).fetchone()
    if not row:
        sys.exit(f"Benutzer '{name}' nicht gefunden.")
    return row


def main() -> None:
    p = argparse.ArgumentParser(prog="user.py", description="Benutzerverwaltung Jahreskalender")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("name"); a.add_argument("--admin", action="store_true")
    sub.add_parser("passwd").add_argument("name")
    ad = sub.add_parser("admin"); ad.add_argument("name"); ad.add_argument("flag", choices=["on", "off"])
    sub.add_parser("del").add_argument("name")
    sub.add_parser("list")
    sub.add_parser("logout").add_argument("name")
    args = p.parse_args()

    db.init_db()
    with db.connect() as con:
        if args.cmd == "add":
            if not NAME_RE.match(args.name):
                sys.exit("Name: 2–64 Zeichen, erlaubt sind A–Z, a–z, 0–9, Punkt, Unterstrich, Bindestrich.")
            if con.execute("SELECT 1 FROM users WHERE username = ?", (args.name,)).fetchone():
                sys.exit(f"Benutzer '{args.name}' existiert bereits.")
            con.execute("INSERT INTO users (username, pw_hash, is_admin) VALUES (?, ?, ?)",
                        (args.name, db.hash_password(ask_password()), int(args.admin)))
            print(f"Angelegt: {args.name}{' (Admin)' if args.admin else ''}")

        elif args.cmd == "passwd":
            u = get_user(con, args.name)
            con.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (db.hash_password(ask_password()), u["id"]))
            con.execute("DELETE FROM sessions WHERE user_id = ?", (u["id"],))
            print(f"Passwort geändert, Sitzungen beendet: {u['username']}")

        elif args.cmd == "admin":
            u = get_user(con, args.name)
            con.execute("UPDATE users SET is_admin = ? WHERE id = ?", (int(args.flag == "on"), u["id"]))
            print(f"Admin {args.flag}: {u['username']}")

        elif args.cmd == "del":
            u = get_user(con, args.name)
            if input(f"'{u['username']}' wirklich löschen? [j/N] ").strip().lower() != "j":
                sys.exit("Abgebrochen.")
            con.execute("DELETE FROM users WHERE id = ?", (u["id"],))
            print(f"Gelöscht: {u['username']}")

        elif args.cmd == "logout":
            u = get_user(con, args.name)
            n = con.execute("DELETE FROM sessions WHERE user_id = ?", (u["id"],)).rowcount
            print(f"{n} Sitzung(en) beendet: {u['username']}")

        elif args.cmd == "list":
            rows = con.execute("SELECT username, is_admin, created_at FROM users ORDER BY username").fetchall()
            if not rows:
                print("Keine Benutzer.")
            for r in rows:
                print(f"{r['username']:<24} {'Admin' if r['is_admin'] else '     '}  angelegt {r['created_at']}")


if __name__ == "__main__":
    main()
