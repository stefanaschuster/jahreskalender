"""Texte für Server-Seite (Fehlermeldungen, Mails, Kalender-Abo, ICS-Import) aus static/texts.json.
Dieselbe Datei nutzt der Browser (i18n.js). Sprache: Cookie ir_lang, sonst Accept-Language, sonst Englisch."""
import json
import re
from pathlib import Path

LANGS = ("de", "en")
TEXTS: dict = json.loads((Path(__file__).resolve().parent / "static" / "texts.json").read_text("utf-8"))


def lang_of(request) -> str:
    c = request.cookies.get("ir_lang")
    if c in LANGS:
        return c
    for part in request.headers.get("accept-language", "").split(","):
        m = re.match(r"\s*([a-zA-Z]{2})", part)
        if m and m.group(1).lower() in LANGS:
            return m.group(1).lower()
    return "en"


def T(lang: str, key: str, **values) -> str:
    text = TEXTS.get(lang, {}).get(key)
    if text is None:
        text = TEXTS["de"].get(key, key)
    return re.sub(r"\{(\w+)\}", lambda m: str(values[m[1]]) if m[1] in values else m[0], text)
