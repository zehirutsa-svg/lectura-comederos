/**
 * Lectura de Comederos — script del Google Sheet.
 *
 * Recibe los scores que mandan los teléfonos, los guarda en el Sheet, arma la
 * hoja "Planilla" (corrales en filas, días en columnas, como el Excel original)
 * y avisa por mail cuando un operario cargó o modificó una lectura.
 *
 * Hojas:
 *   Planilla  — vista para leer: "4 (-2%)" por corral y día. Se rearma sola.
 *   Registro  — cada cambio que llegó (carga, modificación, borrado), con quién
 *               y cuándo. Nunca se borra nada acá.
 *   Datos     — el valor vigente de cada corral/día (lo que usa la app). No editar a mano.
 *   Corrales  — lista de corrales y si están en uso.
 *
 * Reglas (se chequean acá, no solo en la app):
 *   - Un operario solo puede cargar/modificar/borrar el día en que está (según
 *     la hora de su teléfono al momento del cambio, así funciona sin señal).
 *   - Con el código de administrador se puede corregir cualquier día.
 *   - Si dos cambios tocan el mismo corral y día, queda el más reciente.
 *
 * Se sube con clasp (ver CLAUDE.md). La primera vez que se abre la URL del
 * script, el dueño autoriza los permisos y la planilla se prepara sola.
 *
 * Nada privado vive en este archivo (el repositorio es público): el código de
 * administrador se define desde la app la primera vez y queda en las
 * propiedades del script; el aviso va al mail del dueño de la planilla, salvo
 * que se defina la propiedad EMAIL_AVISO (varios mails separados por coma).
 */

const ZONA = 'America/Asuncion';
const CORRALES_INICIALES = 12;
const PCT = { 1: -7, 2: -5, 3: -3, 4: -2, 5: 0, 6: 2, 7: 3, 8: 5, 9: 7 };
const COLOR = { 1: '#F7C1C1', 2: '#F7C1C1', 3: '#FAC775', 4: '#FAC775', 5: '#E4E2DA', 6: '#C0DD97', 7: '#C0DD97', 8: '#9FE1CB', 9: '#9FE1CB' };
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const DIAS_SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const COLS_DATOS = ['Clave', 'Fecha', 'Corral', 'Score', 'Marca de tiempo', 'Usuario', 'ID cambio', 'Aviso pendiente'];
const COLS_REGISTRO = ['Recibido', 'Fecha lectura', 'Corral', 'Score', 'Lectura', 'Acción', 'Usuario', 'Hora en el teléfono', 'Resultado'];

// ---------------------------------------------------------------- instalación
const props_ = () => PropertiesService.getScriptProperties();

/** Prepara la planilla la primera vez (la llaman doGet/doPost solas). */
function asegurarConfigurado_() {
  if (props_().getProperty('CONFIGURADO') === 'si') return;
  configurar();
  props_().setProperty('CONFIGURADO', 'si');
}

/** Arma hojas, corrales iniciales y el disparador del aviso. Se puede repetir sin problema. */
function configurar() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(ZONA);
  const planilla = hoja_(ss, 'Planilla', null);
  const registro = hoja_(ss, 'Registro', COLS_REGISTRO);
  const datos = hoja_(ss, 'Datos', COLS_DATOS);
  const corr = hoja_(ss, 'Corrales', ['Corral', 'Activo']);
  datos.getRange('A:B').setNumberFormat('@');
  registro.getRange('B:B').setNumberFormat('@');
  if (corr.getLastRow() < 2) {
    const filas = [];
    for (let i = 1; i <= CORRALES_INICIALES; i++) filas.push([i, true]);
    corr.getRange(2, 1, filas.length, 2).setValues(filas);
  }
  // Orden de las pestañas y limpieza de la hoja vacía que trae un Sheet nuevo.
  [planilla, registro, corr, datos].forEach((h, i) => { ss.setActiveSheet(h); ss.moveActiveSheet(i + 1); });
  ss.getSheets().forEach((h) => {
    if (['Planilla', 'Registro', 'Datos', 'Corrales'].indexOf(h.getName()) === -1 && h.getLastRow() === 0) ss.deleteSheet(h);
  });
  // Aviso por mail: revisa cada 10 minutos si hay cargas nuevas.
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'enviarAvisos')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('enviarAvisos').timeBased().everyMinutes(10).create();
  reconstruirPlanilla_(ss);
  ss.setActiveSheet(planilla);
}

function hoja_(ss, nombre, encabezado) {
  let h = ss.getSheetByName(nombre);
  if (!h) h = ss.insertSheet(nombre);
  if (encabezado && h.getLastRow() === 0) {
    h.getRange(1, 1, 1, encabezado.length).setValues([encabezado]).setFontWeight('bold').setBackground('#eeeeee');
    h.setFrozenRows(1);
  }
  return h;
}

// ---------------------------------------------------------------- web (lo que llama la app)
/** Abrir la URL en el navegador: la primera vez prepara la planilla y confirma que anda. */
function doGet() {
  asegurarConfigurado_();
  const url = SpreadsheetApp.getActive().getUrl();
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:20px;padding:24px">' +
    '<p>✓ <b>Lectura de Comederos</b> está funcionando.</p>' +
    '<p><a href="' + url + '" target="_blank">Abrir la planilla</a></p></div>')
    .setTitle('Lectura de Comederos');
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'pedido inválido' }); }
  try {
    asegurarConfigurado_();
    switch (body.accion) {
      case 'guardar': return json_(guardar_(body));
      case 'datos': return json_(datos_(body));
      case 'verificarPin': return json_({ ok: true, valido: esAdmin_(body.pin), definido: !!pinGuardado_() });
      case 'definirPin': return json_(definirPin_(body));
      case 'corrales': return json_(guardarCorrales_(body));
      default: return json_({ ok: false, error: 'acción desconocida' });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

const pinGuardado_ = () => props_().getProperty('PIN_ADMIN');

function esAdmin_(pin) {
  const guardado = pinGuardado_();
  return !!guardado && !!pin && String(pin) === guardado;
}

/** Solo funciona si todavía no hay código: el primero que lo define desde la app queda. */
function definirPin_(body) {
  const pin = String(body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'el código tiene que ser de 4 a 8 números' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (pinGuardado_()) return { ok: false, error: 'ya hay un código de administrador definido' };
    props_().setProperty('PIN_ADMIN', pin);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Para cambiar el código: borrar la propiedad PIN_ADMIN (Configuración del proyecto → Propiedades
 *  del script) o ejecutar esta función desde el editor; después se define uno nuevo desde la app. */
function borrarCodigoAdmin() {
  props_().deleteProperty('PIN_ADMIN');
}

function emailAviso_() {
  return props_().getProperty('EMAIL_AVISO') || Session.getEffectiveUser().getEmail();
}

// ---------------------------------------------------------------- lectura / escritura de "Datos"
function iso_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ZONA, 'yyyy-MM-dd');
  return String(v);
}

function leerDatos_(sh) {
  const mapa = {};
  const n = sh.getLastRow();
  if (n < 2) return mapa;
  sh.getRange(2, 1, n - 1, COLS_DATOS.length).getValues().forEach((f, i) => {
    const fecha = iso_(f[1]);
    const corral = Number(f[2]);
    mapa[fecha + '|' + corral] = {
      fila: i + 2, fecha, corral,
      score: f[3] === '' ? null : Number(f[3]),
      ts: Number(f[4]), usuario: String(f[5]), id: String(f[6]), aviso: f[7] === true,
    };
  });
  return mapa;
}

function filaDatos_(r) {
  return [r.fecha + '|' + r.corral, r.fecha, r.corral, r.score == null ? '' : r.score, r.ts, r.usuario, r.id, r.aviso];
}

function lectura_(s) {
  if (s == null || s === '') return '';
  const p = PCT[s];
  return s + ' (' + (p > 0 ? '+' : '') + p + '%)';
}

function guardar_(body) {
  const ops = Array.isArray(body.ops) ? body.ops : [];
  const admin = esAdmin_(body.pin);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActive();
    const shD = ss.getSheetByName('Datos');
    const shR = ss.getSheetByName('Registro');
    const mapa = leerDatos_(shD);
    const ahora = new Date();
    const hoy = Utilities.formatDate(ahora, ZONA, 'yyyy-MM-dd');
    const resultados = [];
    const log = [];
    const tocados = {};

    ops.forEach((op) => {
      const fecha = String(op.fecha || '');
      const corral = Number(op.corral);
      const score = op.score == null ? null : Number(op.score);
      const ts = Number(op.ts);
      const usuario = String(op.usuario || '') + (admin ? ' (admin)' : '');
      const horaTel = isFinite(ts) ? Utilities.formatDate(new Date(ts), ZONA, 'dd/MM/yyyy HH:mm:ss') : '';
      const registrar = (accion, resultado) =>
        log.push([ahora, fecha, corral, score == null ? '' : score, lectura_(score), accion, usuario, horaTel, resultado]);

      const valido = /^\d{4}-\d{2}-\d{2}$/.test(fecha) && Number.isInteger(corral) && corral >= 1 &&
        (score === null || (Number.isInteger(score) && score >= 1 && score <= 9)) && isFinite(ts);
      if (!valido) {
        registrar('—', 'Rechazado: dato inválido');
        resultados.push({ id: op.id, estado: 'rechazado' });
        return;
      }
      const k = fecha + '|' + corral;
      const ex = mapa[k];
      if (ex && ex.id === String(op.id)) {       // reenvío de algo que ya había llegado
        resultados.push({ id: op.id, estado: 'duplicado' });
        return;
      }
      const accion = score == null ? 'Borrado' : (ex && ex.score != null ? 'Modificación' : 'Carga');
      const diaTelefono = Utilities.formatDate(new Date(ts), ZONA, 'yyyy-MM-dd');
      const futuro = fecha > hoy || ts > ahora.getTime() + 15 * 60 * 1000;
      if (futuro || (!admin && fecha !== diaTelefono)) {
        registrar(accion, futuro ? 'Rechazado: fecha futura' : 'Rechazado: día anterior (solo el administrador puede corregirlo)');
        resultados.push({ id: op.id, estado: 'rechazado' });
        return;
      }
      if (ex && ex.ts > ts) {
        registrar(accion, 'Ignorado: ya había un cambio más nuevo');
        resultados.push({ id: op.id, estado: 'ignorado' });
        return;
      }
      mapa[k] = {
        fila: ex ? ex.fila : null, fecha, corral, score, ts, usuario, id: String(op.id),
        aviso: admin ? (ex ? ex.aviso : false) : true,
      };
      tocados[k] = true;
      registrar(accion, 'Aplicado');
      resultados.push({ id: op.id, estado: 'aplicado' });
    });

    const nuevas = [];
    Object.keys(tocados).forEach((k) => {
      const r = mapa[k];
      if (r.fila) shD.getRange(r.fila, 1, 1, COLS_DATOS.length).setValues([filaDatos_(r)]);
      else nuevas.push(filaDatos_(r));
    });
    if (nuevas.length) shD.getRange(shD.getLastRow() + 1, 1, nuevas.length, COLS_DATOS.length).setValues(nuevas);
    if (log.length) shR.getRange(shR.getLastRow() + 1, 1, log.length, COLS_REGISTRO.length).setValues(log);
    if (Object.keys(tocados).length) reconstruirPlanilla_(ss, mapa);
    return { ok: true, resultados };
  } finally {
    lock.releaseLock();
  }
}

function leerCorrales_(ss) {
  const sh = ss.getSheetByName('Corrales');
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 2).getValues()
    .filter((f) => f[0] !== '')
    .map((f) => ({ numero: Number(f[0]), activo: f[1] === true || String(f[1]).toUpperCase() === 'TRUE' }))
    .sort((a, b) => a.numero - b.numero);
}

function datos_(body) {
  const ss = SpreadsheetApp.getActive();
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(body.desde || '')) ? body.desde : '0000-00-00';
  const mapa = leerDatos_(ss.getSheetByName('Datos'));
  const registros = Object.keys(mapa).map((k) => mapa[k])
    .filter((r) => r.fecha >= desde)
    .map((r) => ({ fecha: r.fecha, corral: r.corral, score: r.score, ts: r.ts, usuario: r.usuario }));
  return { ok: true, registros, corrales: leerCorrales_(ss) };
}

function guardarCorrales_(body) {
  if (!esAdmin_(body.pin)) return { ok: false, error: 'solo el administrador puede cambiar los corrales' };
  const lista = (Array.isArray(body.corrales) ? body.corrales : [])
    .filter((c) => Number.isInteger(Number(c.numero)) && Number(c.numero) >= 1)
    .map((c) => [Number(c.numero), c.activo === true])
    .sort((a, b) => a[0] - b[0]);
  if (!lista.length) return { ok: false, error: 'lista de corrales vacía' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('Corrales');
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
    sh.getRange(2, 1, lista.length, 2).setValues(lista);
    reconstruirPlanilla_(ss);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- hoja "Planilla"
function encabezadoFecha_(iso) {
  const p = iso.split('-');
  return Number(p[2]) + ' ' + MESES[Number(p[1]) - 1].toUpperCase() + ' ' + p[0];
}

function reconstruirPlanilla_(ss, mapa) {
  mapa = mapa || leerDatos_(ss.getSheetByName('Datos'));
  const sh = ss.getSheetByName('Planilla');
  const registros = Object.keys(mapa).map((k) => mapa[k]);
  const conDato = {};
  registros.forEach((r) => { if (r.score != null) conDato[r.corral] = true; });
  // Corrales en uso, más los que ya no se usan pero tienen datos viejos.
  const corrales = leerCorrales_(ss).filter((c) => c.activo || conDato[c.numero]).map((c) => c.numero);
  Object.keys(conDato).map(Number).forEach((n) => { if (corrales.indexOf(n) === -1) corrales.push(n); });
  corrales.sort((a, b) => a - b);
  const fechas = [];
  registros.forEach((r) => { if (r.score != null && fechas.indexOf(r.fecha) === -1) fechas.push(r.fecha); });
  fechas.sort();

  const valores = [['CORRAL'].concat(fechas.map(encabezadoFecha_))];
  const fondos = [['#eeeeee'].concat(fechas.map(() => '#eeeeee'))];
  corrales.forEach((n) => {
    const fila = ['CORRAL ' + n];
    const fondo = ['#ffffff'];
    fechas.forEach((f) => {
      const r = mapa[f + '|' + n];
      const s = r && r.score != null ? r.score : null;
      fila.push(lectura_(s));
      fondo.push(s != null ? COLOR[s] : '#ffffff');
    });
    valores.push(fila);
    fondos.push(fondo);
  });

  sh.clear();
  const rango = sh.getRange(1, 1, valores.length, valores[0].length);
  rango.setNumberFormat('@').setValues(valores).setBackgrounds(fondos)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setFontSize(11);
  sh.getRange(1, 1, 1, valores[0].length).setFontWeight('bold');
  sh.getRange(1, 1, valores.length, 1).setFontWeight('bold').setHorizontalAlignment('left');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 110);
  if (fechas.length) sh.setColumnWidths(2, fechas.length, 105);
}

// ---------------------------------------------------------------- aviso por mail
/** Lo ejecuta el disparador cada 10 minutos. Manda un mail por día con cargas nuevas. */
function enviarAvisos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const ss = SpreadsheetApp.getActive();
    const shD = ss.getSheetByName('Datos');
    const mapa = leerDatos_(shD);
    const pendientes = Object.keys(mapa).map((k) => mapa[k]).filter((r) => r.aviso);
    if (!pendientes.length) return;
    const porFecha = {};
    pendientes.forEach((r) => { (porFecha[r.fecha] = porFecha[r.fecha] || []).push(r); });
    const ahora = Date.now();
    const corrales = leerCorrales_(ss).filter((c) => c.activo).map((c) => c.numero);

    Object.keys(porFecha).sort().forEach((fecha) => {
      const filas = porFecha[fecha];
      // Si el operario sigue cargando (último cambio hace menos de 5 min), esperar a la próxima vuelta.
      const ultimo = Math.max.apply(null, filas.map((r) => r.ts));
      if (ahora - ultimo < 5 * 60 * 1000) return;
      const texto = textoResumen_(mapa, corrales, fecha);
      MailApp.sendEmail({
        to: emailAviso_(),
        subject: 'Lectura de Comederos – ' + fechaLarga_(fecha),
        body: texto + '\n\nPlanilla: ' + ss.getUrl(),
        htmlBody: '<pre style="font-family:Consolas,Menlo,monospace;font-size:15px">' +
          texto.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>' +
          '<p><a href="' + ss.getUrl() + '">Abrir la planilla</a></p>',
      });
      filas.forEach((r) => { shD.getRange(r.fila, 8).setValue(false); });
    });
  } finally {
    lock.releaseLock();
  }
}

function fechaLarga_(iso) {
  const p = iso.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return DIAS_SEMANA[d.getDay()] + ' ' + p[2] + ' ' + MESES[Number(p[1]) - 1] + ' ' + p[0];
}

function sumarDias_(iso, n) {
  const p = iso.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

function textoResumen_(mapa, corrales, fecha) {
  const lineas = ['LECTURA DE COMEDEROS', fechaLarga_(fecha), ''];
  const quienes = [];
  corrales.forEach((n) => {
    const r = mapa[fecha + '|' + n];
    lineas.push('CORRAL ' + n + ': ' + (r && r.score != null ? lectura_(r.score) : '—'));
    if (r && r.score != null && r.usuario && quienes.indexOf(r.usuario) === -1) quienes.push(r.usuario);
  });
  if (quienes.length) lineas.push('', 'Cargó: ' + quienes.join(', '));
  const dias = [];
  for (let i = 6; i >= 0; i--) dias.push(sumarDias_(fecha, -i));
  const ancho = Math.max.apply(null, corrales.map((n) => ('CORRAL ' + n).length));
  lineas.push('', 'Últimos 7 días:');
  lineas.push(' '.repeat(ancho) + dias.map((d) => ('   ' + Number(d.split('-')[2])).slice(-3)).join(''));
  corrales.forEach((n) => {
    lineas.push(('CORRAL ' + n + '          ').slice(0, ancho) + dias.map((d) => {
      const r = mapa[d + '|' + n];
      return ('   ' + (r && r.score != null ? r.score : '-')).slice(-3);
    }).join(''));
  });
  return lineas.join('\n');
}
