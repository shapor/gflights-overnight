// Google Flights allows one hour range per leg for departure and one for
// arrival, within a single day; wrapping ranges are rejected and repeated
// range fields are last-wins. Arrival ranges are also time-of-day only, so
// "arrive 1-3 AM" matches 1 AM on +1 and on +2 alike.
//
// So this offers sliders over absolute time spanning several days, and splits
// each window into one piece per calendar day: departure pieces search that
// date; arrival pieces keep the date and keep only rows whose arrival marker
// (+N) is that day. The first search loads in this page, the rest in hidden
// iframes whose rows are cloned into this page.
(() => {
  const KEY = 'gf-window';
  const FIELDS = { dep: [8, 9], arr: [10, 11] }; // first-leg [start, end] hour fields, end inclusive
  const SPAN = { dep: 48, arr: 72 }; // slider length in hours from the search date's midnight
  const ANY = { dep: [0, 24], arr: [0, 72] };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => {
    for (let t = 0; t < ms; t += 500) { const v = fn(); if (v) return v; await sleep(500); }
  };

  // --- minimal protobuf (enough to rewrite the `tfs` URL param) ---
  const varint = n => { const o = []; for (; n > 127; n = Math.floor(n / 128)) o.push((n & 127) | 128); o.push(n); return o; };
  const rv = (b, i) => { let v = 0, s = 0, c; do { c = b[i++]; v += (c & 127) * 2 ** s; s += 7; } while (c & 128); return [v, i]; };
  function parse(b) {
    const out = [];
    for (let i = 0, k; i < b.length;) {
      [k, i] = rv(b, i);
      const f = Math.floor(k / 8), t = k % 8, s = i;
      if (t === 2) { let n; [n, i] = rv(b, i); out.push({ f, t, raw: b.slice(i, i + n) }); i += n; continue; }
      i = t === 0 ? rv(b, i)[1] : i + (t === 1 ? 8 : 4);
      out.push({ f, t, raw: b.slice(s, i) });
    }
    return out;
  }
  const encode = msg => Uint8Array.from(msg.flatMap(({ f, t, raw }) => [...varint(f * 8 + t), ...(t === 2 ? varint(raw.length) : []), ...raw]));
  const set = (msg, f, t, raw) => [...msg.filter(x => x.f !== f), ...(raw ? [{ f, t, raw }] : [])].sort((a, b) => a.f - b.f);
  const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const b64 = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tfs = (url = location.href) => new URL(url).searchParams.get('tfs');
  const firstLeg = url => parse(parse(unb64(tfs(url))).find(x => x.f === 3).raw);
  const legDate = url => new TextDecoder().decode(firstLeg(url).find(x => x.f === 2).raw);

  // Rewrite the first leg's hour range for `kind` (null range clears it), shifting the date by `days`.
  function withLeg(url, kind, range, days = 0) {
    const u = new URL(url), top = parse(unb64(tfs(url))), li = top.findIndex(x => x.f === 3);
    const hour = n => range && Uint8Array.from(varint(n));
    const [fs, fe] = FIELDS[kind];
    let leg = set(set(parse(top[li].raw), fs, 0, hour(range?.[0])), fe, 0, hour(range?.[1]));
    if (days) {
      const d = new Date(legDate(url) + 'T00:00Z');
      d.setUTCDate(d.getUTCDate() + days);
      leg = set(leg, 2, 2, new TextEncoder().encode(d.toISOString().slice(0, 10)));
    }
    top[li] = { f: 3, t: 2, raw: encode(leg) };
    u.searchParams.set('tfs', b64(encode(top)));
    return u.toString();
  }

  // Window [s, e) in hours from the search date's midnight -> one piece per calendar day,
  // with range null where the whole day is covered.
  function split([s, e]) {
    const out = [];
    for (let day = Math.floor(s / 24); day * 24 < e; day++) {
      const a = Math.max(s - day * 24, 0), b = Math.min(e - day * 24, 24) - 1;
      out.push({ day, range: a === 0 && b === 23 ? null : [a, b] });
    }
    return out;
  }

  // Every departure piece x arrival piece, grouped by URL. arrDays: allowed +N markers, or null.
  function searches(base, dep, arr) {
    const arrPieces = String(arr) === String(ANY.arr) ? [{ day: null, range: null }] : split(arr);
    const byUrl = new Map();
    for (const d of split(dep)) {
      for (const a of arrPieces) {
        const url = withLeg(withLeg(base, 'dep', d.range, d.day), 'arr', a.range);
        const g = byUrl.get(url) || byUrl.set(url, { url, arrDays: a.day == null ? null : [] }).get(url);
        g.arrDays?.push(a.day - d.day);
      }
    }
    return [...byUrl.values()];
  }

  // Arrival day marker after the arrival time: "8:40 AM+2" -> 2, none -> 0. One digit only:
  // some renderings run text together ("11:00 PM+111:00 PM on Sun").
  const arrDayOf = li => +((li.innerText.match(/–\s*\d{1,2}:\d\d[^\n+-]*([+-]\d)?/) || [])[1] || 0);
  const rows = doc => [...doc.querySelectorAll('ul > li')].filter(li => /\d:\d\d/.test(li.innerText));
  const shown = doc => rows(doc).filter(li => li.offsetHeight); // skips Google's hidden duplicate list
  const keep = (li, arrDays) => !arrDays || arrDays.includes(arrDayOf(li));
  const moreBtn = doc => [...doc.querySelectorAll('[jsaction]')]
    .find(e => e.offsetHeight && /^\s*view more flights\s*$/i.test(e.textContent));

  // --- UI (built without innerHTML: Google enforces Trusted Types) ---
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const st = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  const active = () => st && tfs() === st.tfs;
  const base = () => active() ? st.base : location.href;
  const win = { dep: st?.dep ?? ANY.dep, arr: st?.arr ?? ANY.arr };

  const when = h => {
    const d = new Date(legDate(base()) + 'T00:00Z');
    d.setUTCHours(h);
    return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', timeZone: 'UTC' });
  };
  const describe = kind => kind === 'arr' && String(win.arr) === String(ANY.arr)
    ? 'Anytime' : `${when(win[kind][0])} – ${when(win[kind][1])}`;

  // Two overlaid native range inputs make a dual-handle slider; ticks mark midnights.
  // Native thumbs travel inside a 9px inset, so the drawn parts use the same inset.
  const at = frac => `calc(9px + (100% - 18px) * ${frac})`;
  let timer;
  function slider(kind, title) {
    const max = SPAN[kind], label = el('span', { className: 'gfw-val' });
    const fill = el('div', { className: 'gfw-fill' });
    const [lo, hi] = win[kind].map(value => el('input', { type: 'range', min: 0, max, step: 1, value }));
    const ticks = Array.from({ length: max / 24 - 1 }, (_, i) => {
      const t = el('div', { className: 'gfw-tick' });
      t.style.left = at((i + 1) * 24 / max);
      return t;
    });
    const days = Array.from({ length: max / 24 }, (_, i) => el('span', { textContent: when(i * 24).split(' ')[0] }));
    const sync = () => {
      win[kind] = [Math.min(+lo.value, +hi.value - 1), Math.max(+hi.value, +lo.value + 1)];
      [lo.value, hi.value] = win[kind];
      fill.style.left = at(win[kind][0] / max);
      fill.style.width = `calc((100% - 18px) * ${(win[kind][1] - win[kind][0]) / max})`;
      label.textContent = describe(kind);
    };
    // Apply shortly after release, so both handles can be set before the page reloads.
    lo.oninput = hi.oninput = () => { clearTimeout(timer); sync(); };
    lo.onchange = hi.onchange = () => { status.textContent = 'Updating…'; timer = setTimeout(apply, 1200); };
    sync();
    return el('div', { className: 'gfw-row' },
      el('div', {}, `${title} · `, label),
      el('div', { className: 'gfw-track' }, el('div', { className: 'gfw-rail' }), ...ticks, fill, lo, hi),
      el('div', { className: 'gfw-days' }, ...days));
  }

  const css = `
    .gfw{position:fixed;right:16px;bottom:16px;z-index:9999;width:340px;background:#fff;color:#3c4043;
      font:13px "Google Sans",Roboto,Arial,sans-serif;padding:14px 16px;border-radius:8px;
      box-shadow:0 1px 3px rgba(60,64,67,.3),0 4px 8px 3px rgba(60,64,67,.15)}
    .gfw-head{display:flex;justify-content:space-between;font-size:15px;color:#202124;margin-bottom:6px}
    .gfw-head a{font-size:13px;color:#1a73e8;cursor:pointer}
    .gfw-row{margin-top:10px}.gfw-val{color:#1a73e8}
    .gfw-track{position:relative;height:24px}
    .gfw-rail,.gfw-fill,.gfw-tick{position:absolute;top:10px;height:4px;border-radius:2px}
    .gfw-rail{left:9px;right:9px;background:#dadce0}.gfw-fill{background:#1a73e8}
    .gfw-tick{width:2px;top:6px;height:12px;background:#9aa0a6}
    .gfw input{position:absolute;inset:0;width:100%;margin:0;background:none;pointer-events:none;-webkit-appearance:none}
    .gfw input::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:18px;height:18px;
      border-radius:50%;background:#1a73e8;cursor:pointer}
    .gfw-days{display:flex;padding:0 9px;color:#70757a;font-size:11px}.gfw-days span{flex:1}
    .gfw-status{margin-top:8px;min-height:16px;color:#70757a;font-size:12px}`;
  const status = el('div', { className: 'gfw-status' });
  const reset = el('a', { textContent: 'Clear' });
  const build = () => document.body.appendChild(el('div', { className: 'gfw' },
    el('style', { textContent: css }),
    el('div', { className: 'gfw-head' }, el('span', { textContent: 'Times across midnight' }), reset),
    slider('dep', 'Departure'), slider('arr', 'Arrival'), status));

  function apply() {
    const [main, ...extra] = searches(base(), win.dep, win.arr);
    sessionStorage.setItem(KEY, JSON.stringify({ base: base(), tfs: tfs(main.url), arrDays: main.arrDays, extra, ...win }));
    location.href = main.url;
  }
  reset.onclick = () => {
    const url = withLeg(withLeg(base(), 'dep', null), 'arr', null);
    sessionStorage.removeItem(KEY);
    location.href = url;
  };

  // Show the panel only on search pages, rebuilt when the date changes (day labels). On our
  // search, expand Google's list once, keep its rows filtered to the right arrival day and
  // the merged rows in place (Google re-renders the list, e.g. as prices load); drop them
  // once the SPA moves to another search.
  let merged = [], expanded = false, panel, builtFor;
  const fallback = el('ul');
  setInterval(() => {
    const date = tfs() && legDate(base());
    if (date !== builtFor) { panel?.remove(); panel = date && build(); builtFor = date; }
    if (!st) return;
    const on = active();
    for (const li of rows(document)) {
      if (!li.classList.contains('gf-merged')) li.style.display = !on || keep(li, st.arrDays) ? '' : 'none';
    }
    if (!on) return merged.forEach(c => c.remove());
    if (!expanded) { const m = moreBtn(document); if (m) { m.click(); expanded = true; } }
    if (merged.every(c => c.isConnected)) return;
    const list = shown(document).find(li => !li.classList.contains('gf-merged'))?.parentElement ||
      (fallback.isConnected ? fallback : (document.querySelector('[role=main]') || document.body).appendChild(fallback));
    list.prepend(...merged);
  }, 1000);

  // --- merge extra searches ---
  async function fetchRows({ url, arrDays }) {
    const f = el('iframe', { src: url });
    f.style.cssText = 'position:fixed;left:-9999px;width:1200px;height:900px';
    document.body.append(f);
    await new Promise(r => { f.onload = r; });
    const d = f.contentDocument;
    await until(() => shown(d).length || /no (results|options)/i.test(d.body.innerText));
    const more = moreBtn(d), n = shown(d).length;
    if (more) { more.click(); await until(() => shown(d).length > n, 10000); }
    const found = shown(d).filter(li => keep(li, arrDays)).map(li => document.importNode(li, true));
    f.remove();
    return found;
  }

  async function merge({ extra }) {
    status.textContent = `Loading ${extra.length} more search(es)…`;
    const results = await Promise.all(extra.map(fetchRows));
    merged = results.flatMap((found, i) => found.map(c => {
      c.classList.add('gf-merged');
      c.style.cssText = 'cursor:pointer;box-shadow:inset 4px 0 #1a73e8';
      c.title = `From the ${legDate(extra[i].url)} search — click to open it`;
      c.onclick = () => { location.href = extra[i].url; };
      return c;
    }));
    status.textContent = `+${merged.length} flight(s) from other days (blue edge)`;
  }

  if (active() && st.extra.length) merge(st);
})();
