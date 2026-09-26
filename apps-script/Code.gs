/**
 * Lectura de Comederos — script del Google Sheet.
 *
 * Recibe los scores que mandan los teléfonos, los guarda en el Sheet, arma la
 * hoja "Planilla" (corrales en filas, días en columnas, como el Excel original)
 * y avisa por mail a los administradores cuando se finaliza la carga de un día
 * (y de nuevo, marcado "Corrección", si después se corrige algo).
 *
 * Hojas:
 *   Planilla  — vista para leer: "4 (-2%)" por corral y día. Se rearma sola.
 *   Registro  — cada cambio que llegó (carga, modificación, borrado, finalización),
 *               con quién y cuándo. Nunca se borra nada acá.
 *   Cargas    — una fila por día finalizado: quién, a qué hora, cuántos corrales.
 *   Corrales  — lista de corrales y si están en uso.
 *   Datos     — el valor vigente de cada corral/día (lo que usa la app). No editar a mano.
 *
 * Reglas (se chequean acá, no solo en la app):
 *   - Un operario solo puede cargar/modificar/borrar/finalizar el día en que está
 *     (según la hora de su teléfono al momento del cambio, así funciona sin señal).
 *   - Cada administrador tiene su propio código y puede corregir cualquier día.
 *     Solo el administrador principal da de alta/baja a los demás.
 *   - Si dos cambios tocan el mismo corral y día, queda el más reciente.
 *
 * Se sube con clasp (ver CLAUDE.md). La primera vez que se abre la URL del
 * script, el dueño autoriza los permisos y la planilla se prepara sola.
 *
 * Nada privado vive en este archivo (el repositorio es público): los
 * administradores (nombre, mail y su código cifrado) viven en las propiedades
 * del script, nunca en la planilla ni acá.
 */

const ZONA = 'America/Asuncion';
const CORRALES_INICIALES = 12;
const PCT = { 1: -7, 2: -5, 3: -3, 4: -2, 5: 0, 6: 2, 7: 3, 8: 5, 9: 7 };
const COLOR = { 1: '#F7C1C1', 2: '#F7C1C1', 3: '#FAC775', 4: '#FAC775', 5: '#E4E2DA', 6: '#C0DD97', 7: '#C0DD97', 8: '#9FE1CB', 9: '#9FE1CB' };
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const DIAS_SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const COLS_DATOS = ['Clave', 'Fecha', 'Corral', 'Score', 'Marca de tiempo', 'Usuario', 'ID cambio', 'Aviso pendiente'];
const COLS_REGISTRO = ['Recibido', 'Fecha lectura', 'Corral', 'Score', 'Lectura', 'Acción', 'Usuario', 'Hora en el teléfono', 'Resultado'];
const COLS_CARGAS = ['Fecha', 'Finalizada por', 'Hora en el teléfono', 'Recibido', 'Corrales cargados', 'Marca de tiempo'];
const ESQUEMA = '2';   // subir cuando cambien hojas/propiedades: la próxima llamada vuelve a preparar todo

// ---------------------------------------------------------------- instalación
const props_ = () => PropertiesService.getScriptProperties();

/** Prepara la planilla (y la pone al día tras un cambio de versión). La llaman doGet/doPost solas. */
function asegurarConfigurado_() {
  if (props_().getProperty('ESQUEMA') === ESQUEMA) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (props_().getProperty('ESQUEMA') === ESQUEMA) return;
    configurar();
    migrarAdmins_();
    props_().deleteProperty('CONFIGURADO');
    props_().setProperty('ESQUEMA', ESQUEMA);
  } finally {
    lock.releaseLock();
  }
}

/** Arma hojas, corrales iniciales y el disparador del aviso. Se puede repetir sin problema. */
function configurar() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(ZONA);
  const planilla = hoja_(ss, 'Planilla', null);
  const registro = hoja_(ss, 'Registro', COLS_REGISTRO);
  const datos = hoja_(ss, 'Datos', COLS_DATOS);
  const corr = hoja_(ss, 'Corrales', ['Corral', 'Activo']);
  const cargas = hoja_(ss, 'Cargas', COLS_CARGAS);
  datos.getRange('A:B').setNumberFormat('@');
  registro.getRange('B:B').setNumberFormat('@');
  cargas.getRange('A:A').setNumberFormat('@');
  if (corr.getLastRow() < 2) {
    const filas = [];
    for (let i = 1; i <= CORRALES_INICIALES; i++) filas.push([i, true]);
    corr.getRange(2, 1, filas.length, 2).setValues(filas);
  }
  // Orden de las pestañas y limpieza de la hoja vacía que trae un Sheet nuevo.
  [planilla, registro, cargas, corr, datos].forEach((h, i) => { ss.setActiveSheet(h); ss.moveActiveSheet(i + 1); });
  ss.getSheets().forEach((h) => {
    if (['Planilla', 'Registro', 'Cargas', 'Datos', 'Corrales'].indexOf(h.getName()) === -1 && h.getLastRow() === 0) ss.deleteSheet(h);
  });
  // Aviso de corrección: revisa cada 10 minutos (el de finalización sale en el momento).
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
      case 'verificarPin': return json_(verificarPin_(body));
      case 'definirPin': return json_(definirPin_(body));
      case 'corrales': return json_(guardarCorrales_(body));
      case 'admins': return json_(listarAdmins_(body));
      case 'agregarAdmin': return json_(agregarAdmin_(body));
      case 'editarAdmin': return json_(editarAdmin_(body));
      case 'quitarAdmin': return json_(quitarAdmin_(body));
      case 'nuevoCodigoAdmin': return json_(nuevoCodigoAdmin_(body));
      default: return json_({ ok: false, error: 'acción desconocida' });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- administradores
// Lista en la propiedad ADMINS (JSON): {id, nombre, email, sal, hash, principal}.
// El código nunca se guarda, solo su hash SHA-256 con una "sal" propia de cada uno.
// El principal (el dueño) es el único que da de alta/baja a los demás.

function admins_() {
  try { return JSON.parse(props_().getProperty('ADMINS') || '[]'); } catch (e) { return []; }
}

function guardarAdmins_(lista) {
  props_().setProperty('ADMINS', JSON.stringify(lista));
}

function hash_(pin, sal) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sal + ':' + pin, Utilities.Charset.UTF_8)
    .map((b) => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

function nuevoId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

/** Pasa el código único de la versión anterior (propiedad PIN_ADMIN) a administrador principal. */
function migrarAdmins_() {
  const viejo = props_().getProperty('PIN_ADMIN');
  if (!viejo) return;
  if (!admins_().length) {
    const sal = nuevoId_();
    guardarAdmins_([{
      id: nuevoId_(), nombre: NOMBRE_GENERICO, email: Session.getEffectiveUser().getEmail(),
      sal, hash: hash_(viejo, sal), principal: true,
    }]);
  }
  props_().deleteProperty('PIN_ADMIN');
}

// Freno contra probar códigos al azar: después de 15 errores en 10 minutos no se acepta ninguno.
const MAX_FALLOS = 15;
function adminDe_(pin) {
  if (!pin) return null;
  const cache = CacheService.getScriptCache();
  const fallos = Number(cache.get('fallos') || 0);
  if (fallos >= MAX_FALLOS) throw new Error('demasiados intentos con código equivocado; esperá 10 minutos');
  const lista = admins_();
  for (let i = 0; i < lista.length; i++) {
    if (hash_(String(pin), lista[i].sal) === lista[i].hash) return lista[i];
  }
  cache.put('fallos', String(fallos + 1), 600);
  return null;
}

function soloPrincipal_(pin) {
  const a = adminDe_(pin);
  if (!a || !a.principal) throw new Error('solo el administrador principal puede hacer esto');
  return a;
}

const NOMBRE_GENERICO = 'Administrador principal';

function verificarPin_(body) {
  const a = adminDe_(body.pin);
  // El principal migrado de la versión anterior queda con un nombre genérico: la primera
  // vez que entra desde la app toma el nombre del operario de ese teléfono.
  const nombreTel = String(body.nombre || '').trim().slice(0, 60);
  if (a && a.nombre === NOMBRE_GENERICO && nombreTel) {
    conLock_(() => {
      const lista = admins_();
      const x = lista.find((y) => y.id === a.id);
      if (x) { x.nombre = nombreTel; guardarAdmins_(lista); }
    });
    a.nombre = nombreTel;
  }
  return {
    ok: true, valido: !!a, definido: admins_().length > 0,
    nombre: a ? a.nombre : null, principal: !!(a && a.principal),
  };
}

/** Solo si todavía no hay ningún administrador (instalación nueva): el primero queda como principal. */
function definirPin_(body) {
  const pin = String(body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'el código tiene que ser de 4 a 8 números' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (admins_().length) return { ok: false, error: 'ya hay un administrador definido' };
    const sal = nuevoId_();
    guardarAdmins_([{
      id: nuevoId_(), nombre: String(body.nombre || NOMBRE_GENERICO).slice(0, 60),
      email: Session.getEffectiveUser().getEmail(), sal, hash: hash_(pin, sal), principal: true,
    }]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function publico_(a) {
  return { id: a.id, nombre: a.nombre, email: a.email, principal: !!a.principal };
}

function listarAdmins_(body) {
  soloPrincipal_(body.pin);
  return { ok: true, admins: admins_().map(publico_) };
}

/** Código nuevo de 6 números, distinto del de cualquier otro administrador. */
function generarCodigo_(lista) {
  for (let intento = 0; intento < 50; intento++) {
    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    if (!lista.some((a) => hash_(codigo, a.sal) === a.hash)) return codigo;
  }
  throw new Error('no se pudo generar un código');
}

function validarDatosAdmin_(nombre, email) {
  nombre = String(nombre || '').trim().slice(0, 60);
  email = String(email || '').trim().toLowerCase();
  if (!nombre) throw new Error('falta el nombre');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('el mail no es válido');
  return { nombre, email };
}

function conLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function agregarAdmin_(body) {
  soloPrincipal_(body.pin);
  const d = validarDatosAdmin_(body.nombre, body.email);
  return conLock_(() => {
    const lista = admins_();
    const codigo = generarCodigo_(lista);
    const sal = nuevoId_();
    lista.push({ id: nuevoId_(), nombre: d.nombre, email: d.email, sal, hash: hash_(codigo, sal), principal: false });
    guardarAdmins_(lista);
    return { ok: true, codigo, admins: lista.map(publico_) };
  });
}

function editarAdmin_(body) {
  soloPrincipal_(body.pin);
  const d = validarDatosAdmin_(body.nombre, body.email);
  return conLock_(() => {
    const lista = admins_();
    const a = lista.find((x) => x.id === body.id);
    if (!a) throw new Error('ese administrador ya no existe');
    a.nombre = d.nombre;
    a.email = d.email;
    guardarAdmins_(lista);
    return { ok: true, admins: lista.map(publico_) };
  });
}

function quitarAdmin_(body) {
  soloPrincipal_(body.pin);
  return conLock_(() => {
    const lista = admins_();
    const a = lista.find((x) => x.id === body.id);
    if (!a) throw new Error('ese administrador ya no existe');
    if (a.principal) throw new Error('no se puede quitar al administrador principal');
    const quedan = lista.filter((x) => x.id !== body.id);
    guardarAdmins_(quedan);
    return { ok: true, admins: quedan.map(publico_) };
  });
}

/** Reemplaza el código de un administrador (lo perdió, o se sospecha que otro lo sabe). */
function nuevoCodigoAdmin_(body) {
  soloPrincipal_(body.pin);
  return conLock_(() => {
    const lista = admins_();
    const a = lista.find((x) => x.id === body.id);
    if (!a) throw new Error('ese administrador ya no existe');
    const codigo = generarCodigo_(lista);
    a.sal = nuevoId_();
    a.hash = hash_(codigo, a.sal);
    guardarAdmins_(lista);
    return { ok: true, codigo, admins: lista.map(publico_) };
  });
}

/** Mails de todos los administradores (sin repetir); si no hay, el del dueño. */
function mailsAdmins_() {
  const mails = [];
  admins_().forEach((a) => { if (a.email && mails.indexOf(a.email) === -1) mails.push(a.email); });
  return mails.length ? mails.join(',') : Session.getEffectiveUser().getEmail();
}

/** Emergencia: si el administrador principal perdió su código, ejecutar esto desde el editor
 *  de Apps Script. Borra TODOS los administradores; el primero que entre desde la app crea
 *  un código nuevo y queda como principal (hacerlo enseguida). */
function reiniciarAdministradores() {
  props_().deleteProperty('ADMINS');
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

function leerFinalizadas_(ss) {
  const sh = ss.getSheetByName('Cargas');
  const mapa = {};
  const n = sh.getLastRow();
  if (n < 2) return mapa;
  sh.getRange(2, 1, n - 1, COLS_CARGAS.length).getValues().forEach((f) => {
    const fecha = iso_(f[0]);
    if (!mapa[fecha]) mapa[fecha] = { fecha, usuario: String(f[1]), ts: Number(f[5]) };
  });
  return mapa;
}

function guardar_(body) {
  const ops = Array.isArray(body.ops) ? body.ops : [];
  const admin = adminDe_(body.pin);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActive();
    const shD = ss.getSheetByName('Datos');
    const shR = ss.getSheetByName('Registro');
    const shC = ss.getSheetByName('Cargas');
    const mapa = leerDatos_(shD);
    const finalizadas = leerFinalizadas_(ss);
    const ahora = new Date();
    const hoy = Utilities.formatDate(ahora, ZONA, 'yyyy-MM-dd');
    const resultados = [];
    const log = [];
    const cargasNuevas = [];
    const avisarFinalizada = [];
    const tocados = {};

    ops.forEach((op) => {
      const fecha = String(op.fecha || '');
      const esFinalizar = op.tipo === 'finalizar';
      const corral = esFinalizar ? '' : Number(op.corral);
      const score = esFinalizar || op.score == null ? null : Number(op.score);
      const ts = Number(op.ts);
      const usuario = admin ? admin.nombre + ' (admin)' : String(op.usuario || '');
      const horaTel = isFinite(ts) ? Utilities.formatDate(new Date(ts), ZONA, 'dd/MM/yyyy HH:mm:ss') : '';
      const registrar = (accion, resultado) =>
        log.push([ahora, fecha, corral, score == null ? '' : score, lectura_(score), accion, usuario, horaTel, resultado]);

      const valido = /^\d{4}-\d{2}-\d{2}$/.test(fecha) && isFinite(ts) && (esFinalizar ||
        (Number.isInteger(corral) && corral >= 1 && (score === null || (Number.isInteger(score) && score >= 1 && score <= 9))));
      if (!valido) {
        registrar('—', 'Rechazado: dato inválido');
        resultados.push({ id: op.id, estado: 'rechazado' });
        return;
      }
      const diaTelefono = Utilities.formatDate(new Date(ts), ZONA, 'yyyy-MM-dd');
      const futuro = fecha > hoy || ts > ahora.getTime() + 15 * 60 * 1000;
      const rechazo = futuro ? 'Rechazado: fecha futura'
        : (!admin && fecha !== diaTelefono) ? 'Rechazado: día anterior (solo un administrador puede corregirlo)' : '';

      if (esFinalizar) {
        if (finalizadas[fecha]) {                 // ya estaba (otro teléfono, o un reenvío)
          resultados.push({ id: op.id, estado: 'duplicado' });
          return;
        }
        if (rechazo) {
          registrar('Finalizar carga', rechazo);
          resultados.push({ id: op.id, estado: 'rechazado' });
          return;
        }
        finalizadas[fecha] = { fecha, usuario, ts };
        cargasNuevas.push({ fecha, usuario, horaTel, ts });
        avisarFinalizada.push(fecha);
        registrar('Finalizar carga', 'Aplicado');
        resultados.push({ id: op.id, estado: 'aplicado' });
        return;
      }

      const k = fecha + '|' + corral;
      const ex = mapa[k];
      if (ex && ex.id === String(op.id)) {       // reenvío de algo que ya había llegado
        resultados.push({ id: op.id, estado: 'duplicado' });
        return;
      }
      const accion = score == null ? 'Borrado' : (ex && ex.score != null ? 'Modificación' : 'Carga');
      if (rechazo) {
        registrar(accion, rechazo);
        resultados.push({ id: op.id, estado: 'rechazado' });
        return;
      }
      if (ex && ex.ts > ts) {
        registrar(accion, 'Ignorado: ya había un cambio más nuevo');
        resultados.push({ id: op.id, estado: 'ignorado' });
        return;
      }
      // Un cambio sobre un día ya finalizado es una corrección: queda marcado para avisar.
      mapa[k] = {
        fila: ex ? ex.fila : null, fecha, corral, score, ts, usuario, id: String(op.id),
        aviso: !!finalizadas[fecha],
      };
      tocados[k] = true;
      registrar(accion + (finalizadas[fecha] ? ' (corrección)' : ''), 'Aplicado');
      resultados.push({ id: op.id, estado: 'aplicado' });
    });

    // Al finalizar se avisa en el momento con el día completo: las marcas de corrección
    // de ese día quedan cubiertas por este mismo aviso.
    avisarFinalizada.forEach((fecha) => {
      Object.keys(mapa).forEach((k) => {
        const r = mapa[k];
        if (r.fecha === fecha && r.aviso) { r.aviso = false; tocados[k] = true; }
      });
    });

    const nuevas = [];
    Object.keys(tocados).forEach((k) => {
      const r = mapa[k];
      if (r.fila) shD.getRange(r.fila, 1, 1, COLS_DATOS.length).setValues([filaDatos_(r)]);
      else nuevas.push(filaDatos_(r));
    });
    if (nuevas.length) shD.getRange(shD.getLastRow() + 1, 1, nuevas.length, COLS_DATOS.length).setValues(nuevas);
    if (log.length) shR.getRange(shR.getLastRow() + 1, 1, log.length, COLS_REGISTRO.length).setValues(log);
    if (cargasNuevas.length) {
      const corrales = leerCorrales_(ss).filter((c) => c.activo).map((c) => c.numero);
      shC.getRange(shC.getLastRow() + 1, 1, cargasNuevas.length, COLS_CARGAS.length).setValues(cargasNuevas.map((c) => [
        c.fecha, c.usuario, c.horaTel, ahora,
        corrales.filter((n) => mapa[c.fecha + '|' + n] && mapa[c.fecha + '|' + n].score != null).length + ' de ' + corrales.length,
        c.ts,
      ]));
    }
    if (Object.keys(tocados).length) reconstruirPlanilla_(ss, mapa);
    avisarFinalizada.forEach((fecha) => {
      try { enviarMail_(ss, mapa, fecha, 'finalizada', finalizadas[fecha]); }
      catch (e) { console.error('No se pudo mandar el aviso: ' + e); }   // el guardado ya quedó hecho
    });
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
  const fin = leerFinalizadas_(ss);
  const finalizadas = Object.keys(fin).filter((f) => f >= desde).map((f) => fin[f]);
  return { ok: true, registros, finalizadas, corrales: leerCorrales_(ss) };
}

function guardarCorrales_(body) {
  if (!adminDe_(body.pin)) return { ok: false, error: 'solo un administrador puede cambiar los corrales' };
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
// Dos avisos, siempre a todos los administradores:
//   - "Carga finalizada": sale en el momento en que llega la finalización (guardar_).
//   - "Corrección": cambios sobre un día ya finalizado. Los junta el disparador cada
//     10 minutos y espera 5 min sin cambios, para no mandar un mail por cada corral.

function enviarMail_(ss, mapa, fecha, tipo, info) {
  const corrales = leerCorrales_(ss).filter((c) => c.activo).map((c) => c.numero);
  const hora = (ts) => Utilities.formatDate(new Date(ts), ZONA, 'HH:mm');
  const cabecera = tipo === 'finalizada'
    ? 'Carga finalizada por ' + info.usuario + ' a las ' + hora(info.ts)
    : 'Corrección hecha por ' + info.quienes.join(', ') + ' (última a las ' + hora(info.ts) + ')';
  const sinCargar = corrales.filter((n) => !(mapa[fecha + '|' + n] && mapa[fecha + '|' + n].score != null));
  let texto = cabecera + '\n';
  if (sinCargar.length) texto += 'Sin cargar: CORRAL ' + sinCargar.join(', ') + '\n';
  texto += '\n' + textoResumen_(mapa, corrales, fecha);
  MailApp.sendEmail({
    to: mailsAdmins_(),
    subject: 'Lectura de Comederos – ' + fechaLarga_(fecha) + (tipo === 'finalizada' ? ' – Carga finalizada' : ' – Corrección'),
    body: texto + '\n\nPlanilla: ' + ss.getUrl(),
    htmlBody: '<pre style="font-family:Consolas,Menlo,monospace;font-size:15px">' +
      texto.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>' +
      '<p><a href="' + ss.getUrl() + '">Abrir la planilla</a></p>',
  });
}

/** Lo ejecuta el disparador cada 10 minutos: avisa las correcciones de días ya finalizados. */
function enviarAvisos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const ss = SpreadsheetApp.getActive();
    const shD = ss.getSheetByName('Datos');
    const mapa = leerDatos_(shD);
    const pendientes = Object.keys(mapa).map((k) => mapa[k]).filter((r) => r.aviso);
    if (!pendientes.length) return;
    const finalizadas = leerFinalizadas_(ss);
    const porFecha = {};
    pendientes.forEach((r) => { (porFecha[r.fecha] = porFecha[r.fecha] || []).push(r); });
    const ahora = Date.now();

    Object.keys(porFecha).sort().forEach((fecha) => {
      const filas = porFecha[fecha];
      if (!finalizadas[fecha]) return;   // (no debería pasar: solo se marcan días finalizados)
      // Si siguen corrigiendo (último cambio hace menos de 5 min), esperar a la próxima vuelta.
      const ultimo = Math.max.apply(null, filas.map((r) => r.ts));
      if (ahora - ultimo < 5 * 60 * 1000) return;
      const quienes = [];
      filas.forEach((r) => { if (r.usuario && quienes.indexOf(r.usuario) === -1) quienes.push(r.usuario); });
      enviarMail_(ss, mapa, fecha, 'correccion', { quienes, ts: ultimo });
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
