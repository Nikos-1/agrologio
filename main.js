// Αγρολόγιο: Electron main process. Data lives in a local SQLite file (sql.js).
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, session, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { autoUpdater } = require('electron-updater');

// Greek locale for the whole program (date fields DD/MM/YYYY, numbers with comma)
app.commandLine.appendSwitch('lang', 'el');
// The data folder is fixed by name, so renaming the program in the build settings can never "lose" the data.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'Αγρολόγιο'));
const logFile = () => path.join(app.getPath('userData'), 'agrologio.log');
const log = (...a) => {
  try {
    const f = logFile();
    // The log never grows past 1 MB: the older half is dropped.
    try { if (fs.statSync(f).size > 1024 * 1024) { const b = fs.readFileSync(f); fs.writeFileSync(f, b.subarray(b.length >> 1)); } } catch {}
    fs.appendFileSync(f, new Date().toISOString() + ' ' + a.map(String).join(' ') + '\n');
  } catch {}
};

// The page is served from app://agrologio/ instead of file://, so a page script could never read other files on the computer.
const APP_ORIGIN = 'app://agrologio';
const APP_DIR = path.join(__dirname, 'app');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
function serveApp() {
  protocol.handle('app', req => {
    const u = new URL(req.url);
    if (u.host !== 'agrologio') return new Response('', { status: 404 });
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(u.pathname)));
    if (!file.startsWith(APP_DIR + path.sep)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}
// Only the program's own page may talk to the main process.
// (URL.origin is "null" for custom schemes, so the address is compared as text.)
const trusted = e => { try { return String(e.senderFrame.url).startsWith(APP_ORIGIN + '/'); } catch { return false; } };
const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { if (!trusted(e)) throw new Error('not allowed'); return fn(e, ...a); });

const COLLECTIONS = ['fields', 'entries', 'settings', 'photos'];
// --smoke-test (used by the release workflow with an empty --user-data-dir): start, load the page, exit 0. No dialogs, no updates.
const SMOKE = app.commandLine.hasSwitch('smoke-test');
let SQL, db, dbPath;

// Write the whole database to disk safely: temp file, flush to disk, then replace.
function persist() {
  const tmp = dbPath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, Buffer.from(db.export())); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Antivirus or OneDrive can hold the file for a moment: try again a few times before giving up.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, dbPath); return; }
    catch (e) { if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1)); }
  }
}

const backupDir = () => { const d = path.join(app.getPath('userData'), 'backups'); fs.mkdirSync(d, { recursive: true }); return d; };
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
// Copy the current file into backups/ under `prefix-…`; keep the newest `keep` copies of that kind only (never touches other files).
function backupFile(prefix, name, keep) {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return;
  const dir = backupDir();
  fs.copyFileSync(dbPath, path.join(dir, `${prefix}-${name}.sqlite`));
  const mine = fs.readdirSync(dir).filter(f => f.startsWith(prefix + '-') && f.endsWith('.sqlite')).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const o of mine.slice(keep)) fs.rmSync(path.join(dir, o.f), { force: true });
}

// Open a database file; null if it is empty or not a valid SQLite database.
function tryOpen(file) {
  try {
    const buf = fs.readFileSync(file); if (!buf.length) return null;
    const d = new SQL.Database(buf);
    const ok = d.exec('PRAGMA integrity_check')[0]?.values[0][0] === 'ok';
    if (!ok) { d.close(); return null; }
    return d;
  } catch { return null; }
}

// The data file is damaged or empty: offer the newest good copy. The damaged file is moved aside only after the user chooses,
// so «Έξοδος» leaves everything exactly as it was and the next start asks again (it never opens an empty database on its own).
async function recoverDb() {
  const keepBroken = () => {
    let broken = dbPath.replace(/\.sqlite$/, `-χαλασμένο-${stamp()}.sqlite`);
    for (let i = 2; fs.existsSync(broken); i++) broken = dbPath.replace(/\.sqlite$/, `-χαλασμένο-${stamp()}-${i}.sqlite`);
    try { fs.renameSync(dbPath, broken); log('damaged db kept as', broken); } catch (e) { log('could not move damaged db', e.code || e.message); }
    return broken;
  };
  const dir = backupDir();
  // A finished write that was not yet renamed (power cut between the two steps) is the newest copy there is.
  const cands = [];
  try { const t = dbPath + '.tmp'; if (fs.existsSync(t)) cands.push({ file: t, t: fs.statSync(t).mtimeMs, tmp: true }); } catch {}
  cands.push(...fs.readdirSync(dir).filter(f => f.endsWith('.sqlite')).map(f => ({ file: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t));
  for (const c of cands) {
    const d = tryOpen(c.file); if (!d) continue;
    const when = new Date(c.t).toLocaleString('el-GR');
    const r = await dialog.showMessageBox({ type: 'warning', title: 'Αγρολόγιο', buttons: ['Επαναφορά', 'Έξοδος'], defaultId: 0, cancelId: 1,
      message: 'Το αρχείο των στοιχείων σου είναι κατεστραμμένο.',
      detail: `Βρέθηκε ${c.tmp ? 'πρόσφατη αποθήκευση' : 'αντίγραφο ασφαλείας'} της ${when}. Με «Επαναφορά» το πρόγραμμα ανοίγει με αυτό και το χαλασμένο αρχείο φυλάγεται δίπλα.\n\nΜε «Έξοδος» δεν αλλάζει τίποτα.` });
    if (r.response !== 0) { d.close(); app.exit(0); return null; }
    keepBroken();
    return d;
  }
  const r = await dialog.showMessageBox({ type: 'warning', title: 'Αγρολόγιο', buttons: ['Ξεκίνα με κενό αρχείο', 'Έξοδος'], defaultId: 1, cancelId: 1,
    message: 'Το αρχείο των στοιχείων σου είναι κατεστραμμένο και δεν βρέθηκε αντίγραφο ασφαλείας.',
    detail: 'Αν έχεις αντίγραφο (.json), ξεκίνα με κενό αρχείο και φέρ\' το από Ρυθμίσεις → Αντίγραφο ασφαλείας. Το χαλασμένο αρχείο θα φυλαχτεί δίπλα.\n\nΜε «Έξοδος» δεν αλλάζει τίποτα.' });
  if (r.response !== 0) { app.exit(0); return null; }
  keepBroken();
  return new SQL.Database();
}

async function openDb() {
  SQL = await initSqlJs({ locateFile: f => path.join(__dirname, 'node_modules/sql.js/dist', f) });
  dbPath = path.join(app.getPath('userData'), 'katastixo.sqlite');
  if (fs.existsSync(dbPath)) { db = tryOpen(dbPath) || await recoverDb(); if (!db) return false; }
  else db = new SQL.Database();
  createSchema();
  backupOnNewVersion();
  seedOnce();
  persist();
  // An empty database is never copied over a daily backup (it would push a good copy out).
  const hasData = db.exec('SELECT (SELECT count(*) FROM fields) + (SELECT count(*) FROM entries)')[0].values[0][0] > 0;
  if (hasData) try { backupFile('ημερήσιο', stamp().slice(0, 10), 7); } catch {}
  // The program may stay open for days: refresh the day's copy every hour and on exit too.
  const daily = () => { try { const n = db.exec('SELECT (SELECT count(*) FROM fields) + (SELECT count(*) FROM entries)')[0].values[0][0]; if (n > 0) backupFile('ημερήσιο', stamp().slice(0, 10), 7); } catch (e) { log('daily backup', e.code || e.message); } };
  if (!SMOKE) { setInterval(daily, 60 * 60 * 1000).unref?.(); app.on('before-quit', daily); }
  return true;
}

// Run one change; if it cannot be written to disk, undo it in memory too, so nothing half-saved is left behind.
function writeChange(c, id, apply) {
  const prev = db.exec(`SELECT data FROM ${c} WHERE id = ?`, [id])[0]?.values[0][0];
  apply();
  try { persist(); }
  catch (err) {
    if (prev === undefined) db.run(`DELETE FROM ${c} WHERE id = ?`, [id]);
    else db.run(`INSERT OR REPLACE INTO ${c} (id, data, updated_at) VALUES (?, ?, datetime('now'))`, [id, prev]);
    throw new Error('Δεν γράφτηκε στον δίσκο (' + (err.code || err.message) + ')');
  }
  return true;
}

function createSchema() {
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  for (const c of COLLECTIONS) db.run(`CREATE TABLE IF NOT EXISTS ${c} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  // Read-only SQL views over the documents, for querying with any SQLite tool
  db.exec(`DROP VIEW IF EXISTS v_fields; CREATE VIEW v_fields AS SELECT id, json_extract(data,'$.name') AS name, json_extract(data,'$.crop') AS crop,
    json_extract(data,'$.stremmata') AS stremmata, json_extract(data,'$.plants') AS plants, json_extract(data,'$.variety') AS variety FROM fields;
  DROP VIEW IF EXISTS v_entries; CREATE VIEW v_entries AS SELECT id, json_extract(data,'$.kind') AS kind, json_extract(data,'$.fieldId') AS field_id,
    json_extract(data,'$.date') AS entry_date, json_extract(data,'$.season') AS season, json_extract(data,'$.task') AS task,
    json_extract(data,'$.incomeKind') AS income_kind, json_extract(data,'$.amount') AS income_amount, json_extract(data,'$.note') AS note FROM entries;
  DROP VIEW IF EXISTS v_cost_lines; CREATE VIEW v_cost_lines AS SELECT e.id AS entry_id, json_extract(e.data,'$.fieldId') AS field_id, json_extract(e.data,'$.date') AS entry_date,
    json_extract(l.value,'$.cat') AS category, json_extract(l.value,'$.qty') AS qty, json_extract(l.value,'$.price') AS price, json_extract(l.value,'$.amount') AS amount
    FROM entries e, json_each(e.data,'$.lines') l;`);
}

// After an update: keep a copy of the database as it was under the previous version (last 5 kept).
function backupOnNewVersion() {
  const row = db.exec("SELECT value FROM meta WHERE key = 'app_version'")[0];
  const prev = row && row.values[0][0], now = app.getVersion();
  if (prev !== now) backupFile('katastixo-before', `${now}-from-${prev || 'old'}`, 5);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('app_version', ?)", [now]);
}

// Only on the very first run: load the bundled snapshot of the web version's data. Never again (also not after a wipe).
function seedOnce() {
  const done = db.exec("SELECT value FROM meta WHERE key = 'seeded'")[0];
  if (done) return;
  const empty = db.exec('SELECT count(*) FROM fields')[0].values[0][0] === 0;
  const seedFile = path.join(__dirname, 'seed.json');
  if (empty && fs.existsSync(seedFile)) {
    const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    const ins = db.prepare('INSERT OR REPLACE INTO ' + 'fields' + ' (id, data) VALUES (?, ?)');
    for (const [id, d] of Object.entries(seed.fields || {})) ins.run([id, JSON.stringify(d)]);
    ins.free();
    const ie = db.prepare('INSERT OR REPLACE INTO entries (id, data) VALUES (?, ?)');
    for (const [id, d] of Object.entries(seed.entries || {})) ie.run([id, JSON.stringify(d)]);
    ie.free();
    if (seed.settings) db.run('INSERT OR REPLACE INTO settings (id, data) VALUES (?, ?)', ['main', JSON.stringify(seed.settings)]);
  }
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', datetime('now'))");
}

const check = c => { if (!COLLECTIONS.includes(c)) throw new Error('unknown collection ' + c); return c; };

handle('db:all', () => {
  const out = {};
  // Photos are fetched one by one when shown (db:get), not all at start.
  for (const c of COLLECTIONS.filter(x => x !== 'photos')) {
    out[c] = {};
    const r = db.exec(`SELECT id, data FROM ${c}`)[0];
    if (r) for (const [id, data] of r.values) out[c][id] = JSON.parse(data);
  }
  return out;
});
handle('db:get', (_e, c, id) => { check(c); const v = db.exec(`SELECT data FROM ${c} WHERE id = ?`, [String(id)])[0]?.values[0][0]; return v === undefined ? null : JSON.parse(v); });
handle('db:set', (_e, c, id, data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('bad document');
  check(c); id = String(id);
  return writeChange(c, id, () => db.run(`INSERT INTO ${c} (id, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`, [id, JSON.stringify(data)]));
});
// Many writes at once (backup import, KML), saved to disk once. If the disk write fails, nothing of it stays.
handle('db:bulk', (_e, ops) => {
  if (!Array.isArray(ops)) throw new Error('bad ops');
  const before = db.export();
  try {
    db.run('BEGIN');
    for (const o of ops) {
      const c = check(o.c), id = String(o.id);
      if (o.del) db.run(`DELETE FROM ${c} WHERE id = ?`, [id]);
      else {
        if (!o.data || typeof o.data !== 'object' || Array.isArray(o.data)) throw new Error('bad document');
        db.run(`INSERT INTO ${c} (id, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`, [id, JSON.stringify(o.data)]);
      }
    }
    db.run('COMMIT');
    persist();
  } catch (err) {
    try { db.close(); } catch {}
    db = new SQL.Database(before);
    throw new Error('Δεν γράφτηκε στον δίσκο (' + (err.code || err.message) + ')');
  }
  return true;
});
handle('db:backup', (_e, prefix) => { backupFile(String(prefix).replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 40) || 'χειροκίνητο', stamp(), 5); return true; });
handle('db:delete', (_e, c, id) => { check(c); id = String(id); return writeChange(c, id, () => db.run(`DELETE FROM ${c} WHERE id = ?`, [id])); });
const SAVE_TYPES = ['pdf', 'xlsx', 'json', 'kmz', 'kml', 'csv'];
handle('file:save', async (e, filename, bytes) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  // Only the kinds of file the program makes, and never a folder path from the page.
  filename = path.basename(String(filename)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!SAVE_TYPES.includes(ext)) throw new Error('Δεν επιτρέπεται αρχείο .' + ext);
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), filename), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  const out = path.extname(r.filePath).toLowerCase() === '.' + ext ? r.filePath : r.filePath + '.' + ext;
  const tmp = out + '.tmp'; fs.writeFileSync(tmp, Buffer.from(bytes)); fs.renameSync(tmp, out); r.filePath = out;
  shell.showItemInFolder(r.filePath);
  return { ok: true, path: r.filePath };
});
// Wipe: replace the database with a brand-new, empty one (no seed).
handle('db:reset', () => {
  backupFile('πριν-τη-διαγραφή', stamp(), 5);
  // The new empty database replaces the old one only once it is on disk (a full disk leaves everything as it was).
  const old = db;
  db = new SQL.Database();
  try {
    createSchema();
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', datetime('now'))");
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('app_version', ?)", [app.getVersion()]);
    persist();
  } catch (err) { try { db.close(); } catch {} db = old; throw new Error('Δεν γράφτηκε στον δίσκο (' + (err.code || err.message) + ')'); }
  try { old.close(); } catch {}
  return true;
});
// Windows light/dark theme, for the "Σύμφωνα με το σύστημα" appearance option
handle('theme:dark', () => nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors); });
handle('app:info', () => ({ version: app.getVersion(), dbPath }));

// Αρχείο → Επαναφορά από αντίγραφο…: the newest copies with their date and size; the current data is kept as a copy first.
async function restoreFromBackup() {
  const win = BrowserWindow.getAllWindows()[0];
  const dir = backupDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite')).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  const list = [];
  for (const o of files) {
    if (list.length >= 5) break;
    const d = tryOpen(path.join(dir, o.f)); if (!d) continue;
    let n = [0, 0]; try { n = d.exec('SELECT (SELECT count(*) FROM fields), (SELECT count(*) FROM entries)')[0].values[0]; } catch {}
    d.close();
    const kind = o.f.startsWith('ημερήσιο') ? 'ημερήσιο' : o.f.startsWith('πριν-τη-διαγραφή') ? 'πριν από διαγραφή' : o.f.startsWith('katastixo-before') ? 'πριν από ενημέρωση' : o.f.startsWith('πριν-την-επαναφορά') ? 'πριν από επαναφορά' : 'χειροκίνητο';
    list.push({ ...o, label: `${new Date(o.t).toLocaleString('el-GR', { dateStyle: 'short', timeStyle: 'short' })} · ${n[0]} ${n[0] === 1 ? 'αγροτεμάχιο' : 'αγροτεμάχια'}, ${n[1]} ${n[1] === 1 ? 'καταχώριση' : 'καταχωρίσεις'} (${kind})` });
  }
  if (!list.length) return dialog.showMessageBox(win, { type: 'info', title: 'Αγρολόγιο', message: 'Δεν υπάρχει ακόμα αντίγραφο ασφαλείας.' });
  const r = await dialog.showMessageBox(win, { type: 'question', title: 'Επαναφορά από αντίγραφο', buttons: [...list.map(o => o.label), 'Άκυρο'], cancelId: list.length, defaultId: list.length, noLink: false,
    message: 'Ποιο αντίγραφο να ανοίξει;', detail: 'Τα σημερινά στοιχεία φυλάγονται πρώτα ως αντίγραφο «πριν από επαναφορά», οπότε μπορείς να γυρίσεις πίσω.' });
  if (r.response >= list.length) return;
  const pick = list[r.response];
  const nd = tryOpen(path.join(dir, pick.f));
  if (!nd) return dialog.showErrorBox('Αγρολόγιο', 'Το αντίγραφο δεν ανοίγει.');
  backupFile('πριν-την-επαναφορά', stamp(), 5);
  const old = db; db = nd;
  try { createSchema(); persist(); } catch (err) { db = old; try { nd.close(); } catch {} return dialog.showErrorBox('Αγρολόγιο', 'Δεν έγινε η επαναφορά: ' + (err.code || err.message)); }
  try { old.close(); } catch {}
  log('restored from', pick.f);
  for (const w of BrowserWindow.getAllWindows()) w.webContents.reload();
}

// Theme, text size and the other small page choices lived under file:// until 0.9.0; copy them once to the new app:// page.
let moving = false;
async function moveLocalChoices() {
  const done = db.exec("SELECT value FROM meta WHERE key = 'ls_moved'")[0];
  if (done || SMOKE) return;
  moving = true;
  try {
    const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await w.loadFile(path.join(APP_DIR, 'blank.html'));
    const json = await w.webContents.executeJavaScript("JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('agrologio-'))))");
    await w.loadURL(APP_ORIGIN + '/blank.html');
    await w.webContents.executeJavaScript(`(o=>{for(const[k,v]of Object.entries(o))if(localStorage.getItem(k)===null)localStorage.setItem(k,v)})(${json})`);
    w.destroy();
  } catch (e) { log('move local choices', e && e.message || e); }
  moving = false;
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('ls_moved', datetime('now'))");
  try { persist(); } catch {}
}

function lockDownSession() {
  // The program needs no camera, microphone, location or notifications.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 860, minWidth: 420, title: 'Αγρολόγιο', backgroundColor: '#f2f4ee',
    icon: path.join(__dirname, 'app', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  // Only web links open, and only in the normal browser. The window itself never leaves the app page
  // (a file dropped on the window by mistake must not replace the app).
  const openWeb = url => { if (/^https:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { openWeb(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (ev, url) => { if (url !== win.webContents.getURL()) { ev.preventDefault(); openWeb(url); } });
  win.webContents.on('will-attach-webview', ev => ev.preventDefault());
  // Right click: cut / copy / paste in Greek.
  win.webContents.on('context-menu', (_e, p) => {
    const items = p.isEditable
      ? [{ label: 'Αποκοπή', role: 'cut', enabled: p.editFlags.canCut }, { label: 'Αντιγραφή', role: 'copy', enabled: p.editFlags.canCopy }, { label: 'Επικόλληση', role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { label: 'Επιλογή όλων', role: 'selectAll' }]
      : p.selectionText ? [{ label: 'Αντιγραφή', role: 'copy' }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  if (SMOKE) {
    // Release check: the page must load and show its title, then the program closes with code 0.
    const fail = (why) => { console.error('smoke test failed:', why); app.exit(2); };
    setTimeout(() => fail('timeout'), 60000);
    win.webContents.on('did-fail-load', (_e, code, desc) => fail(desc || code));
    win.webContents.on('render-process-gone', (_e, d) => fail('renderer ' + d.reason));
    win.webContents.on('did-finish-load', async () => {
      try {
        // The page must render and its data must load from the database (a refused or broken database call fails the check).
        const why = await win.webContents.executeJavaScript(`new Promise(r=>{const t0=Date.now();(function f(){const st=document.querySelector('#status')?.textContent||'',b=document.body.innerText;
          if(/Σφάλμα/.test(st))return r('load error: '+st);
          if(document.querySelector('nav')&&document.title.includes('Αγρολόγιο')&&!/Φορτώνω/.test(b))return r('');
          if(Date.now()-t0>20000)return r('page did not load its data');setTimeout(f,250)})()})`);
        if (why) return fail(why);
        console.log('smoke test ok', app.getVersion()); app.exit(0);
      } catch (e) { fail(e.message); }
    });
  }
  win.loadURL(APP_ORIGIN + '/index.html');
}

// Automatic updates from GitHub Releases (Nikos-1/agrologio). Data in userData is never touched by an update.
let manualCheck = false, updateReady = false, updateTimer = null;
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = { info: m => log('update', m), warn: m => log('update warn', m), error: m => log('update error', m), debug: () => {} };
  autoUpdater.on('update-not-available', () => {
    if (manualCheck) dialog.showMessageBox({ type: 'info', title: 'Αγρολόγιο', message: 'Έχετε την τελευταία έκδοση (' + app.getVersion() + ').' });
    manualCheck = false;
  });
  autoUpdater.on('update-available', info => {
    if (manualCheck) dialog.showMessageBox({ type: 'info', title: 'Αγρολόγιο', message: 'Βρέθηκε νέα έκδοση ' + info.version + '.', detail: 'Κατεβαίνει στο παρασκήνιο. Θα σας ειδοποιήσω όταν είναι έτοιμη.' });
    manualCheck = false;
  });
  autoUpdater.on('error', err => {
    log('update error', err && err.stack || err);
    if (manualCheck) {
      const msg = String(err && err.message || err);
      const preparing = /latest\.yml/.test(msg) && /404/.test(msg);
      dialog.showMessageBox({ type: preparing ? 'info' : 'warning', title: 'Αγρολόγιο',
        message: preparing ? 'Η νέα έκδοση ετοιμάζεται ακόμα.' : 'Δεν έγινε έλεγχος για ενημερώσεις.',
        detail: preparing ? 'Δοκιμάστε ξανά σε λίγα λεπτά.' : 'Ελέγξτε τη σύνδεση στο διαδίκτυο και δοκιμάστε ξανά.\n\n' + msg.split('\n')[0].slice(0, 200) });
    }
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', async info => {
    updateReady = true; clearInterval(updateTimer);
    const win = BrowserWindow.getAllWindows()[0];
    const r = await dialog.showMessageBox(win, { type: 'info', title: 'Νέα έκδοση', buttons: ['Επανεκκίνηση τώρα', 'Αργότερα'], defaultId: 0, cancelId: 1,
      message: 'Υπάρχει νέα έκδοση του Αγρολογίου (' + info.version + ').',
      detail: 'Τα στοιχεία σας μένουν όπως είναι. Αν πατήσετε «Αργότερα», η ενημέρωση θα εγκατασταθεί σιωπηλά όταν κλείσετε το πρόγραμμα.' });
    if (r.response === 0) { persist(); autoUpdater.quitAndInstall(true, true); }
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  updateTimer = setInterval(check, 6 * 60 * 60 * 1000);
}
function checkUpdatesNow() {
  if (!app.isPackaged) return dialog.showMessageBox({ message: 'Ο έλεγχος ενημερώσεων λειτουργεί μόνο στο εγκατεστημένο πρόγραμμα.' });
  if (updateReady) { persist(); return autoUpdater.quitAndInstall(true, true); }
  manualCheck = true; autoUpdater.checkForUpdates().catch(() => {});
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'Αρχείο', submenu: [
    { label: 'Επαναφορά από αντίγραφο…', click: () => restoreFromBackup() },
    { label: 'Άνοιγμα φακέλου δεδομένων', click: () => shell.showItemInFolder(dbPath) },
    { type: 'separator' }, { label: 'Έξοδος', role: 'quit' } ] },
  { label: 'Προβολή', submenu: [ { label: 'Ανανέωση', role: 'reload' }, { label: 'Μεγέθυνση', role: 'zoomIn' }, { label: 'Σμίκρυνση', role: 'zoomOut' }, { label: 'Κανονικό μέγεθος', role: 'resetZoom' }, { type: 'separator' }, { label: 'Πλήρης οθόνη', role: 'togglefullscreen' } ] },
  { label: 'Βοήθεια', submenu: [ { label: 'Έλεγχος για ενημερώσεις', click: checkUpdatesNow }, { type: 'separator' }, { label: 'Σχετικά', click: async () => { const r = await dialog.showMessageBox({ title: 'Αγρολόγιο', message: 'Αγρολόγιο ' + app.getVersion(), buttons: ['Εντάξει', 'Άνοιγμα φακέλου δεδομένων'], defaultId: 0, cancelId: 0, detail: 'Τα στοιχεία αποθηκεύονται τοπικά στο αρχείο:\n' + dbPath + '\n\nΤα αυτόματα αντίγραφα είναι στον φάκελο backups δίπλα του.' }); if (r.response === 1) shell.showItemInFolder(dbPath); } } ] }
]));

// Any other web contents (should never exist) may not navigate or open windows either.
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => { if (!url.startsWith(APP_ORIGIN + '/')) ev.preventDefault(); });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
  app.whenReady().then(() => { serveApp(); return openDb(); }).then(async ok => { if (ok) { lockDownSession(); await moveLocalChoices(); createWindow(); if (!SMOKE) setupUpdates(); } }).catch(async err => {
    log('start failed', err && err.stack || err);
    if (SMOKE) { console.error('smoke test failed:', err && err.stack || err); return app.exit(3); }
    // A version that cannot start must still be able to replace itself with a newer one.
    if (app.isPackaged) {
      try {
        const r = await autoUpdater.checkForUpdates();
        if (r && r.isUpdateAvailable && r.downloadPromise) { await r.downloadPromise; return autoUpdater.quitAndInstall(true, true); }
      } catch (e) { log('update after failed start', e && e.message || e); }
    }
    dialog.showErrorBox('Το Αγρολόγιο δεν μπόρεσε να ξεκινήσει', 'Δοκίμασε να το ανοίξεις ξανά. Αν συνεχίζει, στείλε αυτό το μήνυμα:\n\n' + String(err && err.message || err).slice(0, 300));
    app.quit();
  });
  app.on('window-all-closed', () => { if (!moving) app.quit(); });
}
