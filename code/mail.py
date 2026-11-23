"""Mailversand über die Brevo-API (HTTPS, kein SMTP). Konfiguration aus .env:
BREVO_API_KEY, MAIL_FROM (bei Brevo verifizierter Absender), MAIL_FROM_NAME.
Texte der Mails kommen aus static/texts.json (Schlüssel mail.*), in der Sprache des Empfängers."""
import html
import json
import os
import urllib.error
import urllib.request

from texts import T

API_URL = "https://api.brevo.com/v3/smtp/email"


class MailError(Exception):
    pass


def configured() -> bool:
    return bool(os.environ.get("BREVO_API_KEY", "").strip() and os.environ.get("MAIL_FROM", "").strip())


def _html(text: str, link: str = "", link_label: str = "", lang: str = "de") -> str:
    paras = "".join(f"<p>{html.escape(p).replace(chr(10), '<br>')}</p>" for p in text.split("\n\n") if p.strip())
    button = (f'<p><a href="{html.escape(link)}" style="display:inline-block;padding:10px 18px;background:#2f62d0;'
              f'color:#fff;border-radius:6px;text-decoration:none">{html.escape(link_label)}</a></p>'
              f'<p style="color:#666;font-size:12px">{html.escape(T(lang, "mail.fallback", link=link))}</p>') if link else ""
    return (f'<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px">'
            f"{paras}{button}</div>")


def send(to: str, subject: str, text: str, link: str = "", link_label: str = "", lang: str = "de") -> None:
    """Schickt eine Mail; wirft MailError, wenn Brevo nicht erreichbar ist oder ablehnt."""
    if not configured():
        raise MailError("Mailversand ist nicht eingerichtet (BREVO_API_KEY / MAIL_FROM fehlen)")
    body = {
        "sender": {"email": os.environ["MAIL_FROM"].strip(),
                   "name": os.environ.get("MAIL_FROM_NAME", "").strip() or "racingkalender.de"},
        "to": [{"email": to}],
        "subject": subject,
        "textContent": text + (f"\n\n{link}" if link else ""),
        "htmlContent": _html(text, link, link_label, lang),
    }
    req = urllib.request.Request(API_URL, data=json.dumps(body).encode(), method="POST", headers={
        "api-key": os.environ["BREVO_API_KEY"].strip(), "content-type": "application/json", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            if r.status >= 300:
                raise MailError(f"Brevo antwortet {r.status}")
    except urllib.error.HTTPError as ex:
        detail = ex.read(300).decode("utf-8", "replace")
        raise MailError(f"Brevo lehnt ab (HTTP {ex.code}): {detail}") from None
    except urllib.error.URLError as ex:
        raise MailError(f"Brevo nicht erreichbar ({ex.reason}) – Internetzugang der App freigeschaltet?") from None
