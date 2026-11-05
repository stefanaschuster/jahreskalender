# Jahreskalender 2027

Eine Codebasis, zwei Betriebsarten: auf **nativeai** (Unix-Socket, gestartet von der Umgebung) oder **selbst gehostet** mit `run.py` auf Port 8005.

```
code/app.py            FastAPI-Anwendung (Objekt `app`)
code/db.py             SQLite und Passwort-Hashing
code/requirements.txt  gepinnte Abhängigkeiten
code/static/           Frontend (Vanilla HTML/CSS/JS, kein Build)
run.py                 Start selbst gehostet (Port 8005)
user.py                Benutzerverwaltung auf der Kommandozeile
deploy/                systemd-Unit und Caddy-Snippet für selbst gehostet
.env.example           Konfiguration
```

Daten liegen in `$APP_DATA/kalender.db`. Ohne `APP_DATA` (selbst gehostet) ist das `data/kalender.db`.

## Konfiguration (`.env`)

| Variable | Bedeutung |
|---|---|
| `KAL_YEAR` | Kalenderjahr (Standard 2027) |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Erster Admin; wird nur angelegt, solange die Datenbank noch keine Benutzer hat |

## nativeai

Inhalt von `code/` als `code/` der App hochladen, `.env` setzen, deployen. `run.py`, `user.py` und `deploy/` werden dort nicht gebraucht.

## Selbst gehostet

```bash
pip install -r requirements.txt
python3 user.py add stefan --admin    # oder ADMIN_USER/ADMIN_PASSWORD als Umgebungsvariablen
python3 run.py                        # läuft auf 127.0.0.1:8005
```

Port, Host und Jahr stehen oben in `run.py`. Update: Dateien drüberkopieren, Dienst neu starten; `data/` bleibt unberührt.

- `deploy/jahreskalender.service`: systemd-Unit (Pfad und User anpassen). Der User braucht Schreibrecht auf `data/`.
- `deploy/Caddyfile.snippet`: Reverse-Proxy auf Port 8005.

### Benutzer auf der Kommandozeile

```bash
python3 user.py add anna [--admin]
python3 user.py passwd anna
python3 user.py admin anna on|off
python3 user.py del anna
python3 user.py list
python3 user.py logout anna
```

## Bedienung

- **Jahresansicht:** Monate als Zeilen, Spalten nach Wochentag ausgerichtet. Feiertage Baden-Württemberg markiert.
- **Wochenansicht:** Klick auf einen Tag oder „KW“. ←/→ blättern, Esc zurück.
- **Event anklicken:** Status offen / geplant / gebucht setzen, Teilnehmer sehen.
- **Neues Event (alle):** in der Jahresansicht über mehrere Tage ziehen oder in der Wochenansicht einen Tag anklicken. Bearbeiten/Löschen darf der Ersteller oder ein Admin.
- **Maus über ein Event:** zeigt, wer gebucht bzw. geplant hat.
- **Teilnehmer-Filter:** Button „Teilnehmer“ → Personen auswählen (geplant und gebucht zählen gleich). „alle zusammen“ zeigt Events, bei denen alle Gewählten dabei sind, „mindestens einer“ Events mit irgendeinem davon. Auswahl wird im Browser gemerkt.
- **Eigenes Passwort ändern:** Button „Passwort“ (Desktop) bzw. Menü → „Passwort ändern“ (Handy). Andere Geräte werden dabei abgemeldet.
- Änderungen anderer erscheinen automatisch nach spätestens 10 Sekunden (bzw. sofort beim Zurückwechseln in den Tab).

## Admin-Seite

`/admin` (Link oben rechts, nur für Admins):

- **Benutzerverwaltung:** „+ Benutzer“ legt Benutzer mit Passwort an (optional als Admin, mit Passwort-Generator). Je Benutzer: Passwort setzen, Admin an/aus, Sitzungen beenden, löschen. Den eigenen Benutzer kann man weder löschen noch zum Nicht-Admin machen.
- **Übersicht:** Logins, zuletzt aktiv, aktive Sitzungen, Markierungen.
- **Aktivitätsprotokoll:** Login/Logout, fehlgeschlagene Logins, Ansichten, Events, Status, Passwort- und Benutzeränderungen, mit IP und Filter nach Benutzer/Aktion. Aktualisiert sich live. Einträge älter als 180 Tage werden beim Start gelöscht (`ACTIVITY_DAYS` in `code/app.py`).

## Smartphone

Handys bekommen unter `/` automatisch eine eigene Oberfläche (Erkennung per User-Agent, Tablets erhalten die Desktop-Version): Jahresübersicht als 12 Mini-Monate mit farbigen Tagen, Tippen öffnet den Monat mit Terminliste und Status-Umschalter, „+“ legt ein Event an, Wischen wechselt den Monat.
Umschalten (wird per Cookie gemerkt): `/?ansicht=mobil`, `/?ansicht=desktop`, `/?ansicht=auto`. Links dafür: „Handy“ oben in der Desktop-Version, „Desktop-Ansicht“ im Menü der Handy-Version.
