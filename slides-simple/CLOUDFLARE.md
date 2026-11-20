# SLIDES SIMPLE — Cloudflare Workers

Este Worker convierte las presentaciones en enlaces cortos usando Workers KV. Los registros se guardan **sin TTL**: no se programa su expiración automática.

## Recursos que debes crear en Cloudflare

1. En **Workers & Pages → KV**, crea un namespace llamado `SLIDES_SIMPLE`.
2. En **Workers & Pages → Create application → Worker**, crea un Worker llamado `slides-simple-api`.
3. Sustituye el contenido del Worker por `worker.js` y pulsa **Deploy**.
4. En el Worker entra a **Settings → Bindings → Add → KV Namespace**:
   - Variable name: `SLIDES_KV`
   - KV namespace: `SLIDES_SIMPLE`
   Guarda y vuelve a desplegar.
5. Comprueba que el subdominio `workers.dev` esté activo para tu cuenta.

El endpoint resultante tendrá este formato:

`https://slides-simple-api.<TU-SUBDOMINIO>.workers.dev`

Prueba el endpoint abriendo `/health`. Debe responder con JSON y `ok: true`.

## Conectar la interfaz de GitHub Pages

En `slides-simple/index.html`, reemplaza el valor de `API_BASE` por la URL real del Worker, sin barra final. Ejemplo:

`const API_BASE = 'https://slides-simple-api.mi-cuenta.workers.dev';`

La interfaz enviará la presentación a `POST /api/slides` y compartirá un enlace de formato:

`https://udrojasc.github.io/Slides/slides-simple/#i=IDENTIFICADOR`

Al abrirlo, la página consulta `GET /api/slides/IDENTIFICADOR`. Los enlaces comprimidos antiguos (`#z...`) continúan funcionando.

## API

- `GET /health`: prueba de disponibilidad.
- `POST /api/slides`: guarda una presentación y devuelve su ID.
- `GET /api/slides/:id`: recupera una presentación.

El Worker solo acepta peticiones de navegador cuyo origen sea `https://udrojasc.github.io`. Los datos no tienen autenticación: cualquiera que tenga el enlace puede ver y abrir la presentación. El Worker no ofrece edición ni borrado.

## Límites y permanencia

El Worker no establece expiración automática. Eso significa que los enlaces no caducan por configuración del código, pero siguen sujetos a disponibilidad de Cloudflare, límites de cuenta, políticas del proveedor y conservación de la cuenta. No existe una garantía técnica de permanencia eterna.
