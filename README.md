# Jahreskalender 2027

## Start

```bash
pip install -r requirements.txt       # einmalig: fastapi, uvicorn
python3 user.py add stefan --admin    # Benutzer anlegen
python3 run.py                        # läuft auf 127.0.0.1:8005
```

Port, Host und Jahr stehen oben in `run.py`. Daten liegen in `data/kalender.db`.

## Update

Neue Dateien drüberkopieren, Dienst neu starten. `data/` bleibt unberührt.

## Benutzer

```bash
python3 user.py add anna [--admin]
python3 user.py passwd anna
python3 user.py admin anna on|off
python3 user.py del anna
python3 user.py list
python3 user.py logout anna
```

## Server

- `deploy/jahreskalender.service`: systemd-Unit (Pfad und User anpassen). Der User braucht Schreibrecht auf `data/`.
- `deploy/Caddyfile.snippet`: Reverse-Proxy auf Port 8005.

## Bedienung

- **Jahresansicht:** Monate als Zeilen, Spalten nach Wochentag ausgerichtet. Feiertage Baden-Württemberg markiert.
- **Wochenansicht:** Klick auf einen Tag oder „KW“. ←/→ blättern, Esc zurück.
- **Event anklicken:** Status offen / geplant / gebucht setzen, Teilnehmer sehen.
- **Neues Event (alle):** in der Jahresansicht über mehrere Tage ziehen oder in der Wochenansicht einen Tag anklicken. Bearbeiten/Löschen darf der Ersteller oder ein Admin.
- **Maus über ein Event:** zeigt, wer gebucht bzw. geplant hat.
- **Teilnehmer-Filter:** Button „Teilnehmer“ → Personen auswählen (geplant und gebucht zählen gleich). „alle zusammen“ zeigt Events, bei denen alle Gewählten dabei sind, „mindestens einer“ Events mit irgendeinem davon. Auswahl wird im Browser gemerkt.
- Änderungen anderer erscheinen automatisch nach spätestens 10 Sekunden (bzw. sofort beim Zurückwechseln in den Tab).

## Admin-Seite

`/admin` (Link oben rechts, nur für Admins): Benutzerübersicht (Logins, zuletzt aktiv, aktive Sitzungen, Markierungen) und Aktivitätsprotokoll (Login/Logout, fehlgeschlagene Logins, Jahres-/Wochenansicht, Event angesehen/angelegt/geändert/gelöscht, Status gesetzt) mit IP und Filter nach Benutzer/Aktion. Aktualisiert sich live. Einträge älter als 180 Tage werden beim Start gelöscht (`ACTIVITY_DAYS` in `app/main.py`).

## Smartphone

Handys bekommen unter `/` automatisch eine eigene Oberfläche (Erkennung per User-Agent, Tablets erhalten die Desktop-Version): Jahresübersicht als 12 Mini-Monate mit farbigen Tagen, Tippen öffnet den Monat mit Terminliste und Status-Umschalter, „+“ legt ein Event an, Wischen wechselt den Monat.
Umschalten (wird per Cookie gemerkt): `/?ansicht=mobil`, `/?ansicht=desktop`, `/?ansicht=auto`. Links dafür: „Handy“ oben in der Desktop-Version, „Desktop-Ansicht“ im Menü der Handy-Version.
