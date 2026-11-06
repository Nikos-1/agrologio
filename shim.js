// Gives the page the same window.claude.use('db' | 'downloads') API it has on claude.ai, backed by the local SQLite file.
(function () {
  const N = window.katastixoNative;
  let cache = null; const listeners = { fields: new Set(), entries: new Set(), settings: new Set() }; const docListeners = new Map();
  const load = async () => { if (!cache) cache = await N.all(); return cache; };
  const snap = (id, d) => ({ id, exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))), metadata: { fromCache: false, hasPendingWrites: false } });
  const qsnap = c => { const docs = Object.entries(cache[c]).map(([id, d]) => snap(id, d)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} }; };
  // A listener error (page render) must not look like a failed save.
  const safe = (fn, v) => { try { fn(v); } catch (err) { console.error(err); } };
  const fire = (c, id) => { listeners[c].forEach(fn => safe(fn, qsnap(c))); (docListeners.get(c + '/' + id) || new Set()).forEach(fn => safe(fn, snap(id, cache[c][id]))); };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const doc = (c, id) => ({
    id, path: c + '/' + id,
    get: async () => { await load(); return snap(id, cache[c][id]); },
    set: async d => { await load(); await N.set(c, id, d); cache[c][id] = JSON.parse(JSON.stringify(d)); fire(c, id); },
    update: async d => { await load(); const m = { ...(cache[c][id] || {}), ...d }; await N.set(c, id, m); cache[c][id] = m; fire(c, id); },
    delete: async () => { await load(); await N.del(c, id); delete cache[c][id]; fire(c, id); },
    onSnapshot: (next, error) => { const k = c + '/' + id; if (!docListeners.has(k)) docListeners.set(k, new Set()); docListeners.get(k).add(next); load().then(() => next(snap(id, cache[c][id])), err => error && error(err)); return () => docListeners.get(k).delete(next); }
  });
  const db = {
    doc: p => { const [c, id] = p.split('/'); return doc(c, id); },
    collection: c => ({
      path: c, doc: id => doc(c, id || newId()),
      add: async d => { const id = newId(); await doc(c, id).set(d); return { id, path: c + '/' + id }; },
      get: async () => { await load(); return qsnap(c); },
      onSnapshot: (next, error) => { listeners[c].add(next); load().then(() => next(qsnap(c)), err => error && error(err)); return () => listeners[c].delete(next); }
    })
  };
  const downloads = {
    save: async ({ filename, data }) => {
      let bytes;
      if (typeof data === 'string') bytes = new TextEncoder().encode(data);
      else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const r = await N.saveFile(filename, bytes);
      if (!r.ok) throw { code: 'declined', message: 'Ακυρώθηκε' };
      return 'saved';
    }
  };
  window.claude = { use: async name => (name === 'db' ? db : name === 'downloads' ? downloads : null) };
})();
