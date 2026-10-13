"""Pruebas de la API de predios.

Corre:  python -m pytest api/pruebas_api.py -v
Usa un archivo de claves temporal con cuota alta para no gastar la de desarrollo.
"""

import datetime
import json
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

CLAVE = "test-key-2026"
_tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
json.dump({
    CLAVE: {
        "nombre": "Pruebas",
        "plan": "test",
        "cuota_diaria": 100000,
        "usada_hoy": 0,
        "fecha": datetime.date.today().isoformat(),
    }
}, _tmp)
_tmp.close()
os.environ["CLAVES"] = _tmp.name

from fastapi.testclient import TestClient  # noqa: E402

from api import main  # noqa: E402

CAB = {"X-API-Key": CLAVE}


def test_salud():
    with TestClient(main.app) as c:
        r = c.get("/salud", headers=CAB)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["ok"] is True
        assert d["filas"] > 7_000_000
        assert "X-Cuota-Restante" in r.headers


def test_sin_clave():
    with TestClient(main.app) as c:
        assert c.get("/salud").status_code == 401
        assert c.get("/salud", headers={"X-API-Key": "no-existe"}).status_code == 401


def test_distritos():
    with TestClient(main.app) as c:
        r = c.get("/distritos", params={"q": "cocachacra"}, headers=CAB)
        assert r.status_code == 200
        items = r.json()
        assert any(x["ubigeo"] == "040702" for x in items), items[:3]
        # búsqueda con tilde (sin tildes en el índice)
        r2 = c.get("/distritos", params={"q": "Bombón"}, headers=CAB)
        assert any(x["ubigeo"] == "040706" for x in r2.json())


def test_predios_geojson_ubigeo():
    with TestClient(main.app) as c:
        r = c.get("/predios", params={"ubigeo": "040702", "formato": "geojson", "limite": 2}, headers=CAB)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["type"] == "FeatureCollection"
        assert len(d["features"]) == 2
        props = d["features"][0]["properties"]
        assert "PART_REG" in props and "GEO_AREA" in props
        assert "geometry" in d["features"][0]


def test_predios_csv_y_geoparquet():
    with TestClient(main.app) as c:
        r = c.get("/predios", params={"ubigeo": "040702", "formato": "csv", "limite": 3}, headers=CAB)
        assert r.status_code == 200
        assert "PART_REG" in r.text.splitlines()[0]
        assert len(r.text.strip().splitlines()) == 4  # cabecera + 3

        r2 = c.get("/predios", params={"ubigeo": "040702", "formato": "geoparquet", "limite": 5}, headers=CAB)
        assert r2.status_code == 200
        assert len(r2.content) > 500


def test_predios_post_poligono():
    poligono = {
        "type": "Polygon",
        "coordinates": [[[-71.75, -17.20], [-71.65, -17.20], [-71.65, -17.10],
                         [-71.75, -17.10], [-71.75, -17.20]]],
    }
    with TestClient(main.app) as c:
        r = c.post("/predios", params={"formato": "geojson"}, json=poligono, headers=CAB)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["type"] == "FeatureCollection"
        assert len(d["features"]) > 0


def test_ubigeo_inexistente():
    with TestClient(main.app) as c:
        assert c.get("/predios", params={"ubigeo": "999999"}, headers=CAB).status_code == 404
