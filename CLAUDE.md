# Lectura de Comederos

App para celular (PWA offline) donde el operario del confinamiento carga, corral por corral, el
**score de lectura de comedero** (1 a 9) de cada día. Estancias La Prudencia / La Paciencia
(ZEHIRUT S.A.). Proyecto separado de `estancia-app`, no comparte código ni base.

## Score → ajuste de la dieta del día (fijo, confirmado por el usuario)

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|
| −7% | −5% | −3% | −2% | 0% | +2% | +3% | +5% | +7% |

Siempre se muestra `número (porcentaje)`, ej. `3 (−3%)`, como en la planilla Excel original
(`PLAINLLA DE SCORE_ejemplo para claude.xlsx`, no versionada). Corrales: CORRAL 1 a CORRAL 12
al arrancar, se pueden agregar/quitar (modo administrador).

## Estructura

```
docs/                 la app (GitHub Pages publica esta carpeta — por eso se llama docs)
  index.html, style.css, app.js
  config.js           SCRIPT_URL = URL del Apps Script (vacía = solo guarda en el teléfono)
  sw.js               service worker (offline). Subir CACHE ('comederos-vN') en cada publicación
  manifest.webmanifest, icons/   ícono = logo completo de ZEHIRUT (ver abajo)
apps-script/Code.gs   backend: se pega en el Apps Script del Google Sheet (ver GUIA_GOOGLE_SHEET.md)
dev/servidor-prueba.js  servidor local de prueba: sirve docs/ y corre Code.gs con un Sheet falso
```

Probar local: `node dev/servidor-prueba.js 8765` → <http://localhost:8765> (código admin de
prueba: `1234`; `/_hojas` muestra el Sheet simulado, `/_avisos` fuerza el mail).

## Decisiones tomadas con el usuario (no volver a preguntar)

- **PWA instalable**, se abre con su propio ícono a pantalla completa (no desde Chrome). Hosting
  en **GitHub Pages**. Sin frameworks ni build: HTML/CSS/JS planos.
- **Diseño para pleno sol**: blanco/negro puro, números grandes, 9 botones con colores
  (rojo 1-2, naranja 3-4, gris 5, verde 6-7, verde agua 8-9). Palabra "CORRAL" arriba y el número
  grande abajo, entre flechas negras dentro de un botón con borde. Al tocar un score pasa solo al
  corral siguiente.
- **Modificar** un score ya cargado → cartel de confirmación con valor anterior y nuevo.
  **Borrar** → botón rojo (solo visible si hay score), con confirmación; el corral queda "—".
- **Permisos**: el operario carga/modifica/borra solo el día de HOY (según la hora de su teléfono
  al hacer el cambio, así funciona offline); el administrador (código `PIN_ADMIN` del script)
  corrige cualquier día. Lo valida el script, no solo la app.
- **Datos en Google Sheet** de la cuenta **zehirutsa@gmail.com** (dueña). Hojas: Planilla (vista
  tipo Excel), Registro (log de todo cambio, nunca se borra), Corrales, Datos (valor vigente).
  Conflictos: queda el cambio más reciente (por marca de tiempo del teléfono).
- **Aviso**: (A) botón "Compartir por WhatsApp" con el día + tabla de últimos 7 días, y
  (B) mail automático a zehirutsa@gmail.com (disparador cada 10 min; espera 5 min sin cambios
  para no mandar un mail a mitad de la carga). Los cambios del admin no generan mail.
- **Nombre del operario**: se pide una vez por teléfono y queda en cada registro.
- **Logo**: el logo completo de ZEHIRUT (círculo "Estancias La Prudencia – La Paciencia"). El
  dibujo del centro es la **marca a fuego** del ganado de ZEHIRUT S.A. (única en Paraguay), no una
  firma ni una marca comercial. Los íconos de `docs/icons/` salen del PNG original con el fondo
  cuadriculado (falso) limpiado.
- Fechas para mostrar: `26 set 2026` ("set", nunca "sep").

## Publicar una versión nueva

1. Cambiar lo que haga falta en `docs/`.
2. Subir `CACHE` en `docs/sw.js` (y `VERSION` en `app.js`).
3. Commit + push a `main`: GitHub Pages publica solo en ~1 minuto. Los teléfonos toman la
   versión nueva la segunda vez que abren la app con señal.

Si se cambia `apps-script/Code.gs`: pegarlo en el editor de Apps Script y publicar una versión
nueva de la MISMA implementación (ver GUIA_GOOGLE_SHEET.md), para que la URL no cambie.
