# Predios SUNARP — visor y descargas por distrito

App web estática para consultar los predios inscritos de un distrito (polígonos de la
Base Gráfica Registral de SUNARP) y descargarlos en GeoJSON, CSV o Excel. Incluye
intersección en el navegador contra un archivo propio (GeoJSON o Shapefile `.zip`).

## Aviso legal

La información mostrada tiene **carácter referencial** y **no constituye publicidad
registral**, por lo tanto no tiene valor para trámites administrativos ni judiciales.
Fuente: servicio público **Visor BGR** de SUNARP (Res. N° 204-2023-SUNARP/SN).
Los datos de este repositorio son una muestra de demostración.

## Uso en local

```bash
python -m http.server 8801
# abrir http://localhost:8801
```

No hay build: es HTML + JS con librerías por CDN.

## Despliegue

GitHub Pages sirve la raíz del repo tal cual (`Settings → Pages → Deploy from a branch:
main / (root)`).

## Estructura

```
index.html                      app (MapLibre GL + panel + descargas)
assets/app.js                   lógica (búsqueda, mapa, descargas, intersección)
assets/styles.css               diseño responsive (tema claro/oscuro)
data/distritos/index.json       índice de distritos (buscador y métricas)
data/distritos/<ubigeo>.geojson predios del distrito (EPSG:4326, orden área DESC)
generar_paquetes_distritos.py   genera los paquetes desde el parquet nacional
```

## Contrato de datos

`data/distritos/index.json` es un array de:

```json
{
  "ubigeo": "040706",
  "distrito": "PUNTA DE BOMBON",
  "provincia": "ISLAY",
  "departamento": "AREQUIPA",
  "n_predios": 4705,
  "area_total_m2": 12345678.9,
  "archivo": "data/distritos/040706.geojson",
  "demo": true
}
```

Cada GeoJSON es un `FeatureCollection` en EPSG:4326 con propiedades
`PART_REG, COD_OFRE, TIP_PRED, GEO_AREA, FEC_TIT_F, ASIENTO_REG, NUM_TIT, DIR_REG,
MANZANA, LOTE, capa, OID`, ordenado por área descendente (los predios grandes
primero para que en el visor los chicos queden encima).

## Generar paquetes

```bash
python generar_paquetes_distritos.py --demo            # 3 distritos de demostración
python generar_paquetes_distritos.py --ubigeo 040706   # uno concreto
python generar_paquetes_distritos.py --todos           # los 1 891 distritos del Perú
```

Requiere el parquet nacional consolidado y el shapefile distrital del INEI 2023
(rutas configurables en la cabecera del script).

## Roadmap

- V1 (esta): demo estática con descargas por distrito e intersección local.
- V2: API para polígonos arbitrarios (FastAPI + DuckDB), claves y cuotas.
- V3: paquetes completos por distrito, MCP para agentes IA y enlace a documentos
  de partida (Conoce Aquí).

## Cache del navegador

Al cambiar `assets/app.js`, `assets/styles.css` o `config.js`, sube la versión en las tres
etiquetas de `index.html` (`?v=AAAAMMDDx`). Si no, los navegadores siguen usando el archivo
viejo y parecen "bugs" que ya están arreglados.
