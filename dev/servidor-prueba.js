// Servidor de PRUEBA local (no se publica). Sirve la carpeta docs/ (la app) y simula el
// Apps Script: carga apps-script/Code.gs tal cual, con un Google Sheet falso en
// memoria, para probar la sincronización sin tocar Google.
//
//   node dev/servidor-prueba.js [puerto]
//
// GET /_hojas  -> muestra el contenido de las hojas simuladas (JSON).
// GET /_avisos -> fuerza enviarAvisos() y devuelve los mails que "mandaría".
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUERTO = Number(process.argv[2]) || 8765;
const RAIZ = path.join(__dirname, '..', 'docs');

// ---------------------------------------------------------------- Google falso
function formatDate(fecha, zona, patron) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(fecha).forEach((x) => { p[x.type] = x.value; });
  return patron.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
    .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
}

class Rango {
  constructor(h, f, c, nf, nc) { Object.assign(this, { h, f, c, nf, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nf; i++) {
      const fila = [];
      for (let j = 0; j < this.nc; j++) {
        const v = (this.h.celdas[this.f - 1 + i] || [])[this.c - 1 + j];
        fila.push(v === undefined ? '' : v);
      }
      out.push(fila);
    }
    return out;
  }
  setValues(v) {
    v.forEach((fila, i) => fila.forEach((x, j) => {
      const r = this.f - 1 + i;
      this.h.celdas[r] = this.h.celdas[r] || [];
      this.h.celdas[r][this.c - 1 + j] = x instanceof Date ? x.toISOString() : x;
    }));
    return this;
  }
  setValue(x) { return this.setValues([[x]]); }
  clearContent() {
    for (let i = 0; i < this.nf; i++) {
      const fila = this.h.celdas[this.f - 1 + i];
      if (fila) for (let j = 0; j < this.nc; j++) fila[this.c - 1 + j] = '';
    }
    this.h.recortar();
    return this;
  }
}
['setFontWeight', 'setBackground', 'setBackgrounds', 'setNumberFormat', 'setHorizontalAlignment',
  'setVerticalAlignment', 'setFontSize'].forEach((m) => { Rango.prototype[m] = function () { return this; }; });

class Hoja {
  constructor(nombre) { this.nombre = nombre; this.celdas = []; }
  getName() { return this.nombre; }
  recortar() {
    while (this.celdas.length && !(this.celdas[this.celdas.length - 1] || []).some((x) => x !== '' && x !== undefined)) this.celdas.pop();
  }
  getLastRow() { this.recortar(); return this.celdas.length; }
  getRange(f, c, nf, nc) {
    if (typeof f === 'string') return new Rango(this, 1, 1, 1, 1);  // 'A:B' solo se usa para dar formato
    return new Rango(this, f, c, nf || 1, nc || 1);
  }
  clear() { this.celdas = []; }
}
['setFrozenRows', 'setFrozenColumns', 'setColumnWidth', 'setColumnWidths'].forEach((m) => { Hoja.prototype[m] = function () { return this; }; });

const hojas = [new Hoja('Hoja 1')];
const mails = [];
const libro = {
  getSheetByName: (n) => hojas.find((h) => h.nombre === n) || null,
  insertSheet: (n) => { const h = new Hoja(n); hojas.push(h); return h; },
  getSheets: () => hojas.slice(),
  deleteSheet: (h) => { hojas.splice(hojas.indexOf(h), 1); },
  setSpreadsheetTimeZone() {}, setActiveSheet() {}, moveActiveSheet() {},
  getUrl: () => 'https://docs.google.com/spreadsheets/d/PRUEBA',
};
const contexto = {
  SpreadsheetApp: { getActive: () => libro },
  Utilities: { formatDate },
  LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: (t) => ({ texto: t, setMimeType() { return this; } }),
  },
  ScriptApp: {
    getProjectTriggers: () => [],
    deleteTrigger() {},
    newTrigger: () => ({ timeBased() { return this; }, everyMinutes() { return this; }, create() {} }),
  },
  MailApp: { sendEmail: (m) => mails.push(m) },
  console,
};
vm.createContext(contexto);
const codigo = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8')
  .replace("const PIN_ADMIN = 'CAMBIAR';", "const PIN_ADMIN = '1234';");   // código de prueba
vm.runInContext(codigo + '\nthis.__api = { configurar, doPost, doGet, enviarAvisos };', contexto);
const api = contexto.__api;
api.configurar();

// ---------------------------------------------------------------- servidor
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api' && req.method === 'POST') {
    let cuerpo = '';
    req.on('data', (d) => { cuerpo += d; });
    req.on('end', () => {
      const r = api.doPost({ postData: { contents: cuerpo } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(r.texto);
    });
    return;
  }
  if (url.pathname === '/_hojas') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(Object.fromEntries(hojas.map((h) => [h.nombre, h.celdas])), null, 1));
    return;
  }
  if (url.pathname === '/_avisos') {
    const antes = mails.length;
    api.enviarAvisos();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ nuevos: mails.slice(antes), total: mails.length }, null, 1));
    return;
  }
  if (url.pathname === '/config.js') {       // apunta la app al Apps Script simulado
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end("const SCRIPT_URL = location.origin + '/api';");
    return;
  }
  let archivo = path.join(RAIZ, decodeURIComponent(url.pathname));
  if (!archivo.startsWith(RAIZ)) { res.writeHead(403); res.end(); return; }
  if (url.pathname.endsWith('/')) archivo = path.join(archivo, 'index.html');
  fs.readFile(archivo, (err, datos) => {
    if (err) { res.writeHead(404); res.end('no encontrado'); return; }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(datos);
  });
}).listen(PUERTO, () => console.log('Servidor de prueba en http://localhost:' + PUERTO));
