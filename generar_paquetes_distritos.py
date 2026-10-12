"""
Genera un paquete por distrito (1,891) desde el parquet nacional de SUNARP.

- Un archivo GeoJSON recortado por distrito (columnas utiles, sin recortar la
  geometria de los predios: se conserva completa la que intersecta el distrito).
- Un index.json con ubigeo, nombres, conteo y archivo (para el buscador web).
- Regla fija: orden area DESC (grandes primero -> QGIS los dibuja debajo).

Uso:
    python generar_paquetes_distritos.py --demo          # solo los 3 de demo
    python generar_paquetes_distritos.py --todos         # los 1,891
    python generar_paquetes_distritos.py --ubigeo 040706
"""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import duckdb
import geopandas as gpd
import pandas as pd

BASE = Path(__file__).resolve().parent            # carpeta del repo del producto
PARQUET = Path("/data/users/julio/Notes/01-Projects/sunarp_request/assets/parquets/"
               "predios_nacional.parquet")
DISTRITOS_SHP = Path("/data/users/julio/Notes/01-Projects/GIS/assets/vector/limites/"
                     "distrital/DISTRITOS.shp")
SALIDA = BASE / "data" / "distritos"

DEMO = ["040706", "040702", "150101"]   # Punta de Bombon, Cocachacra, Lima (Cercado)

COLUMNAS = ["PART_REG", "COD_OFRE", "TIP_PRED", "GEO_AREA", "FEC_TIT_F",
            "ASIENTO_REG", "NUM_TIT", "DIR_REG", "MANZANA", "LOTE", "capa", "OID"]

MAX_WORKERS = 8
FORMATO = "geojson"


def geometria_del_distrito(distritos, ubigeo):
    fila = distritos[distritos["UBIGEO"] == ubigeo]
    if fila.empty:
        return None
    return fila


def exportar_distrito(ubigeo, distritos, parquet):
    fila = geometria_del_distrito(distritos, ubigeo)
    if fila is None:
        return None
    r = fila.iloc[0]
    geom = fila.geometry.union_all()

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    cols = ", ".join(f'"{c}"' for c in COLUMNAS)
    df = con.execute(f"""
        SELECT {cols}, ST_AsGeoJSON(geometry) AS gj
        FROM read_parquet('{parquet.as_posix()}')
        WHERE ST_Intersects(geometry, ST_GeomFromText('{geom.wkt}'))
    """).fetchdf()
    con.close()
    if df.empty:
        return {"ubigeo": ubigeo, "n": 0}

    gdf = gpd.GeoDataFrame(
        df.drop(columns=["gj"]),
        geometry=gpd.GeoSeries.from_wkt(df["gj"].apply(_gj_a_wkt), crs=4326),
        crs=4326,
    )
    areas = gdf.geometry.area
    gdf = gdf.loc[areas.sort_values(ascending=False).index].reset_index(drop=True)
    gdf["GEO_AREA"] = gdf["GEO_AREA"].astype("float64").round(2)

    SALIDA.mkdir(parents=True, exist_ok=True)
    destino = SALIDA / f"{ubigeo}.geojson"
    if FORMATO in ("geojson", "both"):
        gdf.to_file(destino, driver="GeoJSON", encoding="utf-8")
    if FORMATO in ("fgb", "both"):
        gdf.to_file(destino.with_suffix(".fgb"), driver="FlatGeobuf", encoding="utf-8")

    return {
        "ubigeo": ubigeo,
        "distrito": r["DISTRITO"],
        "provincia": r["PROVINCIA"],
        "departamento": r["DEPARTAMEN"],
        "n_predios": int(len(gdf)),
        "area_total_m2": round(float(gdf["GEO_AREA"].sum()), 2),
        "archivo": (f"data/distritos/{ubigeo}.fgb" if FORMATO == "fgb"
                    else f"data/distritos/{ubigeo}.geojson"),
        "bytes": destino.with_suffix(".fgb" if FORMATO == "fgb" else ".geojson").stat().st_size,
        "demo": ubigeo in DEMO,
    }


def _gj_a_wkt(gj):
    from shapely.geometry import shape
    return shape(json.loads(gj)).wkt


def main():
    global FORMATO, SALIDA
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--todos", action="store_true")
    ap.add_argument("--ubigeo", nargs="*")
    ap.add_argument("--parquet", default=str(PARQUET))
    ap.add_argument("--formato", default="geojson", choices=["geojson", "fgb", "both"])
    ap.add_argument("--salida", default=None)
    args = ap.parse_args()
    FORMATO = args.formato
    if args.salida:
        SALIDA = Path(args.salida)

    parquet = Path(args.parquet)
    distritos = gpd.read_file(DISTRITOS_SHP).to_crs(4326)
    print(f"Distritos INEI: {len(distritos)} | parquet: {parquet.name}")

    if args.ubigeo:
        objetivos = args.ubigeo
    elif args.demo:
        objetivos = DEMO
    elif args.todos:
        objetivos = distritos["UBIGEO"].tolist()
    else:
        print("Usa --demo, --todos o --ubigeo <id>")
        return 1

    print(f"A procesar: {len(objetivos)} distritos")
    filas = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(exportar_distrito, u, distritos, parquet): u for u in objetivos}
        for i, f in enumerate(as_completed(futs), 1):
            res = f.result()
            if res:
                filas.append(res)
                print(f"[{i}/{len(objetivos)}] {res['ubigeo']} "
                      f"{res.get('distrito','?')}: {res.get('n_predios','?')} predios", flush=True)

    indice = sorted([f for f in filas if f.get("n_predios") is not None],
                    key=lambda x: (x["departamento"], x["provincia"], x["distrito"]))
    (SALIDA / "index.json").write_text(
        json.dumps(indice, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nÍndice: {len(indice)} distritos -> {SALIDA/'index.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
