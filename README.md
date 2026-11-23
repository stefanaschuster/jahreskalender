# racingkalender.de

Jahreskalender für Trackdays und Rennen: öffentliche Termine der Veranstalter, Gruppen-Termine und private Termine,
je Termin der eigene Status (offen / geplant / gebucht). Desktop-Version und eigene Handy-Oberfläche.

Eine Codebasis, zwei Betriebsarten: auf **instant-run** (Unix-Socket, gestartet von der Umgebung) oder **selbst gehostet** mit `run.py` auf Port 8005.

```
code/app.py                        FastAPI-Anwendung (Objekt `app`)
code/db.py                         SQLite-Schema und Passwort-Hashing
code/ics.py                        iCalendar lesen/schreiben (Import, Export, Kalender-Abo)
code/mail.py                       Mailversand über die Brevo-API
code/texts.py                      Texte für Server-Seite (Fehler, Mails, Kalender-Abo) aus static/texts.json
code/loesche_events_stammdaten.py  Skript: alle Events, Veranstalter und Strecken löschen
code/VERSION                       Version (Fußzeile)
code/requirements.txt              gepinnte Abhängigkeiten
code/static/                       Frontend (Vanilla HTML/CSS/JS, kein Build)
run.py                             Start selbst gehostet (Port 8005)
user.py                            Benutzerverwaltung auf der Kommandozeile
deploy/                            systemd-Unit und Caddy-Snippet für selbst gehostet
.env.example                       Konfiguration
```

Zweisprachig (Deutsch/Englisch): alle Texte stehen in `code/static/texts.json`, im HTML und JS nur Schlüssel
(`data-i18n`, `i18n.t()`), auch Fehlermeldungen des Servers. Sprache aus dem Cookie `ir_lang` (Umschalter DE | EN oben rechts),
sonst aus der Browser-Sprache. Das Kalender-Abo ist auf Englisch, wenn der Link `lang=en` enthält.
Daten aus der Datenbank (Event-Namen, Notizen, Protokoll) werden nicht übersetzt.

Daten liegen in `$APP_DATA/kalender.db`. Ohne `APP_DATA` (selbst gehostet) ist das `data/kalender.db`.

## Konfiguration (`.env`)

| Variable | Bedeutung |
|---|---|
| `KAL_YEAR` | Kalenderjahr (Standard 2027) |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Erster Admin; wird angelegt, falls es diesen Benutzer noch nicht gibt |
| `PUBLIC_URL` | Basis für Links in Mails und im Kalender-Abo, z. B. `https://racingkalender.de` |
| `BREVO_API_KEY`, `MAIL_FROM`, `MAIL_FROM_NAME` | Mailversand (Registrierung, Passwort vergessen). Ohne Key sind beide Funktionen ausgeblendet |
| `ADMIN_EMAIL` | Empfänger der Info bei Neuanmeldung (mehrere mit Komma) |
| `REGISTRATION_OPEN` | `0` schaltet die Selbst-Registrierung ab |
| `INSTANTRUN_SITE` | Link „hosted on instant-run“ in der Fußzeile |

## Rollen

| Rolle | Darf |
|---|---|
| **Besucher** (ohne Konto) | öffentliche Termine sehen |
| **Benutzer** | Status setzen, Gruppen gründen/beitreten, **private Termine** anlegen – nur für ihn selbst sichtbar, auch nicht für Admins |
| **Eventmanager** | zusätzlich öffentliche Termine *seiner* Veranstalter anlegen, ändern, löschen und deren Angaben (Website, E-Mail, Telefon, Notiz) pflegen. Zuordnung durch den Admin |
| **Admin** | alles: öffentliche und Gruppen-Termine, Stammdaten, Benutzer, ICS-Import/-Export, Erklär-Videos |

## instant-run

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

### Alle Events und Stammdaten löschen

```bash
python code/loesche_events_stammdaten.py          # fragt nach, Bestätigung mit LÖSCHEN
python code/loesche_events_stammdaten.py --ja     # ohne Rückfrage
```

Löscht alle Events (inkl. Markierungen und Gruppen-Teilnahmen), Veranstalter, Rennstrecken und Eventmanager-Zuordnungen.
Benutzer, Gruppen und Protokoll bleiben. Vorher wird `data/kalender-vor-loeschung-<Zeit>.db` als Sicherung angelegt.

## Bedienung

- **Jahresansicht:** Monate als Zeilen, Spalten nach Wochentag ausgerichtet. Feiertage Baden-Württemberg markiert.
- **Wochenansicht:** Klick auf einen Tag oder „KW“. ←/→ blättern, Esc zurück.
- **Event anklicken:** Status setzen, Veranstalter und Rennstrecke als Link mit Detailfenster, Teilnehmer aus den eigenen Gruppen.
- **Neuer Termin:** in der Jahresansicht über Tage ziehen oder in der Wochenansicht einen Tag anklicken (Handy: „+“).
- **Kategorien** Öffentlich / je Gruppe / Privat: Legende oben blendet ein und aus. Filter nach Veranstalter, Strecke und Gruppe.
- **Gruppen:** gründen, per Einladungslink beitreten, Owner verwalten Mitglieder und legen fest, ob die Gruppe an einem Event teilnimmt.
- **Kalender-Abo:** geheimer ICS-Link für eigene Termine, alle Termine oder je Gruppe.
- **Meine Veranstalter** (Eventmanager): im Benutzermenü bzw. Handy-Menü.
- Änderungen anderer erscheinen automatisch nach spätestens 10 Sekunden.

## Admin-Seite

`/admin` (nur für Admins): Benutzer (inkl. Rolle Eventmanager), Veranstalter, Rennstrecken, ICS-Import/-Export,
Erklär-Videos und Aktivitätsprotokoll (live, Einträge älter als 180 Tage werden beim Start gelöscht).

## Smartphone

Handys bekommen unter `/` automatisch eine eigene Oberfläche (Erkennung per User-Agent, Tablets erhalten die Desktop-Version).
Umschalten (wird per Cookie gemerkt): `/?ansicht=mobil`, `/?ansicht=desktop`, `/?ansicht=auto`.
