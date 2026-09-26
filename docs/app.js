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

const VERSION = '1.1.0';
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
  for (const id of ['cargar', 'resumen', 'historial', 'grafico', 'menu']) $('v-' + id).classList.toggle('oculto', id !== v);
  document.querySelectorAll('.menu-inferior button').forEach((b) => b.classList.toggle('activo', b.dataset.vista === (v === 'grafico' ? 'historial' : v)));
  document.querySelector('.fecha-fila').classList.toggle('oculto', v !== 'cargar' && v !== 'resumen');
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
  renderInstalar();
  if (estado.vista === 'cargar') renderCargar();
  else if (estado.vista === 'resumen') renderResumen();
  else if (estado.vista === 'historial') renderHistorial();
  else if (estado.vista === 'grafico') renderGrafico();
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
    html += '<tr><td class="celda-corral" data-corral="' + c.numero + '">CORRAL ' + c.numero + ' 📈</td>' + dias.map((d) => {
      const s = scoreDe(d, c.numero);
      return s != null ? '<td class="s' + s + '">' + fmtScore(s) + '</td>' : '<td class="vacio">—</td>';
    }).join('') + '</tr>';
  }
  $('historial-tabla').innerHTML = html;
  $('historial-tabla').querySelectorAll('th[data-fecha]').forEach((th) => {
    th.onclick = () => { irAFecha(th.dataset.fecha); irAVista('cargar'); };
  });
  $('historial-tabla').querySelectorAll('td[data-corral]').forEach((td) => {
    td.onclick = () => abrirGrafico(Number(td.dataset.corral));
  });
  $('historial-nota').textContent = 'Tocá un corral para ver su gráfico, o una fecha para ir a ese día.' +
    (SCRIPT_URL ? ' El historial completo está en el Google Sheet.' : '');
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

// ---------------------------------------------------------------- gráfico de un corral
// Línea del score día por día, dibujada a mano en SVG (sin bibliotecas, así anda
// offline). Los puntos llevan el color de su botón; los días sin carga cortan la
// línea en vez de unir puntos lejanos. Tocar o arrastrar sobre el gráfico muestra
// el valor de ese día arriba.
const COLOR_SCORE = { 1: '#F7C1C1', 2: '#F7C1C1', 3: '#FAC775', 4: '#FAC775', 5: '#E4E2DA', 6: '#C0DD97', 7: '#C0DD97', 8: '#9FE1CB', 9: '#9FE1CB' };
const grafico = { corral: null, dias: 30, sel: null };

function asegurarDias(n) {
  if (n > diasHistorial) { diasHistorial = n; sincronizar(); }
}

function abrirGrafico(n) {
  grafico.corral = n;
  grafico.sel = null;
  asegurarDias(grafico.dias);
  irAVista('grafico');
}

function detalleGrafico(p) {
  $('grafico-detalle').textContent = !p ? '' :
    fechaConDia(p.d) + ' · ' + (p.s != null ? fmtScore(p.s) : 'sin cargar');
}

function renderGrafico() {
  const n = grafico.corral;
  if (n == null) return;
  $('grafico-titulo').textContent = 'CORRAL ' + n;
  document.querySelectorAll('#grafico-rangos button').forEach((b) =>
    b.classList.toggle('activo', Number(b.dataset.dias) === grafico.dias));

  const hoy = hoyISO();
  const puntos = [];
  for (let i = grafico.dias - 1; i >= 0; i--) {
    const d = sumarDias(hoy, -i);
    puntos.push({ d, i: puntos.length, s: scoreDe(d, n) });
  }
  const conDato = puntos.filter((p) => p.s != null);
  if (grafico.sel == null || !puntos[grafico.sel]) grafico.sel = conDato.length ? conDato[conDato.length - 1].i : null;

  const promedio = conDato.length ? conDato.reduce((a, p) => a + p.s, 0) / conDato.length : null;
  $('grafico-stats').innerHTML =
    '<div><span>Días cargados</span><b>' + conDato.length + ' de ' + puntos.length + '</b></div>' +
    '<div><span>Score promedio</span><b>' + (promedio == null ? '—' : promedio.toFixed(1).replace('.', ',')) + '</b></div>';

  const cont = $('grafico-svg');
  if (!conDato.length) {
    cont.innerHTML = '<p class="nota centro" style="padding:40px 0">Sin scores cargados en este período.</p>';
    detalleGrafico(null);
    return;
  }

  const W = Math.max(300, cont.clientWidth || 340);
  const H = 320;
  const m = { l: 76, r: 16, t: 14, b: 38 };
  const paso = (W - m.l - m.r) / Math.max(1, puntos.length - 1);
  const x = (i) => m.l + i * paso;
  const y = (s) => m.t + (9 - s) * (H - m.t - m.b) / 8;
  const radio = puntos.length <= 30 ? 7 : 5;
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Score del corral ' + n + ' en los últimos ' + puntos.length + ' días">';

  // Eje del score: 1 a 9, con el 5 (0%) marcado como referencia.
  for (let v = 1; v <= 9; v++) {
    const es5 = v === 5;
    s += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="' + (es5 ? '#111' : '#e2e2e2') +
      '" stroke-width="' + (es5 ? 1.5 : 1) + '"' + (es5 ? ' stroke-dasharray="6 4"' : '') + '/>';
    s += '<text x="' + (m.l - 8) + '" y="' + (y(v) + 5) + '" text-anchor="end" font-size="14" font-weight="' + (es5 ? 800 : 600) +
      '" fill="#111">' + v + ' (' + pctTexto(v) + ')</text>';
  }
  // Fechas abajo: cada tantos días, contando desde hoy hacia atrás (hoy siempre rotulado).
  const cada = puntos.length <= 14 ? 3 : puntos.length <= 30 ? 7 : 14;
  for (let i = puntos.length - 1; i >= 0; i -= cada) {
    const f = fechaDe(puntos[i].d);
    const ancla = i === puntos.length - 1 ? 'end' : 'middle';
    s += '<text x="' + x(i) + '" y="' + (H - 12) + '" text-anchor="' + ancla + '" font-size="13" fill="#333">' +
      (i === puntos.length - 1 ? 'hoy' : f.getDate() + ' ' + MESES[f.getMonth()]) + '</text>';
  }
  // Cursor del día elegido (se mueve al tocar/arrastrar).
  s += '<line id="g-cursor" y1="' + m.t + '" y2="' + (H - m.b) + '" stroke="#111" stroke-width="1" stroke-dasharray="3 3"/>';
  // Línea: tramos entre días consecutivos con dato.
  let d = '';
  puntos.forEach((p, i) => {
    if (p.s == null) return;
    d += (i > 0 && puntos[i - 1].s != null ? 'L' : 'M') + x(i) + ' ' + y(p.s) + ' ';
  });
  s += '<path d="' + d + '" fill="none" stroke="#111" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
  s += '<circle id="g-anillo" r="' + (radio + 5) + '" fill="none" stroke="#111" stroke-width="2.5"/>';
  conDato.forEach((p) => {
    s += '<circle cx="' + x(p.i) + '" cy="' + y(p.s) + '" r="' + radio + '" fill="' + COLOR_SCORE[p.s] + '" stroke="#111" stroke-width="2"/>';
  });
  // Zona táctil de todo el gráfico, más grande que los puntos.
  s += '<rect id="g-toque" x="' + (m.l - paso / 2) + '" y="0" width="' + (W - m.l - m.r + paso) + '" height="' + H + '" fill="transparent"/>';
  s += '</svg>';
  cont.innerHTML = s;

  const svg = cont.querySelector('svg');
  const marcar = (i) => {
    grafico.sel = i;
    const p = puntos[i];
    const cursor = svg.querySelector('#g-cursor'), anillo = svg.querySelector('#g-anillo');
    cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i));
    anillo.style.display = p.s != null ? '' : 'none';
    if (p.s != null) { anillo.setAttribute('cx', x(i)); anillo.setAttribute('cy', y(p.s)); }
    detalleGrafico(p);
  };
  const desdeToque = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * W / r.width;
    marcar(Math.min(puntos.length - 1, Math.max(0, Math.round((px - m.l) / paso))));
  };
  const toque = svg.querySelector('#g-toque');
  toque.addEventListener('pointerdown', (ev) => { toque.setPointerCapture(ev.pointerId); desdeToque(ev); });
  toque.addEventListener('pointermove', (ev) => { if (ev.buttons || ev.pointerType === 'touch') desdeToque(ev); });
  marcar(grafico.sel);
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
async function llamarUnaVez(payload) {
  const r = await fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // evita el "preflight" CORS con Apps Script
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const texto = await r.text();
  try { return JSON.parse(texto); } catch (e) { throw new Error('respuesta inesperada de Google'); }
}

// Google a veces devuelve una página de error pasajera en vez de la respuesta:
// se reintenta hasta 2 veces antes de darlo por fallado. Reenviar es seguro,
// el script ignora un cambio que ya había recibido (mismo id).
async function llamar(payload) {
  let ultimoError;
  for (let intento = 0; intento < 3; intento++) {
    if (intento) await new Promise((res) => setTimeout(res, 1500 * intento));
    try {
      const j = await llamarUnaVez(payload);
      if (!j.ok) throw Object.assign(new Error(j.error || 'error del servidor'), { definitivo: true });
      return j;
    } catch (e) {
      ultimoError = e;
      if (e.definitivo) break;
    }
  }
  throw ultimoError;
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

// ---------------------------------------------------------------- instalar
// El botón aparece SIEMPRE que la app se abre en el navegador (no instalada), para
// cualquier usuario. Si Chrome ya ofreció instalar, instala directo; si todavía no
// (a veces tarda) o es iPhone, explica los pasos a mano.
let eventoInstalar = null;
const instalada = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const esIPhone = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const b_ = (t) => '<b style="font-size:inherit">' + t + '</b>';

function renderInstalar() {
  $('btn-instalar').classList.toggle('oculto', instalada());
}

async function instalar() {
  if (eventoInstalar) {
    eventoInstalar.prompt();
    const r = await eventoInstalar.userChoice;
    if (r.outcome === 'accepted') eventoInstalar = null;
    renderInstalar();
    return;
  }
  if (esIPhone()) {
    cartel({
      icono: '📲', titulo: 'Instalar en iPhone', no: '', si: 'Entendido',
      html: 'Abrí esta página en ' + b_('Safari') + ', tocá el botón de compartir ' +
        '(el cuadrado con la flecha) y elegí ' + b_('Agregar a inicio') + '.',
    });
    return;
  }
  cartel({
    icono: '📲', titulo: 'Instalar la app', no: '', si: 'Entendido',
    html: 'Tocá los ' + b_('tres puntitos ⋮') + ' de arriba a la derecha de Chrome y elegí ' +
      b_('Instalar aplicación') + ' (o ' + b_('Install and create shortcut') + ') → ' + b_('Instalar') + '.' +
      '<br><br>Si aparece la opción de acceso directo, elegí ' + b_('Instalar') + ', no el acceso directo.',
  });
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); eventoInstalar = e; renderInstalar(); });
window.addEventListener('appinstalled', () => { eventoInstalar = null; renderInstalar(); toast('App instalada'); });

// ---------------------------------------------------------------- arranque
function conectarEventos() {
  document.querySelectorAll('.menu-inferior button').forEach((b) => { b.onclick = () => irAVista(b.dataset.vista); });
  $('corral-ant').onclick = () => { estado.idx--; render(); };
  $('corral-sig').onclick = () => { estado.idx++; render(); };
  $('dia-ant').onclick = () => irAFecha(sumarDias(estado.fecha, -1));
  $('dia-sig').onclick = () => irAFecha(sumarDias(estado.fecha, 1));
  $('fecha-txt').onclick = () => irAFecha(hoyISO());
  $('btn-borrar').onclick = borrarScore;
  $('btn-instalar').onclick = instalar;
  $('grafico-volver').onclick = () => irAVista('historial');
  document.querySelectorAll('#grafico-rangos button').forEach((b) => {
    b.onclick = () => { grafico.dias = Number(b.dataset.dias); grafico.sel = null; asegurarDias(grafico.dias); render(); };
  });
  window.addEventListener('resize', () => { if (estado.vista === 'grafico') renderGrafico(); });
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
  if ('serviceWorker' in navigator) {
    // Si llega una versión nueva mientras la app está abierta, recargar una vez para mostrarla.
    const habiaVersion = !!navigator.serviceWorker.controller;
    let recargada = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (habiaVersion && !recargada) { recargada = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

iniciar();
