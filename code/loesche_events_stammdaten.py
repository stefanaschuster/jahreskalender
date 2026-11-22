"""Löscht ALLE Events sowie alle Veranstalter und Rennstrecken von racingkalender.de.

Gelöscht werden:
  - alle Events (öffentlich, Gruppe, privat) samt Markierungen (geplant/gebucht) und Gruppen-Teilnahmen
  - alle Veranstalter (damit auch alle Eventmanager-Zuordnungen)
  - alle Rennstrecken
Erhalten bleiben: Benutzer, Gruppen, Aktivitätsprotokoll, Erklär-Videos.

Vorher wird eine Sicherung der Datenbank angelegt: data/kalender-vor-loeschung-<datum-zeit>.db

Aufruf im App-Verzeichnis (dort, wo code/ und data/ liegen):
    python code/loesche_events_stammdaten.py          # fragt nach, Bestätigung mit LÖSCHEN
    python code/loesche_events_stammdaten.py --ja     # ohne Rückfrage
Die App muss nicht gestoppt werden; offene Browser laden die leeren Daten automatisch neu.
"""
import datetime as dt
import os
import sqlite3
import sys
from pathlib import Path

DATA = Path(os.environ.get("APP_DATA") or Path(__file__).resolve().parent.parent / "data")
DB = DATA / "kalender.db"
TABLES = [("marks", "Markierungen"), ("group_events", "Gruppen-Teilnahmen"), ("events", "Events"),
          ("organizer_managers", "Eventmanager-Zuordnungen"), ("organizers", "Veranstalter"),
          ("tracks", "Rennstrecken")]


def main() -> int:
    if not DB.is_file():
        print(f"Datenbank nicht gefunden: {DB}\nIm App-Verzeichnis aufrufen oder APP_DATA setzen.")
        return 1
    con = sqlite3.connect(DB, timeout=30)
    con.execute("PRAGMA foreign_keys = ON")
    have = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    tables = [(t, label) for t, label in TABLES if t in have]
    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t, _ in tables}

    print(f"Datenbank: {DB}")
    for t, label in tables:
        print(f"  {label:<26} {counts[t]:>6}")
    if not any(counts.values()):
        print("Nichts zu löschen.")
        return 0

    if "--ja" not in sys.argv[1:]:
        if not sys.stdin.isatty():
            print("Abbruch: ohne Terminal bitte mit --ja aufrufen.")
            return 1
        if input("\nAlles oben Genannte endgültig löschen? Zum Bestätigen LÖSCHEN eingeben: ").strip() != "LÖSCHEN":
            print("Abgebrochen, nichts gelöscht.")
            return 1

    backup = DATA / f"kalender-vor-loeschung-{dt.datetime.now():%Y%m%d-%H%M%S}.db"
    dst = sqlite3.connect(backup)
    con.backup(dst)
    dst.close()
    print(f"Sicherung: {backup}")

    summary = ", ".join(f"{counts[t]} {label}" for t, label in tables if t in ("events", "organizers", "tracks"))
    with con:
        for t, _ in tables:
            con.execute(f"DELETE FROM {t}")
        if "activity" in have:
            con.execute("INSERT INTO activity (user_id, username, action, detail, ip) VALUES (NULL, 'Skript', "
                        "'daten_geloescht', ?, '')", (summary,))
    con.close()
    print(f"Gelöscht: {summary}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
