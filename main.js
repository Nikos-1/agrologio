// Αγρολόγιο: Electron main process. Data lives in a local SQLite file (sql.js).
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { autoUpdater } = require('electron-updater');

// Greek locale for the whole program (date fields DD/MM/YYYY, numbers with comma)
app.commandLine.appendSwitch('lang', 'el');

const COLLECTIONS = ['fields', 'entries', 'settings'];
let SQL, db, dbPath;

function persist() {
  const tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, dbPath);
}

async function openDb() {
  SQL = await initSqlJs({ locateFile: f => path.join(__dirname, 'node_modules/sql.js/dist', f) });
  dbPath = path.join(app.getPath('userData'), 'katastixo.sqlite');
  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  createSchema();
  backupOnNewVersion();
  seedOnce();
  persist();
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
  if (prev !== now && fs.existsSync(dbPath)) {
    const dir = path.join(app.getPath('userData'), 'backups'); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(dbPath, path.join(dir, `katastixo-before-${now}-from-${prev || 'old'}.sqlite`));
    const old = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite')).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const o of old.slice(5)) fs.rmSync(path.join(dir, o.f), { force: true });
  }
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
  db.run(`INSERT INTO ${check(c)} (id, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`, [String(id), JSON.stringify(data)]);
  persist(); return true;
});
ipcMain.handle('db:delete', (_e, c, id) => { db.run(`DELETE FROM ${check(c)} WHERE id = ?`, [String(id)]); persist(); return true; });
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
  db.close();
  db = new SQL.Database();
  createSchema();
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', datetime('now'))");
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('app_version', ?)", [app.getVersion()]);
  persist();
  return true;
});
ipcMain.handle('app:info', () => ({ version: app.getVersion(), dbPath }));

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 860, minWidth: 420, title: 'Αγρολόγιο', backgroundColor: '#f2f4ee',
    icon: path.join(__dirname, 'app', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (ev, url) => { if (!url.startsWith('file:')) { ev.preventDefault(); shell.openExternal(url); } });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

// Automatic updates from GitHub Releases (Nikos-1/agrologio). Data in userData is never touched by an update.
let manualCheck = false, updateReady = false;
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-not-available', () => {
    if (manualCheck) dialog.showMessageBox({ type: 'info', title: 'Αγρολόγιο', message: 'Έχετε την τελευταία έκδοση (' + app.getVersion() + ').' });
    manualCheck = false;
  });
  autoUpdater.on('update-available', info => {
    if (manualCheck) dialog.showMessageBox({ type: 'info', title: 'Αγρολόγιο', message: 'Βρέθηκε νέα έκδοση ' + info.version + '.', detail: 'Κατεβαίνει στο παρασκήνιο. Θα σας ειδοποιήσω όταν είναι έτοιμη.' });
    manualCheck = false;
  });
  autoUpdater.on('error', err => {
    if (manualCheck) {
      const msg = String(err && err.message || err);
      const preparing = /latest\.yml|404/.test(msg);
      dialog.showMessageBox({ type: preparing ? 'info' : 'warning', title: 'Αγρολόγιο',
        message: preparing ? 'Η νέα έκδοση ετοιμάζεται ακόμα.' : 'Δεν έγινε έλεγχος για ενημερώσεις.',
        detail: preparing ? 'Δοκιμάστε ξανά σε λίγα λεπτά.' : 'Ελέγξτε τη σύνδεση στο διαδίκτυο και δοκιμάστε ξανά.\n\n' + msg.split('\n')[0].slice(0, 200) });
    }
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', async info => {
    updateReady = true;
    const win = BrowserWindow.getAllWindows()[0];
    const r = await dialog.showMessageBox(win, { type: 'info', title: 'Νέα έκδοση', buttons: ['Επανεκκίνηση τώρα', 'Αργότερα'], defaultId: 0, cancelId: 1,
      message: 'Υπάρχει νέα έκδοση του Αγρολογίου (' + info.version + ').',
      detail: 'Τα στοιχεία σας μένουν όπως είναι. Αν πατήσετε «Αργότερα», η ενημέρωση θα εγκατασταθεί όταν κλείσετε το πρόγραμμα.' });
    if (r.response === 0) { persist(); autoUpdater.quitAndInstall(false, true); }
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
function checkUpdatesNow() {
  if (!app.isPackaged) return dialog.showMessageBox({ message: 'Ο έλεγχος ενημερώσεων λειτουργεί μόνο στο εγκατεστημένο πρόγραμμα.' });
  if (updateReady) return autoUpdater.quitAndInstall(false, true);
  manualCheck = true; autoUpdater.checkForUpdates().catch(() => {});
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'Αρχείο', submenu: [
    { label: 'Άνοιγμα φακέλου δεδομένων', click: () => shell.showItemInFolder(dbPath) },
    { type: 'separator' }, { label: 'Έξοδος', role: 'quit' } ] },
  { label: 'Προβολή', submenu: [ { label: 'Ανανέωση', role: 'reload' }, { label: 'Μεγέθυνση', role: 'zoomIn' }, { label: 'Σμίκρυνση', role: 'zoomOut' }, { label: 'Κανονικό μέγεθος', role: 'resetZoom' }, { type: 'separator' }, { label: 'Πλήρης οθόνη', role: 'togglefullscreen' } ] },
  { label: 'Βοήθεια', submenu: [ { label: 'Έλεγχος για ενημερώσεις', click: checkUpdatesNow }, { type: 'separator' }, { label: 'Σχετικά', click: () => dialog.showMessageBox({ title: 'Αγρολόγιο', message: 'Αγρολόγιο ' + app.getVersion(), detail: 'Τα στοιχεία αποθηκεύονται τοπικά στο αρχείο:\n' + dbPath }) } ] }
]));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
  app.whenReady().then(openDb).then(createWindow).then(setupUpdates).catch(err => { dialog.showErrorBox('Σφάλμα εκκίνησης', String(err && err.stack || err)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
