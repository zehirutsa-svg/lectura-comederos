'use strict';
// Lectura de Comederos — app offline para cargar el score de comedero por corral.
//
// Todo se guarda primero en el teléfono (localStorage) y cada cambio entra en
// una "cola" que se manda al Google Sheet (vía Apps Script, ver
// apps-script/Code.gs) cuando hay señal. El Sheet es la fuente de verdad: al
// sincronizar, la app baja lo que cargaron los demás teléfonos.
//
// Permisos: el operario solo puede cargar/modificar/borrar el día de HOY; el
// administrador (con código) puede tocar cualquier día. El script de Google
// vuelve a chequear lo mismo, así que no depende solo de la app.

const VERSION = '1.0.0';
const PCT = { 1: -7, 2: -5, 3: -3, 4: -2, 5: 0, 6: 2, 7: 3, 8: 5, 9: 7 };
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const DIAS_SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const CORRALES_INICIALES = 12;

// ---------------------------------------------------------------- almacenamiento
const LS = {
  get(k, def) {
    try { const v = localStorage.getItem('lc_' + k); return v === null ? def : JSON.parse(v); }
    catch (e) { return def; }
  },
  set(k, v) {
    try { localStorage.setItem('lc_' + k, JSON.stringify(v)); } catch (e) { /* sin espacio / bloqueado */ }
  },
};

let registros = LS.get('registros', {});   // 'AAAA-MM-DD|n' -> {fecha, corral, score|null, ts, usuario}
let cola = LS.get('cola', []);             // cambios todavía no enviados al Sheet
let corrales = LS.get('corrales', null) ||
  Array.from({ length: CORRALES_INICIALES }, (_, i) => ({ numero: i + 1, activo: true }));
let corralesPendientes = LS.get('corralesPendientes', false);
let usuario = LS.get('usuario', '');
let pinAdmin = LS.get('pinAdmin', '');
let ultimaSync = LS.get('ultimaSync', 0);
let diasHistorial = 14;

function guardarTodo() {
  LS.set('registros', registros);
  LS.set('cola', cola);
  LS.set('corrales', corrales);
  LS.set('corralesPendientes', corralesPendientes);
  LS.set('usuario', usuario);
  LS.set('pinAdmin', pinAdmin);
  LS.set('ultimaSync', ultimaSync);
}

// ---------------------------------------------------------------- utilidades
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const isoDe = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const hoyISO = () => isoDe(new Date());
function fechaDe(iso) { const [a, m, d] = iso.split('-').map(Number); return new Date(a, m - 1, d); }
function sumarDias(iso, n) { const d = fechaDe(iso); d.setDate(d.getDate() + n); return isoDe(d); }
function fechaLarga(iso) { const d = fechaDe(iso); return pad(d.getDate()) + ' ' + MESES[d.getMonth()] + ' ' + d.getFullYear(); }
function fechaConDia(iso) { return DIAS_SEMANA[fechaDe(iso).getDay()] + ' ' + fechaLarga(iso); }
function pctTexto(s) { const p = PCT[s]; return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p) + '%'; }
function fmtScore(s) { return s + ' (' + pctTexto(s) + ')'; }
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
const clave = (f, n) => f + '|' + n;
function scoreDe(f, n) { const r = registros[clave(f, n)]; return r && r.score != null ? r.score : null; }
const esAdmin = () => !!pinAdmin;
const puedeEditar = (f) => esAdmin() || f === hoyISO();
function corralesActivos() { return corrales.filter((c) => c.activo).sort((a, b) => a.numero - b.numero); }

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('oculto');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('oculto'), ms);
}

// ---------------------------------------------------------------- estado de pantalla
const estado = {
  fecha: hoyISO(),
  siguiendoHoy: true,   // si la app queda abierta de un día para otro, pasa sola al día nuevo
  idx: 0,
  vista: 'cargar',
  sincronizando: false,
  errorSync: '',
};

function primerCorralSinCargar(fecha) {
  const lista = corralesActivos();
  const i = lista.findIndex((c) => scoreDe(fecha, c.numero) == null);
  return i === -1 ? 0 : i;
}

function irAFecha(fecha) {
  const hoy = hoyISO();
  if (fecha > hoy) fecha = hoy;
  estado.fecha = fecha;
  estado.siguiendoHoy = fecha === hoy;
  estado.idx = primerCorralSinCargar(fecha);
  render();
}

function irAVista(v) {
  estado.vista = v;
  for (const id of ['cargar', 'resumen', 'historial', 'menu']) $('v-' + id).classList.toggle('oculto', id !== v);
  document.querySelectorAll('.menu-inferior button').forEach((b) => b.classList.toggle('activo', b.dataset.vista === v));
  document.querySelector('main').scrollTop = 0;
  render();
}

// ---------------------------------------------------------------- cartel (modal)
function cartel({ icono = '', titulo = '', html = '', si = 'Aceptar', no = 'Cancelar', peligro = false, input = null, validar = null }) {
  return new Promise((resolve) => {
    $('modal-icono').textContent = icono;
    $('modal-titulo').textContent = titulo;
    $('modal-texto').innerHTML = html;
    $('modal-error').textContent = '';
    const inp = $('modal-input');
    inp.classList.toggle('oculto', !input);
    if (input) {
      inp.type = input.tipo || 'text';
      inp.inputMode = input.modo || 'text';
      inp.placeholder = input.placeholder || '';
      inp.value = input.valor || '';
    }
    const bSi = $('modal-si'), bNo = $('modal-no');
    bSi.textContent = si;
    bSi.classList.toggle('peligro', peligro);
    bNo.textContent = no || '';
    bNo.classList.toggle('oculto', !no);
    $('modal').classList.remove('oculto');
    if (input) setTimeout(() => inp.focus(), 50);

    const cerrar = (valor) => {
      $('modal').classList.add('oculto');
      bSi.onclick = bNo.onclick = inp.onkeydown = null;
      resolve(valor);
    };
    bNo.onclick = () => cerrar(false);
    bSi.onclick = async () => {
      const valor = input ? inp.value.trim() : true;
      if (validar) {
        bSi.disabled = true;
        const err = await validar(valor);
        bSi.disabled = false;
        if (err) { $('modal-error').textContent = err; return; }
      }
      cerrar(valor);
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') bSi.onclick(); };
  });
}

// ---------------------------------------------------------------- cambios
function registrarCambio(fecha, corral, score) {
  const op = { id: uid(), fecha, corral, score, ts: Date.now(), usuario };
  registros[clave(fecha, corral)] = { fecha, corral, score, ts: op.ts, usuario };
  cola.push(op);
  guardarTodo();
  programarSync(2500);
}

function avanzar() {
  const lista = corralesActivos();
  if (estado.idx < lista.length - 1) {
    setTimeout(() => { estado.idx++; render(); }, 250);
  } else if (lista.every((c) => scoreDe(estado.fecha, c.numero) != null)) {
    setTimeout(() => { toast('Todos los corrales cargados'); irAVista('resumen'); }, 350);
  }
}

async function tocarScore(s) {
  const f = estado.fecha;
  if (!puedeEditar(f)) { toast('Solo se puede modificar el día de hoy'); return; }
  const corral = corralesActivos()[estado.idx];
  if (!corral) return;
  const actual = scoreDe(f, corral.numero);
  if (actual === s) return;
  if (actual != null) {
    const ok = await cartel({
      icono: '⚠️',
      titulo: '¿Modificar score?',
      html: 'El CORRAL ' + corral.numero + ' ya tiene<br><b>' + fmtScore(actual) + '</b><br>y va a pasar a<br><b>' + fmtScore(s) + '</b>',
      si: 'Modificar',
    });
    if (!ok) return;
  }
  registrarCambio(f, corral.numero, s);
  render();
  avanzar();
}

async function borrarScore() {
  const f = estado.fecha;
  const corral = corralesActivos()[estado.idx];
  if (!corral || !puedeEditar(f)) return;
  const actual = scoreDe(f, corral.numero);
  if (actual == null) return;
  const ok = await cartel({
    icono: '🗑',
    titulo: '¿Borrar score?',
    html: 'Se va a borrar<br><b>' + fmtScore(actual) + '</b><br>del CORRAL ' + corral.numero + '<br>y queda sin cargar.',
    si: 'Borrar',
    peligro: true,
  });
  if (!ok) return;
  registrarCambio(f, corral.numero, null);
  render();
}

// ---------------------------------------------------------------- dibujar pantallas
function render() {
  const hoy = hoyISO();
  if (estado.siguiendoHoy && estado.fecha !== hoy) { estado.fecha = hoy; estado.idx = primerCorralSinCargar(hoy); }
  const esHoy = estado.fecha === hoy;
  $('fecha-txt').textContent = esHoy ? 'Hoy · ' + fechaLarga(estado.fecha) : fechaConDia(estado.fecha);
  $('fecha-txt').classList.toggle('otro-dia', !esHoy);
  $('dia-sig').disabled = esHoy;

  renderSync();
  if (estado.vista === 'cargar') renderCargar();
  else if (estado.vista === 'resumen') renderResumen();
  else if (estado.vista === 'historial') renderHistorial();
  else if (estado.vista === 'menu') renderMenu();
}

function renderCargar() {
  const lista = corralesActivos();
  if (!lista.length) { $('corral-num').textContent = '—'; $('botones').innerHTML = ''; return; }
  estado.idx = Math.min(Math.max(estado.idx, 0), lista.length - 1);
  const corral = lista[estado.idx];
  const f = estado.fecha;
  const actual = scoreDe(f, corral.numero);
  const editable = puedeEditar(f);

  $('corral-num').textContent = corral.numero;
  $('corral-ant').disabled = estado.idx === 0;
  $('corral-sig').disabled = estado.idx === lista.length - 1;
  $('score-actual').textContent = actual != null ? fmtScore(actual) : '—';
  $('aviso-bloqueo').classList.toggle('oculto', editable);
  $('btn-borrar').classList.toggle('invisible', !(editable && actual != null));

  const cont = $('botones');
  cont.innerHTML = '';
  for (let s = 1; s <= 9; s++) {
    const b = document.createElement('button');
    b.className = 'btn-score s' + s + (actual === s ? ' sel' : '');
    b.innerHTML = '<b>' + s + '</b><span>' + pctTexto(s) + '</span>';
    b.disabled = !editable;
    b.onclick = () => tocarScore(s);
    cont.appendChild(b);
  }
  const cargados = lista.filter((c) => scoreDe(f, c.numero) != null).length;
  $('progreso').textContent = cargados + ' de ' + lista.length + ' corrales cargados';
}

function renderResumen() {
  const f = estado.fecha;
  $('resumen-titulo').textContent = 'Resumen · ' + fechaLarga(f);
  const cont = $('resumen-lista');
  cont.innerHTML = '';
  corralesActivos().forEach((c, i) => {
    const s = scoreDe(f, c.numero);
    const b = document.createElement('button');
    b.className = 'fila-resumen';
    b.innerHTML = '<b>CORRAL ' + c.numero + '</b>' + (s != null ? '<span>' + fmtScore(s) + '</span>' : '<span class="vacio">—</span>');
    b.onclick = () => { estado.idx = i; irAVista('cargar'); };
    cont.appendChild(b);
  });
}

function renderHistorial() {
  const hoy = hoyISO();
  const dias = [];
  for (let i = 0; i < diasHistorial; i++) dias.push(sumarDias(hoy, -i));
  let html = '<tr><th>Corral</th>' + dias.map((d) => {
    const x = fechaDe(d);
    return '<th data-fecha="' + d + '">' + DIAS_SEMANA[x.getDay()] + '<br>' + x.getDate() + ' ' + MESES[x.getMonth()] + '</th>';
  }).join('') + '</tr>';
  for (const c of corralesActivos()) {
    html += '<tr><td>CORRAL ' + c.numero + '</td>' + dias.map((d) => {
      const s = scoreDe(d, c.numero);
      return s != null ? '<td class="s' + s + '">' + fmtScore(s) + '</td>' : '<td class="vacio">—</td>';
    }).join('') + '</tr>';
  }
  $('historial-tabla').innerHTML = html;
  $('historial-tabla').querySelectorAll('th[data-fecha]').forEach((th) => {
    th.onclick = () => { irAFecha(th.dataset.fecha); irAVista('cargar'); };
  });
  $('historial-nota').textContent = SCRIPT_URL
    ? 'Tocá una fecha para verla. El historial completo está en el Google Sheet.'
    : 'Datos guardados en este teléfono. Tocá una fecha para verla.';
}

function renderMenu() {
  $('menu-usuario').textContent = usuario || '(sin nombre)';
  $('menu-admin-estado').textContent = esAdmin() ? 'Activado: puede corregir cualquier día' : 'Desactivado';
  $('btn-admin').textContent = esAdmin() ? 'Salir del modo administrador' : 'Entrar con código';
  $('tarjeta-corrales').classList.toggle('oculto', !esAdmin());
  if (esAdmin()) {
    const cont = $('lista-corrales');
    cont.innerHTML = '';
    [...corrales].sort((a, b) => a.numero - b.numero).forEach((c) => {
      const fila = document.createElement('div');
      fila.className = 'fila-corral' + (c.activo ? '' : ' inactivo');
      fila.innerHTML = '<span>CORRAL ' + c.numero + '</span>';
      const b = document.createElement('button');
      b.className = 'btn-secundario';
      b.textContent = c.activo ? 'Quitar' : 'Volver a usar';
      b.onclick = () => cambiarCorral(c.numero);
      fila.appendChild(b);
      cont.appendChild(fila);
    });
  }
  let txt = SCRIPT_URL ? '' : 'Google Sheet todavía no configurado: los datos quedan solo en este teléfono.';
  if (SCRIPT_URL) {
    txt = ultimaSync ? 'Última sincronización: ' + fechaLarga(isoDe(new Date(ultimaSync))) + ' ' +
      pad(new Date(ultimaSync).getHours()) + ':' + pad(new Date(ultimaSync).getMinutes()) : 'Todavía no se sincronizó.';
    if (cola.length) txt += ' · ' + cola.length + ' cambio(s) sin enviar.';
    if (estado.errorSync) txt += ' · Último error: ' + estado.errorSync;
  }
  $('menu-sync').textContent = txt;
  $('version').textContent = 'Versión ' + VERSION;
}

function renderSync() {
  const el = $('estado-sync');
  let txt, cls;
  if (!SCRIPT_URL) { txt = 'Solo en el teléfono'; cls = 'off'; }
  else if (estado.sincronizando) { txt = '⟳ Enviando…'; cls = 'pend'; }
  else if (cola.length) { txt = '⏳ ' + cola.length + ' sin enviar'; cls = 'pend'; }
  else if (!navigator.onLine) { txt = 'Sin señal'; cls = 'off'; }
  else if (estado.errorSync) { txt = '⚠ Sin conexión'; cls = 'off'; }
  else { txt = '✓ Enviado'; cls = 'ok'; }
  el.textContent = txt;
  el.className = 'sync ' + cls;
}

// ---------------------------------------------------------------- WhatsApp
function textoWhatsApp(fecha) {
  const lista = corralesActivos();
  const lineas = ['📋 *LECTURA DE COMEDEROS*', '*' + fechaConDia(fecha) + '*', ''];
  for (const c of lista) {
    const s = scoreDe(fecha, c.numero);
    lineas.push('CORRAL ' + c.numero + ': ' + (s != null ? fmtScore(s) : '—'));
  }
  const quienes = [...new Set(lista.map((c) => registros[clave(fecha, c.numero)])
    .filter((r) => r && r.score != null && r.usuario).map((r) => r.usuario))];
  if (quienes.length) lineas.push('', 'Cargó: ' + quienes.join(', '));

  const dias = [];
  for (let i = 6; i >= 0; i--) dias.push(sumarDias(fecha, -i));
  const ancho = Math.max(...lista.map((c) => ('CORRAL ' + c.numero).length));
  lineas.push('', '*Últimos 7 días*', '```');
  lineas.push(' '.repeat(ancho) + dias.map((d) => String(fechaDe(d).getDate()).padStart(3)).join(''));
  for (const c of lista) {
    lineas.push(('CORRAL ' + c.numero).padEnd(ancho) +
      dias.map((d) => { const s = scoreDe(d, c.numero); return (s != null ? String(s) : '-').padStart(3); }).join(''));
  }
  lineas.push('```');
  return lineas.join('\n');
}

async function copiarTexto(texto) {
  try { await navigator.clipboard.writeText(texto); return true; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = texto; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* nada */ }
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------- sincronización
async function llamar(payload) {
  const r = await fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // evita el "preflight" CORS con Apps Script
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'error del servidor');
  return j;
}

function aplicarDatosServidor(d, desde) {
  const pendientes = new Set(cola.map((o) => clave(o.fecha, o.corral)));
  for (const k of Object.keys(registros)) {
    if (registros[k].fecha >= desde && !pendientes.has(k)) delete registros[k];
  }
  for (const r of d.registros || []) {
    const k = clave(r.fecha, r.corral);
    if (!pendientes.has(k)) registros[k] = r;
  }
  if (!corralesPendientes && d.corrales && d.corrales.length) corrales = d.corrales;
}

async function sincronizar() {
  if (!SCRIPT_URL || estado.sincronizando) { renderSync(); return; }
  if (!navigator.onLine) { renderSync(); return; }
  estado.sincronizando = true;
  renderSync();
  try {
    if (corralesPendientes && pinAdmin) {
      await llamar({ accion: 'corrales', pin: pinAdmin, corrales });
      corralesPendientes = false;
      guardarTodo();
    }
    let rechazados = 0;
    while (cola.length) {
      const lote = cola.slice(0, 100);
      const res = await llamar({ accion: 'guardar', pin: pinAdmin, ops: lote });
      const ids = new Set(lote.map((o) => o.id));
      cola = cola.filter((o) => !ids.has(o.id));
      rechazados += (res.resultados || []).filter((x) => x.estado === 'rechazado').length;
      guardarTodo();
    }
    if (rechazados) {
      cartel({
        icono: '⚠️', titulo: 'Cambios no guardados', no: '', si: 'Entendido',
        html: rechazados + ' cambio(s) no se guardaron en el Sheet porque eran de un día anterior. ' +
          'Solo el administrador puede corregir días pasados.',
      });
    }
    const desde = sumarDias(hoyISO(), -(diasHistorial + 7));
    const d = await llamar({ accion: 'datos', desde });
    aplicarDatosServidor(d, desde);
    ultimaSync = Date.now();
    estado.errorSync = '';
    guardarTodo();
  } catch (e) {
    estado.errorSync = String((e && e.message) || e);
  } finally {
    estado.sincronizando = false;
    render();
  }
}

let syncTimer = null;
function programarSync(ms) {
  renderSync();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sincronizar, ms);
}

// ---------------------------------------------------------------- menú
async function pedirNombre(obligatorio) {
  const nombre = await cartel({
    icono: '👤',
    titulo: obligatorio ? '¡Hola!' : 'Cambiar nombre',
    html: '¿Quién va a cargar en este teléfono?',
    input: { placeholder: 'Nombre del operario', valor: usuario },
    si: 'Guardar',
    no: obligatorio ? '' : 'Cancelar',
    validar: (v) => (v ? '' : 'Escribí un nombre.'),
  });
  if (nombre) { usuario = nombre; guardarTodo(); render(); }
}

async function alternarAdmin() {
  if (esAdmin()) {
    const ok = await cartel({ icono: '🔒', titulo: 'Salir del modo administrador', html: 'Este teléfono vuelve a poder modificar solo el día de hoy.', si: 'Salir' });
    if (ok) { pinAdmin = ''; guardarTodo(); irAFecha(hoyISO()); render(); }
    return;
  }
  if (!SCRIPT_URL) { toast('El Google Sheet todavía no está configurado'); return; }
  if (!navigator.onLine) { toast('Hace falta señal para entrar como administrador'); return; }
  let definido;
  try { definido = (await llamar({ accion: 'verificarPin', pin: '' })).definido; }
  catch (e) { toast('No se pudo conectar: ' + e.message); return; }
  if (!definido) { await crearCodigoAdmin(); return; }

  const pin = await cartel({
    icono: '🔑',
    titulo: 'Modo administrador',
    html: 'Ingresá el código de administrador.',
    input: { tipo: 'password', modo: 'numeric', placeholder: 'Código' },
    si: 'Entrar',
    validar: async (v) => {
      if (!v) return 'Ingresá el código.';
      try {
        const r = await llamar({ accion: 'verificarPin', pin: v });
        return r.valido ? '' : 'Código incorrecto.';
      } catch (e) { return 'No se pudo verificar: ' + e.message; }
    },
  });
  if (pin) { pinAdmin = pin; guardarTodo(); toast('Modo administrador activado'); render(); }
}

// La primera vez no hay código: se crea desde acá y queda guardado en Google.
async function crearCodigoAdmin() {
  const pin = await cartel({
    icono: '🔑',
    titulo: 'Crear código de administrador',
    html: 'Todavía no hay código. Elegí uno de <b style="font-size:inherit">4 a 8 números</b>. ' +
      'Con él vas a poder corregir cualquier día.',
    input: { tipo: 'password', modo: 'numeric', placeholder: 'Código nuevo' },
    si: 'Seguir',
    validar: (v) => (/^\d{4,8}$/.test(v) ? '' : 'Tienen que ser de 4 a 8 números.'),
  });
  if (!pin) return;
  const ok = await cartel({
    icono: '🔑',
    titulo: 'Repetí el código',
    html: 'Para confirmar, escribilo otra vez.',
    input: { tipo: 'password', modo: 'numeric', placeholder: 'Código' },
    si: 'Guardar',
    validar: async (v) => {
      if (v !== pin) return 'No coincide con el anterior.';
      try { await llamar({ accion: 'definirPin', pin }); return ''; }
      catch (e) { return 'No se pudo guardar: ' + e.message; }
    },
  });
  if (ok) { pinAdmin = pin; guardarTodo(); toast('Código creado. Modo administrador activado'); render(); }
}

function cambiarCorral(numero) {
  const c = corrales.find((x) => x.numero === numero);
  if (!c) return;
  c.activo = !c.activo;
  corralesPendientes = true;
  guardarTodo();
  programarSync(500);
  render();
}

async function agregarCorral() {
  const siguiente = Math.max(0, ...corrales.map((c) => c.numero)) + 1;
  const ok = await cartel({ icono: '➕', titulo: 'Agregar corral', html: 'Se agrega el <b>CORRAL ' + siguiente + '</b>.', si: 'Agregar' });
  if (!ok) return;
  corrales.push({ numero: siguiente, activo: true });
  corralesPendientes = true;
  guardarTodo();
  programarSync(500);
  render();
}

// ---------------------------------------------------------------- arranque
function conectarEventos() {
  document.querySelectorAll('.menu-inferior button').forEach((b) => { b.onclick = () => irAVista(b.dataset.vista); });
  $('corral-ant').onclick = () => { estado.idx--; render(); };
  $('corral-sig').onclick = () => { estado.idx++; render(); };
  $('dia-ant').onclick = () => irAFecha(sumarDias(estado.fecha, -1));
  $('dia-sig').onclick = () => irAFecha(sumarDias(estado.fecha, 1));
  $('fecha-txt').onclick = () => irAFecha(hoyISO());
  $('btn-borrar').onclick = borrarScore;
  $('btn-whatsapp').onclick = () => {
    window.open('https://wa.me/?text=' + encodeURIComponent(textoWhatsApp(estado.fecha)), '_blank');
  };
  $('btn-copiar').onclick = async () => {
    toast((await copiarTexto(textoWhatsApp(estado.fecha))) ? 'Texto copiado' : 'No se pudo copiar');
  };
  $('btn-mas-dias').onclick = () => { diasHistorial += 14; render(); sincronizar(); };
  $('btn-cambiar-usuario').onclick = () => pedirNombre(false);
  $('btn-admin').onclick = alternarAdmin;
  $('btn-agregar-corral').onclick = agregarCorral;
  $('btn-sync').onclick = () => {
    if (!SCRIPT_URL) { toast('El Google Sheet todavía no está configurado'); return; }
    if (!navigator.onLine) { toast('No hay señal'); return; }
    sincronizar();
  };
  window.addEventListener('online', () => sincronizar());
  window.addEventListener('offline', renderSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { render(); sincronizar(); }
  });
  setInterval(() => { if (document.visibilityState === 'visible') sincronizar(); }, 60000);
}

function iniciar() {
  conectarEventos();
  estado.idx = primerCorralSinCargar(estado.fecha);
  render();
  setTimeout(() => {
    $('splash').classList.add('fuera');
    if (!usuario) pedirNombre(true);
  }, 800);
  sincronizar();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

iniciar();
