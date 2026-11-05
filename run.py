#!/usr/bin/env python3
"""Selbst gehostet starten:  python3 run.py
Datenbank: ./data/kalender.db (wird beim ersten Start angelegt).
Auf nativeai startet die Umgebung code/app.py selbst; run.py wird dort nicht gebraucht."""
import os
import sys
from pathlib import Path

HOST = "127.0.0.1"   # "0.0.0.0" für Zugriff aus dem Netz ohne Caddy
PORT = 8005
YEAR = 2027

ROOT = Path(__file__).resolve().parent
CODE = ROOT / "code"
os.environ.setdefault("APP_DATA", str(ROOT / "data"))
os.environ.setdefault("KAL_YEAR", str(YEAR))
sys.path.insert(0, str(CODE))

import uvicorn  # noqa: E402

if __name__ == "__main__":
    print(f"Jahreskalender {YEAR} auf http://{HOST}:{PORT}")
    uvicorn.run("app:app", app_dir=str(CODE), host=HOST, port=PORT, proxy_headers=True,
                forwarded_allow_ips="127.0.0.1", server_header=False,
                ws="none")  # keine Websockets nötig; vermeidet Konflikt mit altem System-Paket "websockets"
