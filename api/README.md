# API de predios SUNARP

Backend de la V2: consulta los predios del consolidado nacional por **distrito** (ubigeo)
o por **polígono propio** (GeoJSON), con API key y cuota diaria.

## Correr

```bash
/data/users/julio/.conda/envs/deep/bin/python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

Al arrancar carga el parquet en memoria (DuckDB + índice espacial RTREE): tarda ~1-2 min y
usa ~3-4 GB de RAM.

## Variables de entorno

| Variable | Default | Qué es |
|---|---|---|
| `PARQUET` | `.../sunarp_request/assets/parquets/predios_nacional.parquet` | consolidado nacional |
| `DISTRITOS_SHP` | `.../GIS/assets/vector/limites/distrital/DISTRITOS.shp` | distrital INEI 2023 |
| `INDEX_JSON` | `data/privado/index.json` | índice de distritos (conteos y área) |
| `CLAVES` | `api/claves.json` | claves de API y su cuota |
| `CACHE_TTL` | `300` | segundos de caché por polígono |

## Endpoints

Todas las rutas exigen el header `X-API-Key`. La respuesta incluye `X-Cuota-Restante`.

```bash
K=dev-demo-2026
BASE=http://127.0.0.1:8000

curl -H "X-API-Key: $K" $BASE/salud
curl -H "X-API-Key: $K" "$BASE/distritos?q=cocachacra"
curl -H "X-API-Key: $K" "$BASE/predios?ubigeo=040702&formato=geojson&limite=2" -o predios.geojson
curl -H "X-API-Key: $K" "$BASE/predios?ubigeo=040702&formato=geoparquet" -o predios.parquet
curl -H "X-API-Key: $K" "$BASE/predios?ubigeo=040702&formato=csv&buffer_m=100" -o predios.csv
curl -H "X-API-Key: $K" -H "Content-Type: application/json" \
     -d '{"type":"Polygon","coordinates":[[[-71.7,-17.2],[-71.6,-17.2],[-71.6,-17.1],[-71.7,-17.1],[-71.7,-17.2]]]}' \
     "$BASE/predios?formato=geojson"
```

- `formato`: `geojson` | `geoparquet` | `csv` (csv sin geometría).
- `limite`: recorta el número de predios devueltos.
- `buffer_m`: buffer aproximado en metros sobre el polígono de entrada.
- Códigos: `401` sin key o key inválida, `404` ubigeo inexistente, `429` cuota diaria agotada.

## Claves

`api/claves.json`:

```json
{
  "dev-demo-2026": {
    "nombre": "Desarrollo local",
    "plan": "demo",
    "cuota_diaria": 200,
    "usada_hoy": 0,
    "fecha": "2026-10-13"
  }
}
```

Para crear una clave nueva: `python -c "from api.main import crear_clave; print(crear_clave('Cliente X', 'basico', 500))"`.

## Pruebas

```bash
/data/users/julio/.conda/envs/deep/bin/python -m pytest api/pruebas_api.py -v
```

## Notas legales (obligatorias)

- La información es **referencial** y **no constituye publicidad registral**; no tiene valor
  para trámites administrativos ni judiciales. Debe mostrarse este aviso en toda salida.
- **No** incluir, indexar ni exponer el **nombre del titular** de la partida.
- **No** almacenar documentos de partida: cualquier consulta a Conoce Aquí va con la
  identidad del propio usuario y sin retención.
- Fuente: servicio público Visor BGR de SUNARP (Res. N° 204-2023-SUNARP/SN).
