// =======================================================================
//  Scraper de fechas de divulgación de EEFF — CMF Chile
//  Corre en GitHub Actions (servidor), así que NO hay CORS ni proxies.
//  Lee la ficha "Fechas de Divulgación de EEFF" de cada emisor chileno del
//  portafolio y escribe cmf-fechas.json, que la página lee same-origin.
//
//  Uso:  node scripts/scrape-cmf.mjs
// =======================================================================

import { readFileSync, writeFileSync, existsSync } from 'fs';

const OUT = 'cmf-fechas.json';
const YEAR = new Date().getFullYear();
const ENT = rut =>
  `https://www.cmfchile.cl/institucional/mercados/entidad.php` +
  `?mercado=V&rut=${rut}&grupo=&tipoentidad=RVEMI&row=&vig=VI&control=svs&pestania=101`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Los RUT salen de index.html: una sola fuente de verdad ────────────
// Cada ticker vive en su propia línea, así que el matcheo por línea es
// mucho más robusto que intentar abarcar el objeto completo con un regex.
function leerEmisores() {
  const html = readFileSync('index.html', 'utf8');
  const out = [];
  for (const line of html.split('\n')) {
    const t = line.match(/\{t:"([^"]+)"/);
    const r = line.match(/cmfRut:"(\d+-[\dkK])"/);
    if (t && r) out.push({ ticker: t[1], rut: r[2] ?? r[1] });
  }
  // dedup por RUT conservando el primer ticker visto
  const seen = new Set();
  return out.filter(e => (seen.has(e.rut) ? false : (seen.add(e.rut), true)));
}

// ── 2. Descarga con reintentos ───────────────────────────────────────────
async function bajarFicha(rut) {
  const base = String(rut).split('-')[0];
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const res = await fetch(ENT(base), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; iA-earnings-calendar/1.0; +https://github.com/joaquinmunoz777/earnings-calendar)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'es-CL,es;q=0.9'
        },
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.text();
      // Si no aparece el encabezado de la ficha, la CMF devolvió otra cosa
      if (!/Divulgaci/i.test(body)) throw new Error('respuesta inesperada (sin "Divulgación")');
      return body;
    } catch (e) {
      if (intento === 3) { console.error(`    ✗ ${rut}: ${e.message}`); return null; }
      await sleep(2000 * intento);
    }
  }
  return null;
}

// ── 3. Parseo de la tabla Año | Marzo | Junio | Septiembre | Diciembre ──
function limpiar(celda) {
  return celda.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function filaDelAnio(html, anio) {
  const filas = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const f of filas) {
    const celdas = [...f[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => limpiar(c[1]));
    if (celdas.length < 5) continue;
    if (celdas[0] !== String(anio)) continue;
    return celdas.slice(1, 5);
  }
  return null;
}

// "23/10/2026" → "2026-10-23";  "-" o vacío → ""
export function aISO(s) {
  if (!s || s === '-') return '';
  const p = s.split('/');
  if (p.length !== 3) return '';
  const [d, m, a] = p;
  if (!/^\d{1,2}$/.test(d) || !/^\d{1,2}$/.test(m) || !/^\d{4}$/.test(a)) return '';
  return `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// ── 4. Main ──────────────────────────────────────────────────────────────
async function main() {
  const emisores = leerEmisores();
  if (!emisores.length) {
    console.error('No se encontró ningún cmfRut en index.html. ¿Cambió el formato?');
    process.exit(1);
  }
  console.log(`Emisores chilenos detectados: ${emisores.length}`);

  // Partimos del JSON anterior: si un emisor falla hoy, conserva lo que ya tenía
  let previo = {};
  if (existsSync(OUT)) {
    try { previo = JSON.parse(readFileSync(OUT, 'utf8')).data || {}; }
    catch { console.warn('cmf-fechas.json ilegible, se regenera desde cero'); }
  }

  const data = { ...previo };
  let leidos = 0, fallidos = 0, cambios = 0;

  for (let i = 0; i < emisores.length; i++) {
    const { ticker, rut } = emisores[i];
    process.stdout.write(`[${i + 1}/${emisores.length}] ${ticker} (${rut}) … `);
    const html = await bajarFicha(rut);
    if (!html) { fallidos++; console.log(''); await sleep(1500); continue; }

    const celdas = filaDelAnio(html, YEAR);
    if (!celdas) {
      console.log(`sin fila ${YEAR}`);
      fallidos++;
      await sleep(1500);
      continue;
    }
    const q = celdas.map(aISO);
    const antes = (previo[rut] && previo[rut].q) || [];
    const diff = q.filter((d, k) => d && d !== antes[k]);
    if (diff.length) cambios += diff.length;
    data[rut] = { ticker, q };
    leidos++;
    console.log(q.map(d => d || '—').join('  ') + (diff.length ? `   ← ${diff.length} nueva(s)` : ''));
    if (i < emisores.length - 1) await sleep(1500); // cortesía con la CMF
  }

  if (!leidos) {
    console.error('\nNingún emisor pudo leerse. No se escribe el archivo para no perder lo anterior.');
    process.exit(1);
  }

  const salida = {
    updated: new Date().toISOString(),
    year: YEAR,
    source: 'cmfchile.cl — Fechas de Divulgación de EEFF',
    issuers: leidos,
    data
  };
  writeFileSync(OUT, JSON.stringify(salida, null, 2) + '\n');
  console.log(`\n✓ ${leidos} leídos · ${fallidos} fallidos · ${cambios} fecha(s) nueva(s)`);
  console.log(`✓ ${OUT} escrito`);
}

// Permite importar las funciones puras desde los tests sin ejecutar main()
if (process.argv[1] && process.argv[1].endsWith('scrape-cmf.mjs')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
