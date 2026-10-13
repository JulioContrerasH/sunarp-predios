"""
Genera el PMTiles nacional de predios para servir estatico desde R2.

1. Exporta el parquet a FlatGeobuf (en trozos de 1 millon, se concatenan al vuelo).
2. Genera el PMTiles con GDAL (MVT), zooms 12-15, simplificacion por zoom.
3. Deja el archivo listo en /data/users/julio/apps/sunarp-predios/data/privado/.

Requiere PROJ_DATA apuntando al share/proj del env (si no, GDAL no transforma).
"""

import os
import time
from pathlib import Path

os.environ.setdefault("PROJ_DATA", "/data/users/julio/.conda/envs/deep/share/proj")

import duckdb  # noqa: E402
import geopandas as gpd  # noqa: E402
import pandas as pd  # noqa: E402
from osgeo import gdal  # noqa: E402
from shapely import wkb  # noqa: E402

PARQUET = Path("/data/users/julio/Notes/01-Projects/sunarp_request/assets/parquets/"
               "predios_nacional.parquet")
SALIDA = Path("/data/users/julio/apps/sunarp-predios/data/privado/predios.pmtiles")
TMP_FGB = Path("/tmp/opencode/predios_nacional.fgb")
LOG = Path("/tmp/opencode/pmtiles.log")
TROZO = 1_000_000


def log(msg):
    linea = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(linea, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(linea + "\n")


def exportar_fgb():
    if TMP_FGB.exists():
        log(f"FGB ya existe ({TMP_FGB.stat().st_size/1e9:.2f} GB), se reutiliza")
        return
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    total = con.execute(f"SELECT count(*) FROM read_parquet('{PARQUET.as_posix()}')").fetchone()[0]
    log(f"Predios: {total:,} | exportando a FlatGeobuf...")

    primero = True
    for i in range(0, total, TROZO):
        t0 = time.time()
        df = con.execute(
            f"""SELECT PART_REG, TIP_PRED, GEO_AREA, ST_AsWKB(geometry) AS wkb
                FROM read_parquet('{PARQUET.as_posix()}') LIMIT {TROZO} OFFSET {i}"""
        ).fetchdf()
        df["geometry"] = [wkb.loads(bytes(b)) for b in df["wkb"]]
        g = gpd.GeoDataFrame(df.drop(columns=["wkb"]), geometry="geometry", crs=4326)
        if primero:
            g.to_file(TMP_FGB, driver="FlatGeobuf")
            primero = False
        else:
            # el driver FlatGeobuf no hace append: se acumula en una lista de FGBs
            parte = TMP_FGB.with_name(f"predios_parte_{i:08d}.fgb")
            g.to_file(parte, driver="FlatGeobuf")
            del parte
        log(f"  trozo {i//TROZO + 1}: {len(g):,} features ({time.time()-t0:.0f}s)")
        del df, g
    con.close()


def generar_pmtiles():
    partes = sorted(Path("/tmp/opencode").glob("predios_parte_*.fgb"))
    entradas = [str(TMP_FGB)] + [str(p) for p in partes]
    log(f"Generando PMTiles desde {len(entradas)} archivo(s) FGB...")
    t0 = time.time()
    gdal.VectorTranslate(
        str(SALIDA), entradas, format="PMTiles",
        options=("-s_srs EPSG:4326 -t_srs EPSG:3857 -dsco MINZOOM=11 -dsco MAXZOOM=15 "
                 "-dsco SIMPLIFICATION=2.0 -dsco MAX_FEATURES=25000"),
    )
    log(f"PMTiles listo: {SALIDA.stat().st_size/1e6:.1f} MB en {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    log("=== inicio ===")
    exportar_fgb()
    generar_pmtiles()
    log("=== fin ===")
