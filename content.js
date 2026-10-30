// Google Flights allows one hour range per leg for departure and one for
// arrival, within a single day; wrapping ranges are rejected and repeated
// range fields are last-wins. Arrival ranges are also time-of-day only, so
// "arrive 1-3 AM" matches 1 AM on +1 and on +2 alike.
//
// So a window like "23-2 starting day +1" is split into non-wrapping pieces,
// each pinned to an absolute day: departure pieces search that date;
// arrival pieces search the page's date and keep only rows whose arrival
// marker (+N) is that day. The first piece loads in this page, the rest in
// hidden iframes whose rows are cloned into this page.
(() => {
  const KEY = 'gf-ranges';
  const FIELDS = { dep: [8, 9], arr: [10, 11] }; // first-leg [start, end] hour fields, end inclusive
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

  // "23-2, 6-9" starting `day` days after the search date -> [{url, arrDay}], one per
  // non-wrapping piece. End hour is exclusive; 0 = midnight. arrDay: required +N, or null.
  function searches(url, kind, spec, day) {
    return spec.split(',').flatMap(r => {
      const [a, b0] = r.split('-').map(Number), b = b0 || 24;
      if (!(a >= 0 && a < 24 && b > 0 && b <= 24 && a !== b)) throw new Error(`bad range "${r.trim()}"`);
      const piece = (range, d) => kind === 'dep'
        ? { url: withLeg(url, kind, range, d), arrDay: null }
        : { url: withLeg(url, kind, range), arrDay: d };
      return a < b ? [piece([a, b - 1], day)] : [piece([a, 23], day), piece([0, b - 1], day + 1)];
    });
  }

  // Arrival day marker after the arrival time: "8:40 AM+2" -> 2, none -> 0. One digit only:
  // some renderings run text together ("11:00 PM+111:00 PM on Sun").
  const arrDayOf = li => +((li.innerText.match(/–\s*\d{1,2}:\d\d[^\n+-]*([+-]\d)?/) || [])[1] || 0);
  const rows = doc => [...doc.querySelectorAll('ul > li')].filter(li => /\d:\d\d/.test(li.innerText));
  const keep = (li, arrDay) => arrDay == null || arrDayOf(li) === arrDay;

  // --- UI (built without innerHTML: Google enforces Trusted Types) ---
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const select = opts => el('select', {}, ...opts.map(([value, text]) => el('option', { value, text })));
  const st = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  const kindSel = select([['dep', 'Depart'], ['arr', 'Arrive']]);
  const specIn = el('input', { size: 10, placeholder: '23-2, 6-9' });
  const daySel = select([0, 1, 2, 3].map(d => [d, d ? `+${d} day` : 'search date']));
  const applyBtn = el('button', { textContent: 'Apply' }), clearBtn = el('button', { textContent: 'Clear' });
  const status = el('div');
  const panel = el('div', {}, kindSel, ' ', specIn, ' starting ', daySel, ' ', applyBtn, ' ', clearBtn, status);
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;background:#fff;color:#202124;' +
    'font:13px sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  kindSel.value = st?.kind ?? 'dep';
  specIn.value = st?.spec ?? '23-2';
  daySel.value = st?.day ?? 0;
  document.body.append(panel);

  applyBtn.onclick = () => {
    try {
      const [main, ...extra] = searches(location.href, kindSel.value, specIn.value, +daySel.value);
      sessionStorage.setItem(KEY, JSON.stringify({
        tfs: tfs(main.url), arrDay: main.arrDay, extra, kind: kindSel.value, spec: specIn.value, day: +daySel.value,
      }));
      location.href = main.url;
    } catch (e) { status.textContent = e.message; }
  };
  clearBtn.onclick = () => {
    sessionStorage.removeItem(KEY);
    location.href = withLeg(location.href, kindSel.value, null);
  };
  specIn.onkeydown = e => e.key === 'Enter' && applyBtn.click();

  // Hide off search pages; keep this page's own rows filtered to the right arrival day
  // (Google re-renders on "View more flights"); drop it all once the SPA moves on.
  setInterval(() => {
    panel.hidden = !tfs();
    if (!st) return;
    const active = tfs() === st.tfs;
    if (!active) document.querySelectorAll('.gf-merged').forEach(e => e.remove());
    for (const li of rows(document)) {
      if (!li.classList.contains('gf-merged')) li.style.display = !active || keep(li, st.arrDay) ? '' : 'none';
    }
  }, 1000);

  // --- merge extra searches ---
  async function fetchRows({ url, arrDay }) {
    const f = el('iframe', { src: url });
    f.style.cssText = 'position:fixed;left:-9999px;width:1200px;height:900px';
    document.body.append(f);
    await new Promise(r => { f.onload = r; });
    const d = f.contentDocument;
    await until(() => rows(d).length || /no (results|options)/i.test(d.body.innerText));
    const more = [...d.querySelectorAll('button')].find(b => /more flights/i.test(b.innerText));
    if (more) { more.click(); await sleep(2000); }
    const found = rows(d).filter(li => keep(li, arrDay)).map(li => document.importNode(li, true));
    f.remove();
    return found;
  }

  async function merge({ extra }) {
    status.textContent = `Loading ${extra.length} more search(es)…`;
    const results = await Promise.all(extra.map(fetchRows));
    const list = await until(() => rows(document)[0]?.parentElement, 10000) ||
      (document.querySelector('[role=main]') || document.body).appendChild(el('ul'));
    results.forEach((found, i) => {
      const { url } = extra[i];
      for (const c of found.reverse()) {
        c.classList.add('gf-merged');
        c.style.cssText = 'cursor:pointer;box-shadow:inset 4px 0 #1a73e8';
        c.title = `From the ${legDate(url)} search — click to open it`;
        c.onclick = () => { location.href = url; };
        list.prepend(c);
      }
    });
    status.textContent = `+${results.flat().length} flight(s) from other pieces (blue edge)`;
  }

  if (st?.extra?.length && tfs() === st.tfs) merge(st);
})();
