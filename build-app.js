// Builds app/ from the web version (katastixo.html): local libraries and fonts, local database shim.
const fs = require('fs'), path = require('path');
const SRC = process.env.KATASTIXO_SRC || path.join(__dirname, 'web', 'agrologio.html');
const out = path.join(__dirname, 'app'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(path.join(out, 'lib'), { recursive: true }); fs.mkdirSync(path.join(out, 'fonts'));
const nm = p => path.join(__dirname, 'node_modules', p);
const copy = (from, to) => fs.copyFileSync(nm(from), path.join(out, to));
copy('xlsx/dist/xlsx.full.min.js', 'lib/xlsx.full.min.js');
copy('jspdf/dist/jspdf.umd.min.js', 'lib/jspdf.umd.min.js');
copy('jspdf-autotable/dist/jspdf.plugin.autotable.min.js', 'lib/jspdf.plugin.autotable.min.js');
// Leaflet: satellite / street map of the fields (desktop only; the web page keeps its offline drawing).
copy('leaflet/dist/leaflet.js', 'lib/leaflet.js'); copy('leaflet/dist/leaflet.css', 'lib/leaflet.css');
fs.copyFileSync(path.join(__dirname, 'shim.js'), path.join(out, 'lib/shim.js'));
fs.copyFileSync(path.join(__dirname, 'build/icon.png'), path.join(out, 'icon.png'));
// Fonts: only greek + latin subsets, woff2
let css = '';
for (const [fam, ws] of [['commissioner', [400, 500, 600, 700]], ['literata', [600, 700]]]) for (const w of ws) {
  const src = fs.readFileSync(nm(`@fontsource/${fam}/${w}.css`), 'utf8');
  for (const block of src.split('/*').slice(1)) {
    const m = block.match(/^\s*([\w-]+)\s*\*\//); if (!m || !/^(greek|latin|latin-ext)$/.test(m[1].split('-').slice(2).join('-') || m[1])) {
      if (!m || !/-(greek|latin|latin-ext)-/.test(block.match(/files\/([^)]+\.woff2)/)?.[1] || '')) continue;
    }
    const file = block.match(/files\/([^)]+\.woff2)/)[1];
    if (!/-(greek|latin|latin-ext)-\d+-normal\.woff2$/.test(file)) continue;
    fs.copyFileSync(nm(`@fontsource/${fam}/files/${file}`), path.join(out, 'fonts', file));
    css += '/*' + block.replace(/src:[^;]+;/, `src: url(../fonts/${file}) format('woff2');`);
  }
}
fs.writeFileSync(path.join(out, 'lib/fonts.css'), css);
let html = fs.readFileSync(SRC, 'utf8');
html = html.replace(/<link rel="preconnect"[^>]*>\n?/, '').replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n?/, '')
  .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/[\d.]+\/xlsx\.full\.min\.js/, 'lib/xlsx.full.min.js')
  .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/jspdf@[\d.]+\/dist\/jspdf\.umd\.min\.js/, 'lib/jspdf.umd.min.js')
  .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/jspdf-autotable@[\d.]+\/dist\/jspdf\.plugin\.autotable\.min\.js/, 'lib/jspdf.plugin.autotable.min.js')
  .replace(/<meta name="claude:viewport-fit-sides"[^>]*>\n?/, '');
// Inline scripts become files, so the page can run with a strict policy (no inline scripts at all).
let n = 0;
html = html.replace(/<script>([\s\S]*?)<\/script>/g, (_, js) => { const f = `lib/page-${++n}.js`; fs.writeFileSync(path.join(out, f), js); return `<script src="${f}"></script>`; });
if (/ on[a-z]+="/.test(html)) throw new Error('inline event handler left in page');
if (/https:\/\/(cdn|fonts)/.test(html.replace(/https:\/\/(www\.google\.com|earth\.google\.com)/g, ''))) throw new Error('external resource left in page');
const head = `<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https://server.arcgisonline.com https://services.arcgisonline.com">
<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<link rel="stylesheet" href="lib/fonts.css"><link rel="stylesheet" href="lib/leaflet.css"><script src="lib/shim.js"></script><script src="lib/leaflet.js"></script></head><body>`;
fs.writeFileSync(path.join(out, 'index.html'), head + html + '</body></html>');
// seed.json (optional, local only, first run only) is not part of the public build.
console.log('app built:', fs.readdirSync(path.join(out, 'fonts')).length, 'font files');
