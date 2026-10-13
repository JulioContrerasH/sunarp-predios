"""API SUNARP Predios - FastAPI + DuckDB.

Esqueleto de backend para consultar el consolidado nacional de predios
mediante geometrías de distritos (INEI 2023) o polígonos GeoJSON.
"""

import datetime
import hashlib
import json
import os
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

import duckdb
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

DEFAULT_PARQUET = "/data/users/julio/Notes/01-Projects/sunarp_request/assets/parquets/predios_nacional.parquet"
DEFAULT_DISTRITOS_SHP = "/data/users/julio/Notes/01-Projects/GIS/assets/vector/limites/distrital/DISTRITOS.shp"
DEFAULT_INDEX_JSON = "/data/users/julio/apps/sunarp-predios/data/privado/index.json"
DEFAULT_CLAVES = os.path.join(os.path.dirname(__file__), "claves.json")
DEFAULT_CACHE_TTL = 300

PARQUET = os.getenv("PARQUET", DEFAULT_PARQUET)
DISTRITOS_SHP = os.getenv("DISTRITOS_SHP", DEFAULT_DISTRITOS_SHP)
INDEX_JSON = os.getenv("INDEX_JSON", DEFAULT_INDEX_JSON)
CLAVES_PATH = os.getenv("CLAVES", DEFAULT_CLAVES)
CACHE_TTL = int(os.getenv("CACHE_TTL", DEFAULT_CACHE_TTL))

db: duckdb.DuckDBPyConnection | None = None
claves: dict[str, Any] = {}
claves_lock = threading.Lock()

_cache: dict[str, tuple[float, bytes, str, dict[str, str]]] = {}
_cache_lock = threading.Lock()


def _sin_tildes(texto: str) -> str:
    """Normaliza una cadena para búsquedas sin tildes."""
    return (
        texto.lower()
        .replace("á", "a")
        .replace("é", "e")
        .replace("í", "i")
        .replace("ó", "o")
        .replace("ú", "u")
        .replace("ü", "u")
        .replace("ñ", "n")
    )


def _guardar_claves() -> None:
    """Persiste el estado de claves en disco."""
    with open(CLAVES_PATH, "w", encoding="utf-8") as f:
        json.dump(claves, f, indent=2, ensure_ascii=False)


def crear_clave(nombre: str = "Nuevo usuario", plan: str = "demo", cuota_diaria: int = 200) -> str:
    """Crea una nueva API key y la guarda en claves.json.

    Args:
        nombre: Nombre descriptivo del titular.
        plan: Plan asignado.
        cuota_diaria: Máximo de requests por día.

    Returns:
        La clave generada.
    """
    import uuid

    key = f"snp-{uuid.uuid4().hex[:16]}"
    hoy = datetime.date.today().isoformat()
    with claves_lock:
        claves[key] = {
            "nombre": nombre,
            "plan": plan,
            "cuota_diaria": cuota_diaria,
            "usada_hoy": 0,
            "fecha": hoy,
        }
        _guardar_claves()
    return key


def _limite_efectivo(request: Request, limite: int | None) -> int:
    """Aplica el tope de filas del plan de la clave."""
    tope = _limite_plan(getattr(request.state, "api_key", ""))
    return tope if limite is None else min(limite, tope)


def _limite_plan(api_key: str) -> int:
    """Tope de filas por respuesta segun el plan de la clave."""
    plan = (claves.get(api_key) or {}).get("plan", "demo")
    return {"demo": 2000, "test": 100000}.get(plan, 50000)


def _verificar_cuota(api_key: str) -> int | None:
    """Incrementa el uso de la clave y devuelve la cuota restante.

    Returns:
        Cuota restante si la clave es válida, None si no existe,
        -1 si la cuota diaria está agotada.
    """
    with claves_lock:
        hoy = datetime.date.today().isoformat()
        info = claves.get(api_key)
        if info is None:
            return None
        if info.get("fecha") != hoy:
            info["usada_hoy"] = 0
            info["fecha"] = hoy
        if info["usada_hoy"] >= info.get("cuota_diaria", 200):
            return -1
        info["usada_hoy"] += 1
        _guardar_claves()
        return info.get("cuota_diaria", 200) - info["usada_hoy"]


def _cache_key(poligono_wkt: str, formato: str, limite: int | None) -> str:
    return hashlib.sha256(f"{poligono_wkt}:{formato}:{limite}".encode()).hexdigest()


def _get_cache(key: str) -> tuple[bytes, str, dict[str, str]] | None:
    with _cache_lock:
        ahora = time.time()
        for k in list(_cache.keys()):
            if ahora - _cache[k][0] > CACHE_TTL:
                del _cache[k]
        if key in _cache:
            return _cache[key][1:]
    return None


def _set_cache(key: str, content: bytes, media_type: str, headers: dict[str, str]) -> None:
    with _cache_lock:
        _cache[key] = (time.time(), content, media_type, headers)


def _extraer_geometria_geojson(data: dict[str, Any]) -> dict[str, Any]:
    """Extrae una geometría de un objeto GeoJSON."""
    tipo = data.get("type")
    if tipo == "FeatureCollection":
        features = data.get("features", [])
        if not features:
            raise ValueError("FeatureCollection vacía")
        anillos: list = []
        for f in features:
            g = f.get("geometry") or {}
            if g.get("type") == "Polygon":
                anillos.append(g.get("coordinates"))
            elif g.get("type") == "MultiPolygon":
                anillos.extend(g.get("coordinates") or [])
        if not anillos:
            raise ValueError("La colección no tiene polígonos")
        if len(anillos) == 1:
            return {"type": "Polygon", "coordinates": anillos[0]}
        return {"type": "MultiPolygon", "coordinates": anillos}
    if tipo == "Feature":
        geom = data.get("geometry")
        if not geom:
            raise ValueError("Feature sin geometría")
        return geom
    if tipo in ("Polygon", "MultiPolygon"):
        return data
    raise ValueError(f"Tipo GeoJSON no soportado: {tipo}")


def _aplicar_buffer(wkt_4326: str, buffer_m: float) -> str:
    """Aplica un buffer en metros reproyectando a Web Mercator.

    Nota: Web Mercator es una aproximación; para zonas de alta latitud
    o buffers grandes conviene validar el resultado.
    """
    sql = (
        "SELECT ST_AsText(ST_Transform("
        "ST_Buffer(ST_Transform(ST_GeomFromText(?), 'EPSG:4326', 'EPSG:3857'), ?),"
        "'EPSG:3857', 'EPSG:4326'))"
    )
    return db.execute(sql, [wkt_4326, buffer_m]).fetchone()[0]


def _resultados_a_geojson(rows: list[tuple], column_names: list[str]) -> dict[str, Any]:
    features = []
    for row in rows:
        props = {}
        geom = None
        for name, val in zip(column_names, row):
            if name == "geometry":
                geom = json.loads(val)
            else:
                props[name] = val
        features.append({"type": "Feature", "properties": props, "geometry": geom})
    return {"type": "FeatureCollection", "features": features, "total": len(features)}


def _consultar_predios(poligono_wkt: str, formato: str, limite: int | None):
    """Ejecuta la consulta espacial y devuelve la respuesta en el formato pedido."""
    key = _cache_key(poligono_wkt, formato, limite)
    cached = _get_cache(key)
    if cached:
        return cached

    db.execute(
        "CREATE OR REPLACE TEMPORARY TABLE _poly AS SELECT ST_GeomFromText(?) AS geom",
        [poligono_wkt],
    )

    limit_sql = "" if limite is None else f"LIMIT {int(limite)}"
    cols = "PART_REG, COD_OFRE, TIP_PRED, GEO_AREA, FEC_TIT_F, ASIENTO_REG, NUM_TIT, DIR_REG, MANZANA, LOTE, capa, OID, UBIGEO"

    if formato == "geojson":
        sql = (
            f"SELECT {cols}, ST_AsGeoJSON(geometry) AS geometry "
            "FROM predios, _poly "
            "WHERE ST_Intersects(predios.geometry, _poly.geom) "
            f"ORDER BY ST_Area(predios.geometry) DESC {limit_sql}"
        )
        rows = db.execute(sql).fetchall()
        column_names = [desc[0] for desc in db.description]
        data = _resultados_a_geojson(rows, column_names)
        content = json.dumps(data, ensure_ascii=False).encode("utf-8")
        media_type = "application/json"
        headers = {"X-Total-Features": str(len(data["features"]))}

    elif formato == "geoparquet":
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            sql = (
                f"COPY (SELECT {cols}, geometry FROM predios, _poly "
                "WHERE ST_Intersects(predios.geometry, _poly.geom) "
                f"ORDER BY ST_Area(predios.geometry) DESC {limit_sql}) "
                f"TO '{tmp_path}' (FORMAT PARQUET)"
            )
            db.execute(sql)
            with open(tmp_path, "rb") as f:
                content = f.read()
            media_type = "application/octet-stream"
            headers = {"Content-Disposition": "attachment; filename=predios.parquet"}
        finally:
            os.unlink(tmp_path)

    elif formato == "csv":
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w", encoding="utf-8") as tmp:
            tmp_path = tmp.name
        try:
            sql = (
                f"COPY (SELECT {cols} FROM predios, _poly "
                "WHERE ST_Intersects(predios.geometry, _poly.geom) "
                f"ORDER BY ST_Area(predios.geometry) DESC {limit_sql}) "
                f"TO '{tmp_path}' (HEADER, DELIMITER ',')"
            )
            db.execute(sql)
            with open(tmp_path, "r", encoding="utf-8") as f:
                content = f.read().encode("utf-8")
            media_type = "text/csv; charset=utf-8"
            headers = {"Content-Disposition": "attachment; filename=predios.csv"}
        finally:
            os.unlink(tmp_path)

    else:
        raise HTTPException(status_code=400, detail=f"formato no soportado: {formato}")

    _set_cache(key, content, media_type, headers)
    return content, media_type, headers


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Carga datos e índices al arrancar."""
    global db, claves

    db = duckdb.connect()
    db.execute("LOAD spatial;")

    # Tabla de predios con las columnas útiles y un índice espacial RTREE.
    db.execute(
        f"""
        CREATE TABLE predios AS
        SELECT
            PART_REG, COD_OFRE, TIP_PRED, GEO_AREA, FEC_TIT_F,
            ASIENTO_REG, NUM_TIT, DIR_REG, MANZANA, LOTE,
            capa, OID, UBIGEO, geometry
        FROM '{PARQUET}'
        """
    )
    db.execute("CREATE INDEX idx_geom ON predios USING RTREE(geometry)")

    # Polígonos distritales del INEI.
    db.execute(
        f"""
        CREATE TABLE distritos AS
        SELECT UBIGEO, DISTRITO, PROVINCIA, DEPARTAMEN AS DEPARTAMENTO, geom
        FROM ST_Read('{DISTRITOS_SHP}')
        """
    )
    db.execute("CREATE INDEX idx_ubigeo ON distritos(UBIGEO)")

    with open(CLAVES_PATH, "r", encoding="utf-8") as f:
        claves = json.load(f)

    yield

    db.close()


app = FastAPI(
    title="API SUNARP Predios",
    description="Consulta espacial del consolidado nacional de predios.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://juliocontrerash.github.io",
        "http://localhost:8801",
        "http://127.0.0.1:8801",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["X-API-Key", "Content-Type"],
    expose_headers=["X-Cuota-Restante"],
)


RUTAS_LIBRES = {"/", "/docs", "/redoc", "/openapi.json", "/favicon.ico"}


@app.middleware("http")
async def api_key_middleware(request: Request, call_next):
    """Exige X-API-Key y controla la cuota diaria (salvo la portada y los docs)."""
    if request.method == "OPTIONS":
        # el preflight CORS lo responde CORSMiddleware, no debe pedir clave
        return await call_next(request)
    if request.url.path in RUTAS_LIBRES:
        return await call_next(request)
    key = request.headers.get("X-API-Key")
    if not key:
        return JSONResponse({"error": "API key requerida"}, status_code=401)

    restante = _verificar_cuota(key)
    if restante is None:
        return JSONResponse({"error": "API key inválida"}, status_code=401)
    if restante < 0:
        return JSONResponse(
            {"error": "cuota diaria agotada"},
            status_code=429,
            headers={"X-Cuota-Restante": "0"},
        )

    request.state.api_key = key
    response = await call_next(request)
    response.headers["X-Cuota-Restante"] = str(restante)
    return response


@app.get("/", include_in_schema=False)
async def portada():
    """Portada mínima para abrir en el navegador."""
    filas = db.execute("SELECT COUNT(*) FROM predios").fetchone()[0]
    html = f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>API de predios SUNARP</title>
<style>body{{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1e293b}}
code{{background:#f1f5f9;padding:2px 6px;border-radius:4px}}
a{{color:#2563eb}}</style></head><body>
<h1>API de predios SUNARP</h1>
<p>Estado: <strong>operativa</strong> · {filas:,} predios cargados.</p>
<p>Endpoints: <code>GET /salud</code>, <code>GET /distritos</code>,
<code>GET /predios?ubigeo=150101</code>, <code>POST /predios</code> (polígono GeoJSON).</p>
<p>Requieren el header <code>X-API-Key</code>.
Prueba interactiva: <a href="/docs">/docs</a> (botón <em>Authorize</em> para pegar la clave).</p>
<p style="color:#64748b;font-size:14px">La información es referencial y no constituye
publicidad registral; no tiene valor para trámites administrativos ni judiciales.
Fuente: servicio público Visor BGR de SUNARP.</p>
</body></html>"""
    return Response(content=html, media_type="text/html")


@app.get("/salud")
async def salud():
    """Estado de la API y conteo de filas del parquet."""
    filas = db.execute("SELECT COUNT(*) FROM predios").fetchone()[0]
    mtime = os.path.getmtime(PARQUET)
    fecha = datetime.datetime.fromtimestamp(mtime).isoformat()
    return {
        "ok": True,
        "version_datos": fecha,
        "filas": filas,
        "fecha_parquet": fecha,
    }


@app.get("/distritos")
async def distritos(q: str = Query("", description="Búsqueda sin tildes")):
    """Devuelve el índice de distritos, opcionalmente filtrado."""
    with open(INDEX_JSON, "r", encoding="utf-8") as f:
        index = json.load(f)

    # no exponer rutas de archivos internos
    index = [{k: v for k, v in item.items() if k not in ("archivo", "bytes")}
             for item in index]

    if not q:
        return index

    q_norm = _sin_tildes(q)
    filtrados = []
    for item in index:
        texto = " ".join(
            [item.get("distrito", ""), item.get("provincia", ""), item.get("departamento", "")]
        )
        if q_norm in _sin_tildes(texto):
            filtrados.append(item)
    return filtrados


@app.get("/predios")
async def predios_ubigeo(
    request: Request,
    ubigeo: str,
    formato: str = Query("geojson", enum=["geojson", "geoparquet", "csv"]),
    limite: int | None = Query(None, ge=1),
    buffer_m: float | None = Query(None, description="Buffer en metros (aproximado vía Web Mercator)"),
):
    """Predios contenidos en el polígono de un distrito."""
    row = db.execute(
        "SELECT ST_AsText(geom) FROM distritos WHERE UBIGEO = ?", [ubigeo]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"ubigeo no encontrado: {ubigeo}")

    wkt = row[0]
    if buffer_m is not None and buffer_m > 0:
        wkt = _aplicar_buffer(wkt, buffer_m)

    content, media_type, headers = _consultar_predios(wkt, formato, _limite_efectivo(request, limite))
    return Response(content=content, media_type=media_type, headers=headers)


@app.get("/predios_bbox")
async def predios_bbox(
    request: Request,
    minx: float, miny: float, maxx: float, maxy: float,
    formato: str = Query("geojson", enum=["geojson", "csv"]),
    limite: int | None = Query(None, ge=1),
):
    """Predios dentro de un rectangulo (para cargar mientras se navega el mapa)."""
    if not (minx < maxx and miny < maxy):
        raise HTTPException(status_code=400, detail="bbox invalido")
    if (maxx - minx) > 1.0 or (maxy - miny) > 1.0:
        raise HTTPException(status_code=400, detail="bbox demasiado grande (max 1 grado)")
    wkt = (f"POLYGON(({minx} {miny}, {maxx} {miny}, {maxx} {maxy}, "
           f"{minx} {maxy}, {minx} {miny}))")
    content, media_type, headers = _consultar_predios(wkt, formato, _limite_efectivo(request, limite))
    return Response(content=content, media_type=media_type, headers=headers)


@app.post("/predios")
async def predios_geojson(
    request: Request,
    body: dict[str, Any],
    formato: str = Query("geojson", enum=["geojson", "geoparquet", "csv"]),
    limite: int | None = Query(None, ge=1),
    buffer_m: float | None = Query(None, description="Buffer en metros (aproximado vía Web Mercator)"),
):
    """Predios que intersectan con un polígono GeoJSON."""
    try:
        geom = _extraer_geometria_geojson(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    wkt = db.execute(
        "SELECT ST_AsText(ST_GeomFromGeoJSON(?))", [json.dumps(geom)]
    ).fetchone()[0]

    if buffer_m is not None and buffer_m > 0:
        wkt = _aplicar_buffer(wkt, buffer_m)

    content, media_type, headers = _consultar_predios(wkt, formato, _limite_efectivo(request, limite))
    return Response(content=content, media_type=media_type, headers=headers)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
