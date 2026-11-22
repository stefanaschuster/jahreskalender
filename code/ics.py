"""iCalendar (RFC 5545) – kleiner Leser und Schreiber für ganztägige Events, nur Standardbibliothek."""
import datetime as dt
import re

PRODID = "-//racingkalender.de//DE"


# ---------- Schreiben ----------

def _esc(s: str) -> str:
    return (s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
             .replace("\r\n", "\\n").replace("\n", "\\n"))


def _fold(line: str) -> str:
    """Zeilen auf 75 Oktette falten (Fortsetzung beginnt mit Leerzeichen)."""
    out, cur = [], b""
    for ch in line:
        b = ch.encode()
        if len(cur) + len(b) > (75 if not out else 74):
            out.append(cur.decode())
            cur = b""
        cur += b
    out.append(cur.decode())
    return "\r\n ".join(out)


def build(events: list[dict], cal_name: str, refresh_minutes: int = 0) -> str:
    """events: dict mit uid, title, start_date, end_date (inkl.), note, location, organizer, track,
    optional status (TENTATIVE/CONFIRMED) und url. refresh_minutes > 0: Abo-Kalender (Aktualisierungsintervall)."""
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", f"PRODID:{PRODID}", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", f"X-WR-CALNAME:{_esc(cal_name)}"]
    if refresh_minutes:
        lines += [f"REFRESH-INTERVAL;VALUE=DURATION:PT{refresh_minutes}M", f"X-PUBLISHED-TTL:PT{refresh_minutes}M"]
    for e in events:
        end_excl = dt.date.fromisoformat(e["end_date"]) + dt.timedelta(days=1)   # DTEND ist exklusiv
        lines += ["BEGIN:VEVENT", f"UID:{_esc(e['uid'])}", f"DTSTAMP:{stamp}",
                  f"DTSTART;VALUE=DATE:{e['start_date'].replace('-', '')}",
                  f"DTEND;VALUE=DATE:{end_excl.strftime('%Y%m%d')}",
                  f"SUMMARY:{_esc(e['title'])}"]
        if e.get("note"):
            lines.append(f"DESCRIPTION:{_esc(e['note'])}")
        if e.get("location"):
            lines.append(f"LOCATION:{_esc(e['location'])}")
        if e.get("organizer"):
            lines.append(f"X-JAHRESPLANER-ORGANIZER:{_esc(e['organizer'])}")
        if e.get("track"):
            lines.append(f"X-JAHRESPLANER-TRACK:{_esc(e['track'])}")
        if e.get("status"):
            lines.append(f"STATUS:{e['status']}")
        if e.get("url"):
            lines.append(f"URL:{e['url']}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(l) for l in lines) + "\r\n"


# ---------- Lesen ----------

def _unesc(s: str) -> str:
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), s)


def _parse_line(line: str):
    """'NAME;P1=a;P2="b:c":wert' → (NAME, {P1: a, P2: b:c}, wert)."""
    i, quoted = 0, False
    while i < len(line):
        c = line[i]
        if c == '"':
            quoted = not quoted
        elif c == ":" and not quoted:
            break
        i += 1
    head, value = line[:i], line[i + 1:]
    parts = re.findall(r'(?:[^;"]|"[^"]*")+', head)
    name = parts[0].upper() if parts else ""
    params = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        params[k.upper()] = v.strip('"')
    return name, params, value


def _date(value: str) -> tuple[dt.date, bool]:
    """Liefert (Datum, ist_ganztägig). Uhrzeiten werden aufs Datum reduziert."""
    m = re.match(r"(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?", value.strip())
    if not m:
        raise ValueError(f"Datum unlesbar: {value[:30]}")
    d = dt.date(int(m[1]), int(m[2]), int(m[3]))
    if m[4] is None:
        return d, True
    midnight = m[4] == "00" and m[5] == "00" and m[6] == "00"
    return d, midnight


# Beschriftete Angaben im Freitext, z. B. „Veranstalter: RSC“ oder „Strecke: Hockenheimring“
_LABELS = {
    "organizer": r"veranstalter|veranstaltet von|organi[sz]ator|organi[sz]er|organisiert von|anbieter|ausrichter|host",
    "track": r"rennstrecke|strecke|track|circuit|ort|location|venue|austragungsort",
}
_LABEL_RX = re.compile(r"^\s*[-*•·]?\s*(" + "|".join(f"(?P<{k}>{v})" for k, v in _LABELS.items())
                       + r")\s*(?::|=|–|—|-(?=\s))\s*(?P<val>.+?)\s*$", re.I)


def _clean_val(kind: str, v: str) -> str:
    v = re.sub(r"\s*(?:https?://|www\.)\S+", "", v).strip(" .;|·-–")    # Links hinter dem Namen weg
    if kind == "track":
        v = v.split(",")[0].strip()                                      # „Hockenheimring, 68766 Hockenheim“
    return v[:100]


def extract_labels(text: str) -> tuple[dict, str]:
    """Sucht beschriftete Veranstalter-/Strecken-Angaben (Zeilen oder „ | “-Abschnitte).
    Liefert ({organizer, track}, Text ohne diese Angaben)."""
    found: dict = {}
    kept_lines = []
    for line in text.split("\n"):
        kept = []
        for seg in re.split(r"\s+[|·]\s+", line):
            m = _LABEL_RX.match(seg)
            kind = next((k for k in _LABELS if m and m.group(k)), None)
            if kind and (val := _clean_val(kind, m.group("val"))):
                found.setdefault(kind, val)
                continue
            kept.append(seg)
        if kept or not line.strip():
            kept_lines.append(" | ".join(kept))
    rest = re.sub(r"\n{3,}", "\n\n", "\n".join(kept_lines)).strip()
    return found, rest


def parse(text: str) -> list[dict]:
    """Gibt je VEVENT ein dict zurück: uid, title, start, end (inkl.), note, location, organizer, track, skip."""
    raw = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines: list[str] = []
    for l in raw:                                   # Zeilen entfalten
        if l[:1] in (" ", "\t") and lines:
            lines[-1] += l[1:]
        elif l:
            lines.append(l)
    events, cur, depth = [], None, 0
    for l in lines:
        name, params, value = _parse_line(l)
        if name == "BEGIN" and value.upper() == "VEVENT":
            cur, depth = {"props": {}, "params": {}}, 0
            continue
        if cur is None:
            continue
        if name == "BEGIN":                         # z. B. VALARM innerhalb des Events ignorieren
            depth += 1
            continue
        if name == "END" and value.upper() != "VEVENT":
            depth -= 1
            continue
        if name == "END":
            events.append(cur)
            cur = None
            continue
        if depth == 0 and name not in cur["props"]:
            cur["props"][name] = value
            cur["params"][name] = params

    out = []
    for e in events:
        p, pa = e["props"], e["params"]
        item = {"uid": _unesc(p.get("UID", "")).strip(), "title": _unesc(p.get("SUMMARY", "")).strip(),
                "note": _unesc(p.get("DESCRIPTION", "")).strip(), "location": _unesc(p.get("LOCATION", "")).strip(),
                "organizer": _unesc(p.get("X-JAHRESPLANER-ORGANIZER", "")).strip()
                or pa.get("ORGANIZER", {}).get("CN", "").strip(),
                "track": _unesc(p.get("X-JAHRESPLANER-TRACK", "")).strip(), "skip": ""}
        if not item["organizer"] and (org := p.get("ORGANIZER", "")):
            mail = re.sub(r"(?i)^mailto:", "", org).strip()
            if mail and "@" not in mail:
                item["organizer"] = mail
        # Angaben aus Beschreibung und Titel („Veranstalter: …“, „Strecke: …“) – aus der Notiz entfernen
        labels, item["note"] = extract_labels(item["note"])
        t_labels, title_rest = extract_labels(item["title"])
        if t_labels and title_rest:
            item["title"] = title_rest
        for k in ("organizer", "track"):
            if not item[k]:
                item[k] = labels.get(k) or t_labels.get(k, "")
        item["track_from_location"] = False
        if not item["track"] and item["location"]:
            item["track"] = item["location"].split(",")[0].strip()[:100]
            item["track_from_location"] = True
        try:
            if "RRULE" in p:
                raise ValueError("Serientermin (RRULE) wird nicht unterstützt")
            if p.get("STATUS", "").upper() == "CANCELLED":
                raise ValueError("abgesagt (STATUS:CANCELLED)")
            if "DTSTART" not in p:
                raise ValueError("kein Startdatum")
            start, _ = _date(p["DTSTART"])
            if "DTEND" in p:
                end, exclusive = _date(p["DTEND"])
                if exclusive and end > start:       # ganztägig/Mitternacht: Endtag ist exklusiv
                    end -= dt.timedelta(days=1)
            elif "DURATION" in p and (m := re.match(r"P(\d+)D", p["DURATION"])):
                end = start + dt.timedelta(days=max(int(m[1]) - 1, 0))
            else:
                end = start
            if end < start:
                end = start
            if not item["title"]:
                raise ValueError("ohne Titel")
            item.update(start=start, end=end)
        except ValueError as ex:
            item["skip"] = str(ex)
        out.append(item)
    return out
