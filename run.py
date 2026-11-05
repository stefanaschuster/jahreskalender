#!/usr/bin/env python3
"""Start:  python3 run.py
Datenbank: ./data/kalender.db (wird beim ersten Start angelegt)."""
import os
import sys
from pathlib import Path

HOST = "127.0.0.1"   # "0.0.0.0" für Zugriff aus dem Netz ohne Caddy
PORT = 8005
YEAR = 2027

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)
os.environ.setdefault("KAL_YEAR", str(YEAR))

import uvicorn  # noqa: E402

if __name__ == "__main__":
    print(f"Jahreskalender {YEAR} auf http://{HOST}:{PORT}")
    uvicorn.run("app.main:app", host=HOST, port=PORT, proxy_headers=True,
                forwarded_allow_ips="127.0.0.1", server_header=False,
                ws="none")  # keine Websockets nötig; vermeidet Konflikt mit altem System-Paket "websockets"
