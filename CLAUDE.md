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
  sw.js               service worker: red primero (3 s) y si no, copia guardada; el manifest nunca
                      se cachea (si no, Chrome instala con el nombre viejo). Subir CACHE en cada publicación
  manifest.webmanifest, icons/   ícono = logo completo de ZEHIRUT (ver abajo)
apps-script/          backend (Code.gs + appsscript.json), se sube con clasp (ver abajo)
.clasp.json           scriptId del Apps Script y parentId del Google Sheet
dev/servidor-prueba.js  servidor local de prueba: sirve docs/ y corre Code.gs con un Sheet falso
```

Probar local: `node dev/servidor-prueba.js 8765` → <http://localhost:8765> (arranca sin código
de admin, como Google recién instalado — la app pide crearlo; `node dev/servidor-prueba.js 8765 1234`
arranca con uno. `/_hojas` muestra el Sheet simulado, `/_avisos` fuerza el mail). La app de
prueba usa el Sheet simulado (el servidor reemplaza `config.js`), nunca el real.

## Google (clasp, cuenta zehirutsa@gmail.com)

clasp (global, v3) ya está logueado con zehirutsa@gmail.com en esta compu — mismo esquema que
el proyecto ZehirutApp. Todo se hace desde acá, sin copiar/pegar en el editor:

- Google Sheet "Lectura de Comederos": `https://docs.google.com/spreadsheets/d/1z9la4M8hI7TwU3i1u5RfGCJaITeA7-ZfNITvWcGPwkk`
- Script (ligado a esa planilla): `https://script.google.com/d/1EbFGrUItGaYTkTEf8_ineHYmbR3kXnMAJvOggIQBSUy3KopYW8aU8tk6/edit`
- Implementación web "Lectura de Comederos": `AKfycbwOYRU_qkLYae8BLCjr_3FkQiXPtNT4lPVeH-fHIR6_C7f_BLTJ3qgSGJHRWsO1tB9Pfg`
  (su URL `/exec` está en `docs/config.js`). Ejecuta como el dueño, acceso anónimo (los
  teléfonos no se loguean en Google).

Cambiar el script: editar `apps-script/Code.gs` → `clasp push --force` →
`clasp update-deployment AKfycbwOYRU_qkLYae8BLCjr_3FkQiXPtNT4lPVeH-fHIR6_C7f_BLTJ3qgSGJHRWsO1tB9Pfg -d "..."`
(actualizar ESA implementación, no crear otra: la URL cambiaría y habría que republicar la app).
Si se agrega un permiso nuevo en `oauthScopes`, el dueño tiene que volver a autorizar abriendo
la URL `/exec` en el navegador.

**Nada privado en el repo (es público)**: el código de administrador se crea desde la app la
primera vez y vive en las propiedades del script (`PIN_ADMIN`); para cambiarlo, ejecutar
`borrarCodigoAdmin` en el editor y crear uno nuevo desde la app. El aviso va al mail del dueño
(`Session.getEffectiveUser`), salvo que se defina la propiedad `EMAIL_AVISO`. La planilla se
prepara sola (`asegurarConfigurado_`) la primera vez que se abre la URL o llega un pedido.

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
  al hacer el cambio, así funciona offline); el administrador (código guardado en Google, ver
  arriba) corrige cualquier día. Lo valida el script, no solo la app.
- **Datos en Google Sheet** de la cuenta **zehirutsa@gmail.com** (dueña). Hojas: Planilla (vista
  tipo Excel), Registro (log de todo cambio, nunca se borra), Corrales, Datos (valor vigente).
  Conflictos: queda el cambio más reciente (por marca de tiempo del teléfono).
- **Carga del día** (v1.2.0): hoy se trabaja como una carga — panel "Iniciar carga de hoy" →
  corrales (los vacíos se saltean con las flechas, NO se deshabilitan: pedido explícito, van a
  ocuparse pronto) → "Finalizar carga de hoy" (avisa cuáles quedaron sin cargar). Tras finalizar,
  panel "Carga finalizada" y se corrige desde el Resumen tocando un corral. La finalización viaja
  en la cola como `{tipo:'finalizar'}` y queda en la hoja **Cargas**. Un **administrador** puede
  además cerrar un día ANTERIOR que quedó abierto (desde el Resumen de ese día); ese cierre no
  manda mail. El operario solo finaliza su propio día (si sincroniza tarde, igual avisa).
- **Doble score (2 scores en un corral, ej. 2+2 = −10%)**: evaluado y descartado a propósito
  (sesión 2026-09-26): casos muy excepcionales, complicaba la pantalla del operario. No proponerlo
  de nuevo salvo que el usuario lo pida.
- **Aviso por mail a TODOS los administradores**: (A) "Carga finalizada", en el momento en que
  llega la finalización; (B) "Corrección" si después se cambia algo de un día finalizado (lo junta
  el disparador cada 10 min, espera 5 min sin cambios). Más el botón "Compartir por WhatsApp"
  (manual). Notificación push propia de la app: descartada — Apps Script no puede firmar Web Push
  (VAPID/ES256); necesitaría un servidor aparte. El usuario lo entendió y eligió mail.
- **Administradores** (v1.2.0): cada uno con su propio código de 6 números, generado por el
  script y mostrado UNA sola vez. Solo el **principal** (el dueño) agrega/edita/quita admins y
  regenera códigos, desde Menú → Administradores. Guardados en la propiedad `ADMINS` (nombre,
  mail, sal, hash SHA-256; nunca el código). Freno: 15 códigos errados en 10 min bloquea todo
  código por 10 min (CacheService). Al abrir la app se re-verifica el código guardado; si el
  principal lo quitó, el teléfono sale del modo admin. El código único de la v1.1 (`PIN_ADMIN`)
  se migró solo a principal; toma el nombre del operario del teléfono la primera vez que entra.
  Emergencia (principal perdió su código): ejecutar `reiniciarAdministradores` en el editor.
- **Nombre del operario**: se pide una vez por teléfono y queda en cada registro.
- **Gráfico por corral** (v1.1.0): en Historial se toca el nombre del corral → línea del score
  día por día (14/30/60 días), puntos con el color de su botón, línea de referencia en 5 (0%),
  huecos en los días sin carga, tocar/arrastrar muestra el día, y abajo días cargados + promedio.
  SVG a mano (sin bibliotecas) para que ande offline; si el período pide más días de los que hay
  en el teléfono, se agranda `diasHistorial` y se sincroniza.
- **Logo**: el logo completo de ZEHIRUT (círculo "Estancias La Prudencia – La Paciencia"). El
  dibujo del centro es la **marca a fuego** del ganado de ZEHIRUT S.A. (única en Paraguay), no una
  firma ni una marca comercial. Los íconos de `docs/icons/` salen del PNG original con el fondo
  cuadriculado (falso) limpiado.
- Fechas para mostrar: `26 set 2026` ("set", nunca "sep").

## GitHub

- Repo público `zehirutsa-svg/lectura-comederos`; GitHub Pages publica `main` / carpeta `docs`.
- App publicada: **https://zehirutsa-svg.github.io/lectura-comederos/** (el link que se abre en
  los teléfonos para instalarla).
- Push con deploy key propia de este repo (`~/.ssh/github_comederos`, ya puesta en
  `core.sshCommand` del repo local). La de estancia-app (`github_estancia`) NO sirve acá: las
  deploy keys son de un solo repo.

## Publicar una versión nueva

1. Cambiar lo que haga falta en `docs/`.
2. Subir `CACHE` en `docs/sw.js` (y `VERSION` en `app.js`).
3. Commit + push a `main`: GitHub Pages publica solo en ~1 minuto. Los teléfonos toman la
   versión nueva la segunda vez que abren la app con señal.

Si se cambia `apps-script/Code.gs`: ver "Google (clasp...)" arriba.
