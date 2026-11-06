// Αγρολόγιο: Electron main process. Data lives in a local SQLite file (sql.js).
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, session } = require('electron');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { autoUpdater } = require('electron-updater');

// Greek locale for the whole program (date fields DD/MM/YYYY, numbers with comma)
app.commandLine.appendSwitch('lang', 'el');
// The data folder is fixed by name, so renaming the program in the build settings can never "lose" the data.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'Αγρολόγιο'));
const logFile = () => path.join(app.getPath('userData'), 'agrologio.log');
const log = (...a) => { try { fs.appendFileSync(logFile(), new Date().toISOString() + ' ' + a.map(String).join(' ') + '\n'); } catch {} };

const COLLECTIONS = ['fields', 'entries', 'settings'];
let SQL, db, dbPath;

// Write the whole database to disk safely: temp file, flush to disk, then replace.
function persist() {
  const tmp = dbPath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, Buffer.from(db.export())); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, dbPath);
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

// The data file is damaged or empty: keep it aside and offer the newest good backup.
async function recoverDb() {
  let broken = dbPath.replace(/\.sqlite$/, `-χαλασμένο-${stamp()}.sqlite`);
  for (let i = 2; fs.existsSync(broken); i++) broken = dbPath.replace(/\.sqlite$/, `-χαλασμένο-${stamp()}-${i}.sqlite`);
  try { fs.renameSync(dbPath, broken); } catch {}
  const dir = backupDir();
  const cands = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite')).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const c of cands) {
    const d = tryOpen(path.join(dir, c.f)); if (!d) continue;
    const when = new Date(c.t).toLocaleString('el-GR');
    const r = await dialog.showMessageBox({ type: 'warning', title: 'Αγρολόγιο', buttons: ['Επαναφορά', 'Έξοδος'], defaultId: 0, cancelId: 1,
      message: 'Το αρχείο των στοιχείων σου είναι κατεστραμμένο.',
      detail: `Βρέθηκε αντίγραφο ασφαλείας της ${when}. Με «Επαναφορά» το πρόγραμμα ανοίγει με αυτό.\n\nΤο χαλασμένο αρχείο φυλάχτηκε ως:\n${broken}` });
    if (r.response !== 0) { d.close(); app.exit(0); return null; }
    return d;
  }
  const r = await dialog.showMessageBox({ type: 'warning', title: 'Αγρολόγιο', buttons: ['Ξεκίνα με κενό αρχείο', 'Έξοδος'], defaultId: 1, cancelId: 1,
    message: 'Το αρχείο των στοιχείων σου είναι κατεστραμμένο και δεν βρέθηκε αντίγραφο ασφαλείας.',
    detail: `Αν έχεις αντίγραφο (.json), ξεκίνα με κενό αρχείο και φέρ' το από Ρυθμίσεις → Αντίγραφο ασφαλείας.\n\nΤο χαλασμένο αρχείο φυλάχτηκε ως:\n${broken}` });
  if (r.response !== 0) { app.exit(0); return null; }
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
  try { backupFile('ημερήσιο', stamp().slice(0, 10), 7); } catch {}
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

ipcMain.handle('db:all', () => {
  const out = {};
  for (const c of COLLECTIONS) {
    out[c] = {};
    const r = db.exec(`SELECT id, data FROM ${c}`)[0];
    if (r) for (const [id, data] of r.values) out[c][id] = JSON.parse(data);
  }
  return out;
});
ipcMain.handle('db:set', (_e, c, id, data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('bad document');
  check(c); id = String(id);
  return writeChange(c, id, () => db.run(`INSERT INTO ${c} (id, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`, [id, JSON.stringify(data)]));
});
// Many writes at once (backup import, KML), saved to disk once. If the disk write fails, nothing of it stays.
ipcMain.handle('db:bulk', (_e, ops) => {
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
ipcMain.handle('db:backup', (_e, prefix) => { backupFile(String(prefix).replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 40) || 'χειροκίνητο', stamp(), 5); return true; });
ipcMain.handle('db:delete', (_e, c, id) => { check(c); id = String(id); return writeChange(c, id, () => db.run(`DELETE FROM ${c} WHERE id = ?`, [id])); });
ipcMain.handle('file:save', async (e, filename, bytes) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const ext = path.extname(filename).slice(1);
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), filename), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  shell.showItemInFolder(r.filePath);
  return { ok: true, path: r.filePath };
});
// Wipe: replace the database with a brand-new, empty one (no seed).
ipcMain.handle('db:reset', () => {
  backupFile('πριν-τη-διαγραφή', stamp(), 5);
  db.close();
  db = new SQL.Database();
  createSchema();
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', datetime('now'))");
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('app_version', ?)", [app.getVersion()]);
  persist();
  return true;
});
// Windows light/dark theme, for the "Σύμφωνα με το σύστημα" appearance option
ipcMain.handle('theme:dark', () => nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors); });
ipcMain.handle('app:info', () => ({ version: app.getVersion(), dbPath }));

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
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
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
    { label: 'Άνοιγμα φακέλου δεδομένων', click: () => shell.showItemInFolder(dbPath) },
    { type: 'separator' }, { label: 'Έξοδος', role: 'quit' } ] },
  { label: 'Προβολή', submenu: [ { label: 'Ανανέωση', role: 'reload' }, { label: 'Μεγέθυνση', role: 'zoomIn' }, { label: 'Σμίκρυνση', role: 'zoomOut' }, { label: 'Κανονικό μέγεθος', role: 'resetZoom' }, { type: 'separator' }, { label: 'Πλήρης οθόνη', role: 'togglefullscreen' } ] },
  { label: 'Βοήθεια', submenu: [ { label: 'Έλεγχος για ενημερώσεις', click: checkUpdatesNow }, { type: 'separator' }, { label: 'Σχετικά', click: async () => { const r = await dialog.showMessageBox({ title: 'Αγρολόγιο', message: 'Αγρολόγιο ' + app.getVersion(), buttons: ['Εντάξει', 'Άνοιγμα φακέλου δεδομένων'], defaultId: 0, cancelId: 0, detail: 'Τα στοιχεία αποθηκεύονται τοπικά στο αρχείο:\n' + dbPath + '\n\nΤα αυτόματα αντίγραφα είναι στον φάκελο backups δίπλα του.' }); if (r.response === 1) shell.showItemInFolder(dbPath); } } ] }
]));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
  app.whenReady().then(openDb).then(ok => { if (ok) { lockDownSession(); createWindow(); setupUpdates(); } }).catch(err => {
    dialog.showErrorBox('Το Αγρολόγιο δεν μπόρεσε να ξεκινήσει', 'Δοκίμασε να το ανοίξεις ξανά. Αν συνεχίζει, στείλε αυτό το μήνυμα:\n\n' + String(err && err.message || err).slice(0, 300));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
