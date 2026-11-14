/* ═══════════════════════════════════════════════════════════════════════════
   MSFS Manager — phone layout (behaviour). Loaded by index.html after aitm.js.
   Does nothing unless <html> has the class "m" (set in the <head> on phones).
   Everything here only re-arranges what index.html / aitm.js already render —
   data, cloud sync and all functions are the desktop ones, so a change made on
   the PC shows up here without extra work. The layout rules are in mobile.css.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var HTML = document.documentElement;
  var LS = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // On a phone that was switched to the desktop layout: a small button to come back.
  if (!HTML.classList.contains('m')) {
    if (LS.get('mm_force') === '0' && Math.min(screen.width, screen.height) <= 500) {
      var back = document.createElement('button');
      back.textContent = '📱 Mobile view';
      back.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:9999;padding:9px 14px;border-radius:20px;border:1px solid #7d5ee8;background:#241c45;color:#fff;font-size:13px;font-weight:600;';
      back.onclick = function () { LS.set('mm_force', ''); location.href = location.pathname; };
      document.body.appendChild(back);
    }
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  var W = window;

  // the page must not zoom when a field gets the focus, and may use the area beside the notch
  var vp = document.querySelector('meta[name=viewport]');
  if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
  [['apple-mobile-web-app-capable', 'yes'], ['mobile-web-app-capable', 'yes'], ['apple-mobile-web-app-status-bar-style', 'black-translucent'], ['theme-color', '#161b22'], ['apple-mobile-web-app-title', 'MSFS Manager']].forEach(function (m) {
    var t = document.createElement('meta'); t.name = m[0]; t.content = m[1]; document.head.appendChild(t);
  });
  var ati = document.querySelector('link[rel="apple-touch-icon"]'); if (ati) ati.href = 'apple-touch-icon.png';

  var kick = function (ms) { setTimeout(function () { W.dispatchEvent(new Event('resize')); }, ms || 0); };   // maps re-measure themselves

  /* ── toast ─────────────────────────────────────────────────────────────── */
  var toastT;
  function toast(msg, ms) {
    var t = $('m-toast'); if (!t) { t = el('div'); t.id = 'm-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, ms || 2600);
  }

  /* ── sheet ─────────────────────────────────────────────────────────────── */
  function sheet(title, body) {
    var ov = el('div', 'm-ov'), sh = el('div', 'm-sheet');
    var grip = el('div', 'm-sheet-grip', '<i></i>'), head = el('div', 'm-sheet-h'), b = el('div', 'm-sheet-b');
    var ttl = el('span'); ttl.textContent = title || ''; var x = el('button', 'm-sheet-x', '✕');
    head.appendChild(ttl); head.appendChild(x); sh.appendChild(grip); if (title) sh.appendChild(head); sh.appendChild(b);
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
    document.body.appendChild(ov); document.body.appendChild(sh);
    requestAnimationFrame(function () { ov.classList.add('on'); sh.classList.add('on'); });
    var closed = false;
    function close() { if (closed) return; closed = true; ov.classList.remove('on'); sh.classList.remove('on'); sh.style.transform = ''; setTimeout(function () { ov.remove(); sh.remove(); }, 240); }
    ov.onclick = close; x.onclick = close;
    var y0 = null, dy = 0;                                                  // pull the grip down to close
    grip.addEventListener('touchstart', function (e) { y0 = e.touches[0].clientY; dy = 0; sh.style.transition = 'none'; }, { passive: true });
    grip.addEventListener('touchmove', function (e) { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = 'translateY(' + dy + 'px)'; }, { passive: true });
    grip.addEventListener('touchend', function () { sh.style.transition = ''; if (dy > 70) close(); else sh.style.transform = ''; y0 = null; });
    return { close: close, body: b, el: sh };
  }

  /* ── grip: a bar that opens, shuts and resizes the panel next to it ──────
     snaps: heights in px (numbers > 1) or parts of the usable height (≤ 1). */
  function grip(opts) {
    var pane = opts.pane; if (!pane || pane._mGrip) return pane && pane._mGrip;
    var g = el('div', 'm-grip', '<i></i>' + (opts.label ? '<span>' + opts.label + '</span><i></i>' : ''));
    if (opts.id) g.id = opts.id;
    pane.classList.add('m-drawer');
    if (opts.side === 'above') pane.parentNode.insertBefore(g, pane); else pane.parentNode.insertBefore(g, pane.nextSibling);
    var avail = function () { return Math.max(200, W.innerHeight - 30 - 54 - 60); };
    var px = function (s) { return s <= 1 ? Math.round(avail() * s) : s; };
    var key = 'mm_grip_' + opts.key, idx = parseInt(LS.get(key), 10); if (isNaN(idx) || idx < 0 || idx >= opts.snaps.length) idx = opts.def == null ? 1 : opts.def;
    function apply(h, live) {
      pane.style.setProperty('flex', '0 0 ' + h + 'px', 'important'); pane.style.setProperty('height', h + 'px', 'important'); pane.style.setProperty('min-height', '0', 'important');
      pane.classList.toggle('m-drawer-0', h < 4);
      if (!live) { kick(230); if (opts.onChange) setTimeout(function () { opts.onChange(h); }, 240); }
    }
    function set(i) { idx = (i + opts.snaps.length) % opts.snaps.length; LS.set(key, String(idx)); apply(px(opts.snaps[idx])); }
    var y0 = null, h0 = 0, moved = false, cur = 0;
    g.addEventListener('pointerdown', function (e) { y0 = e.clientY; h0 = pane.getBoundingClientRect().height; moved = false; cur = h0; try { g.setPointerCapture(e.pointerId); } catch (x) {} g.classList.add('drag'); pane.classList.add('drag'); });
    g.addEventListener('pointermove', function (e) {
      if (y0 == null) return; var d = e.clientY - y0; if (Math.abs(d) > 6) moved = true; if (!moved) return;
      cur = Math.max(0, Math.min(avail(), h0 + (opts.side === 'above' ? -d : d))); apply(cur, true);
    });
    var up = function () {
      if (y0 == null) return; y0 = null; g.classList.remove('drag'); pane.classList.remove('drag');
      if (!moved) { set(idx + 1); return; }
      var best = 0, bd = 1e9; opts.snaps.forEach(function (s, i) { var d = Math.abs(px(s) - cur); if (d < bd) { bd = d; best = i; } }); set(best);
    };
    g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    W.addEventListener('orientationchange', function () { setTimeout(function () { apply(px(opts.snaps[idx])); }, 300); });
    apply(px(opts.snaps[idx]));
    pane._mGrip = { el: g, set: set, open: function () { if (px(opts.snaps[idx]) < 40) set(opts.def == null ? 1 : opts.def || 1); }, get: function () { return idx; } };
    return pane._mGrip;
  }

  /* ── fold: a header that shows / hides the block(s) below it ─────────────── */
  function fold(key, title, targets, shutByDefault, info) {
    var h = el('div', 'm-fold-h'); h.appendChild(document.createTextNode(title)); var em = el('em'); h.appendChild(em);
    var k = 'mm_fold_' + key, shut = LS.get(k) == null ? !!shutByDefault : LS.get(k) === '1';
    function apply() { h.classList.toggle('shut', shut); targets.forEach(function (t) { if (t) t.classList.toggle('m-shut', shut); }); em.textContent = shut && info ? (info() || '') : ''; }
    h.onclick = function () { shut = !shut; LS.set(k, shut ? '1' : '0'); apply(); kick(60); };
    apply();
    h._mFold = { set: function (s) { shut = !!s; apply(); }, refresh: apply };
    return h;
  }

  /* ── seg: a row of buttons, one of them active ───────────────────────────── */
  function seg(items, onPick, cls) {
    var s = el('div', cls || 'm-seg');
    items.forEach(function (it, i) { var b = el('button', '', it.label); b.dataset.k = it.key; b.onclick = function () { pick(it.key); }; s.appendChild(b); });
    function pick(k, silent) { Array.prototype.forEach.call(s.children, function (b) { b.classList.toggle('on', b.dataset.k === k); }); s._k = k; if (!silent && onPick) onPick(k); }
    s._pick = pick; return s;
  }

  /* ── watch: run fn whenever the children of a container are rebuilt ─────── */
  function watch(node, fn, deep) {
    if (!node) return; var t = 0, busy = false;
    var run = function () { t = 0; busy = true; try { fn(node); } catch (e) { console.warn('mobile:', e); } busy = false; };
    new MutationObserver(function () { if (busy) return; if (!t) t = setTimeout(run, 0); }).observe(node, { childList: true, subtree: !!deep });
    run();
  }

  /* ── touch stand-ins for the mouse: double tap = double click, long press = right click ── */
  (function () {
    var lastT = 0, lastEl = null, lastXY = [0, 0], nativeDbl = 0, lp = null, lpFired = false, start = null;
    document.addEventListener('dblclick', function (e) { if (e.isTrusted) nativeDbl = Date.now(); }, true);
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { clearTimeout(lp); return; }
      var t = e.touches[0], target = e.target; start = [t.clientX, t.clientY]; lpFired = false;
      clearTimeout(lp);
      lp = setTimeout(function () {
        if (!target.isConnected || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('.leaflet-container,.m-grip,#m-tabs,[draggable="true"]')) return;
        lpFired = true; if (navigator.vibrate) try { navigator.vibrate(12); } catch (x) {}
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: W, clientX: start[0], clientY: start[1], button: 2 }));
      }, 520);
    }, { passive: true, capture: true });
    document.addEventListener('touchmove', function (e) { if (!start) return; var t = e.touches[0]; if (Math.abs(t.clientX - start[0]) > 9 || Math.abs(t.clientY - start[1]) > 9) clearTimeout(lp); }, { passive: true, capture: true });
    document.addEventListener('touchend', function () { clearTimeout(lp); }, { passive: true, capture: true });
    document.addEventListener('touchcancel', function () { clearTimeout(lp); }, { passive: true, capture: true });
    document.addEventListener('contextmenu', function (e) { if (e.isTrusted && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault(); }, false);   // no "copy / look up" bubble over the app
    document.addEventListener('click', function (e) {
      if (!e.isTrusted) return;
      if (lpFired) { lpFired = false; e.preventDefault(); e.stopPropagation(); return; }       // the tap that ended a long press
      var now = Date.now(), same = lastEl && (e.target === lastEl || (lastEl.contains && (lastEl.contains(e.target) || e.target.contains(lastEl))));
      if (same && now - lastT < 380 && Math.abs(e.clientX - lastXY[0]) < 28 && Math.abs(e.clientY - lastXY[1]) < 28) {
        var target = e.target; lastT = 0;
        setTimeout(function () { if (Date.now() - nativeDbl > 300 && target.isConnected) target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: W, clientX: e.clientX, clientY: e.clientY, detail: 2 })); }, 30);
      } else { lastT = now; lastEl = e.target; lastXY = [e.clientX, e.clientY]; }
    }, true);
  })();


  /* ── dragging with a finger ───────────────────────────────────────────────
     The Rotation Planner and the AI Traffic Manager use the browser's drag & drop,
     which phones do not offer for web pages in a usable way. Here: press and hold
     (about a third of a second) lifts the item, moving the finger drags it, lifting
     the finger drops it. The page's own dragstart / dragover / drop code runs unchanged.
     Press and hold without moving = right click (context menu). */
  (function () {
    var st = null, swallow = 0;
    function DT() { this._d = {}; this.types = []; this.effectAllowed = 'all'; this.dropEffect = 'move'; this.files = []; this.items = []; }
    DT.prototype.setData = function (t, v) { this._d[t] = String(v); if (this.types.indexOf(t) < 0) this.types.push(t); };
    DT.prototype.getData = function (t) { return this._d[t] == null ? '' : this._d[t]; };
    DT.prototype.clearData = function (t) { if (t) { delete this._d[t]; this.types = this.types.filter(function (x) { return x !== t; }); } else { this._d = {}; this.types = []; } };
    DT.prototype.setDragImage = function () {};
    function fire(type, target, x, y) {
      var e = new MouseEvent(type, { bubbles: true, cancelable: true, view: W, clientX: x, clientY: y, screenX: x, screenY: y });
      Object.defineProperty(e, 'dataTransfer', { value: st.dt });
      (target && target.isConnected ? target : document.body).dispatchEvent(e); return e;
    }
    function scroller(n, x, y) {                                               // nearest scrolling box under the finger whose edge is close
      for (; n && n !== document.body; n = n.parentElement) {
        var cs = getComputedStyle(n), r;
        if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) { r = n.getBoundingClientRect(); if (y < r.top + 46) return [n, 0, -1]; if (y > r.bottom - 46) return [n, 0, 1]; }
        if (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 4) { r = n.getBoundingClientRect(); if (x < r.left + 40) return [n, -1, 0]; if (x > r.right - 40) return [n, 1, 0]; }
      }
      return null;
    }
    function end(drop) {
      var s = st; if (!s) return; clearTimeout(s.timer); clearInterval(s.auto);
      if (s.active) {
        if (drop && s.moved && s.over && s.can) fire('drop', s.over, s.x, s.y); else if (s.over) fire('dragleave', s.over, s.x, s.y);
        fire('dragend', s.src, s.x, s.y);
        if (s.ghost) s.ghost.remove(); s.src.classList.remove('m-dragging'); document.body.classList.remove('m-drag-on');
        swallow = Date.now();
        if (drop && !s.moved) { st = null; s.src.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: W, clientX: s.x, clientY: s.y, button: 2 })); return; }
      }
      st = null;
    }
    document.addEventListener('dragstart', function (e) { if (e.isTrusted) { e.preventDefault(); e.stopPropagation(); } }, true);    // the browser's own drag stays out of it
    document.addEventListener('touchstart', function (e) {
      if (st) end(false);
      if (e.touches.length !== 1) return;
      var src = e.target.closest && e.target.closest('[draggable="true"]'); if (!src || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      var t = e.touches[0];
      st = { src: src, x: t.clientX, y: t.clientY, x0: t.clientX, y0: t.clientY, active: false, moved: false, over: null, can: false, dt: new DT() };
      st.timer = setTimeout(function () {
        var s = st; if (!s || !s.src.isConnected) { st = null; return; }
        var ev = fire('dragstart', s.src, s.x, s.y); if (ev.defaultPrevented) { st = null; return; }
        s.active = true; if (navigator.vibrate) try { navigator.vibrate(10); } catch (x) {}
        var r = s.src.getBoundingClientRect(), g = s.src.cloneNode(true);
        g.className += ' m-ghost'; g.removeAttribute('id'); g.removeAttribute('draggable'); [['position', 'fixed'], ['width', Math.min(r.width, W.innerWidth * 0.7) + 'px'], ['height', Math.min(r.height, 90) + 'px'], ['left', s.x + 'px'], ['top', s.y + 'px'], ['margin', '0'], ['opacity', '.85'], ['z-index', '10050'], ['pointer-events', 'none']].forEach(function (p) { g.style.setProperty(p[0], p[1], 'important'); });
        document.body.appendChild(g); s.ghost = g; s.src.classList.add('m-dragging'); document.body.classList.add('m-drag-on');
        s.auto = setInterval(function () { if (!st || !st.sc) return; st.sc[0].scrollLeft += st.sc[1] * 14; st.sc[0].scrollTop += st.sc[2] * 14; }, 30);
      }, 300);
    }, { passive: true, capture: true });
    document.addEventListener('touchmove', function (e) {
      var s = st; if (!s) return; var t = e.touches[0];
      if (!s.active) { if (Math.abs(t.clientX - s.x0) > 9 || Math.abs(t.clientY - s.y0) > 9) { clearTimeout(s.timer); st = null; } return; }
      e.preventDefault();
      s.x = t.clientX; s.y = t.clientY; if (Math.abs(s.x - s.x0) > 8 || Math.abs(s.y - s.y0) > 8) s.moved = true;
      s.ghost.style.left = s.x + 'px'; s.ghost.style.top = s.y + 'px';
      var under = document.elementFromPoint(s.x, s.y);
      if (under !== s.over) { if (s.over) fire('dragleave', s.over, s.x, s.y); s.over = under; if (under) fire('dragenter', under, s.x, s.y); }
      if (under) s.can = fire('dragover', under, s.x, s.y).defaultPrevented;
      s.sc = scroller(under, s.x, s.y);
    }, { passive: false, capture: true });
    document.addEventListener('touchend', function () { end(true); }, true);
    document.addEventListener('touchcancel', function () { end(false); }, true);
    document.addEventListener('click', function (e) { if (e.isTrusted && Date.now() - swallow < 350) { e.preventDefault(); e.stopPropagation(); } }, true);
  })();

  /* ═══ shell: status strip, tab bar, "More" ═════════════════════════════════ */
  var VIEWS = {
    logbook: 'Logbook', dashboard: 'Next Destination', roster: 'Legs', aigen: 'AI Generator', rotations: 'Rotation Planner', aitm: 'AI Traffic Manager',
    operations: 'MSFS Operations', settings: 'MSFS Settings', sceneries: 'Sceneries', fleet: 'Fleet', categories: 'Data', data: 'Data', calc: 'Calculator', tovisit: 'To Visit'
  };
  var TABS = [['dashboard', 'Next'], ['roster', 'Legs'], ['logbook', 'Logbook'], ['aigen', 'AI Gen'], ['more', 'More']];
  var MORE = [['operations', 'MSFS Operations'], ['settings', 'MSFS Settings'], ['sceneries', 'Sceneries'], ['fleet', 'Fleet'], ['categories', 'Data'], ['aitm', 'AI Traffic Manager']];
  var icon = function (v) { var s = document.querySelector('#t-' + v + ' svg'); return s ? s.outerHTML : ''; };
  var MORE_ICON = '<svg viewBox="0 0 24 24" stroke-width="2"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

  var top = el('div'); top.id = 'm-top'; top.innerHTML = '<div id="m-title"></div><div id="m-sub"></div>';
  document.body.appendChild(top);
  var cs = $('cloud-status'); if (cs) top.appendChild(cs);

  var tabs = el('div'); tabs.id = 'm-tabs';
  TABS.forEach(function (t) {
    var b = el('button', 'm-tab', (t[0] === 'more' ? MORE_ICON : icon(t[0])) + '<span>' + t[1] + '</span>'); b.dataset.v = t[0];
    b.onclick = function () { if (t[0] === 'more') openMore(); else go(t[0]); };
    tabs.appendChild(b);
  });
  document.body.appendChild(tabs);

  function go(v) { try { W.switchView(v); } catch (e) { console.warn('mobile: switchView', v, e); } }

  var moreSheet = null;
  function openMore() {
    var box = el('div');
    var g = el('div', 'm-more');
    MORE.forEach(function (m) {
      var b = el('button', W.currentViewM === m[0] ? 'on' : '', icon(m[0]) + '<span>' + m[1] + '</span>');
      b.onclick = function () { moreSheet.close(); go(m[0]); }; g.appendChild(b);
    });
    box.appendChild(g);
    box.appendChild(el('div', 'm-more-sec', 'This phone'));
    var l = el('div', 'm-list');
    var item = function (ic, t, sub, fn) { var b = el('button', '', '<span class="m-ic">' + ic + '</span><span><b>' + t + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>'); b.onclick = function () { moreSheet.close(); setTimeout(fn, 120); }; l.appendChild(b); };
    item('🔑', 'API keys', 'Anthropic key for block times, GitHub token for logos', function () { if (W.openApiKeyDialog) W.openApiKeyDialog(); });
    item('⟳', 'Reload', 'Fetch the newest version and the newest data from the cloud', function () { location.reload(); });
    item('🖥', 'Desktop layout', 'Show the PC layout on this phone (a button brings you back)', function () { LS.set('mm_force', '0'); location.href = location.pathname; });
    box.appendChild(l);
    moreSheet = sheet('More', box);
  }

  var enhancers = {};                      // per view: run once when the view is first shown
  var onShow = {};                         // per view: run every time it is shown
  var done = {};
  function afterSwitch(v) {
    W.currentViewM = v;
    HTML.setAttribute('data-mv', v);
    $('m-title').textContent = VIEWS[v] || v;
    $('m-sub').textContent = '';
    var tabOf = v === 'rotations' ? 'aigen' : v, inTabs = TABS.some(function (t) { return t[0] === tabOf; });
    Array.prototype.forEach.call(tabs.children, function (b) { b.classList.toggle('on', b.dataset.v === tabOf || (!inTabs && b.dataset.v === 'more')); });
    if (!done[v] && enhancers[v]) { done[v] = true; try { enhancers[v](); } catch (e) { console.warn('mobile: enhance', v, e); } }
    if (onShow[v]) try { onShow[v](); } catch (e) { console.warn('mobile: show', v, e); }
    if (v !== 'rotations') LS.set('mm_view', v);
    kick(60); kick(400);
  }
  var _sv = W.switchView;
  W.switchView = function (v) { var r; try { r = _sv.apply(this, arguments); } finally { afterSwitch(v); } return r; };

  /* ═══ NEXT DESTINATION (and the shared map of the Data page) ═══════════════ */
  var mapCol = document.querySelector('.map-col');
  var mapGrip = grip({ pane: mapCol, key: 'map', id: 'm-grip-map', snaps: [0, 150, 0.6], def: 1, label: 'Map' });
  // the map column is hidden on the full-page views — its grip goes with it
  var syncMapGrip = function () { var g = $('m-grip-map'); if (g) g.style.display = getComputedStyle(mapCol).display === 'none' ? 'none' : ''; };
  new MutationObserver(syncMapGrip).observe(mapCol, { attributes: true, attributeFilter: ['style'] });

  enhancers.categories = function () {
    var _show = W.showCategoryOnMap;
    if (_show) W.showCategoryOnMap = function () { mapGrip.open(); var a = arguments, me = this; setTimeout(function () { _show.apply(me, a); }, 260); };
  };

  /* ═══ LEGS ══════════════════════════════════════════════════════════════════ */
  var LEG_CLS = ['m-leg-logo', 'm-leg-al', 'm-leg-dep', 'm-leg-dt', 'm-leg-bt', 'm-leg-arr', 'm-leg-at', 'm-leg-tg', 'm-leg-sf', 'm-leg-nav', 'm-leg-del'];
  enhancers.roster = function () {
    watch($('legs-container'), function (c) {
      Array.prototype.forEach.call(c.children, function (row) {
        if (row.children.length === LEG_CLS.length && !row.classList.contains('m-leg')) {
          row.classList.add('m-leg'); LEG_CLS.forEach(function (cl, i) { row.children[i].classList.add(cl); });
        } else if (row.children.length < 3 && row.querySelector('button')) row.classList.add('m-leg-ins');
      });
    });
    var wrap = document.querySelector('.roster-map-wrap');
    grip({ pane: wrap, key: 'legsmap', side: 'above', snaps: [0, 200, 0.62], def: 1, label: 'Map' });
  };

  /* ═══ LOGBOOK ═══════════════════════════════════════════════════════════════ */
  enhancers.logbook = function () {
    var body = document.querySelector('#view-logbook .logbook-body'); if (body && body.parentNode) body.parentNode.id = 'm-lb-top';
    watch($('lb-body'), function (tb) { Array.prototype.forEach.call(tb.rows, function (r) { r.classList.toggle('m-planned', !!r.querySelector('button[onclick^="markFlightLanded"]')); }); });
    var maps = $('lb-maps');
    var s = seg([{ key: 'world', label: 'World' }, { key: 'eu', label: 'Europe' }], function (k) { maps.classList.toggle('m-eu', k === 'eu'); LS.set('mm_lbmap', k); kick(30); }, 'm-float-seg');
    maps.appendChild(s); var k0 = LS.get('mm_lbmap') === 'eu' ? 'eu' : 'world'; s._pick(k0, true); maps.classList.toggle('m-eu', k0 === 'eu');
    grip({ pane: maps, key: 'lbmap', side: 'above', snaps: [0, 240, 0.62], def: 1, label: 'Map' });
    var add = document.querySelector('.logbook-toolbar .btn-toolbar-purple'); if (add) add.textContent = '⊕ Add leg';
  };


  /* ── "Tab in the last row adds a row" has no key on a phone: a button does it ── */
  function tabKey(node) { if (node) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); }
  function addRowButtons(root, pickField) {
    Array.prototype.forEach.call(root.querySelectorAll('div'), function (h) {
      if (h.children.length || h._mAdd || !/Press Tab in the last/.test(h.textContent)) return;
      h._mAdd = true; h.classList.add('m-hint-tab');
      var b = el('button', 'm-addrow', '+ Add row');
      b.onclick = function () {
        var tbl = h.previousElementSibling; while (tbl && tbl.tagName !== 'TABLE') tbl = tbl.previousElementSibling; if (!tbl) return;
        var last = tbl.tBodies[0] && tbl.tBodies[0].lastElementChild; if (!last) return;
        var n0 = tbl.tBodies[0].children.length;
        tabKey(pickField ? pickField(last) : last.querySelector('input,textarea'));
        setTimeout(function () { var tb = (h.previousElementSibling && h.parentNode.querySelector('table') || tbl).tBodies[0]; var f = tb && tb.lastElementChild && tb.lastElementChild.querySelector('input,textarea'); if (f && tb.children.length > n0) f.focus(); }, 60);
      };
      h.parentNode.insertBefore(b, h);
    });
  }

  /* ═══ MSFS OPERATIONS ═══════════════════════════════════════════════════════ */
  var opsOpen = {};
  enhancers.operations = function () {
    var tag = function () {
      var root = $('view-operations'); if (!root) return;
      addRowButtons(root);
      Array.prototype.forEach.call(root.querySelectorAll('.ops-parking'), function (p) {
        var head = p.firstElementChild; if (!head || head.querySelector('.m-chev')) return;
        var inp = head.querySelector('input'), name = function () { return inp ? inp.value : ''; };
        var n = p.querySelectorAll('tbody tr').length;
        var c = el('button', 'm-chev', n + ' rows<b>▾</b>');
        c.onclick = function () { var o = p.classList.toggle('m-open'); opsOpen[name()] = o; };
        head.appendChild(c);
        if (inp) inp.readOnly = !opsOpen[name()];
        if (opsOpen[name()]) p.classList.add('m-open');
        // a closed table opens with a tap anywhere on its title; an open one lets the title be edited
        head.addEventListener('click', function (e) { if (e.target === c || c.contains(e.target)) { if (inp) inp.readOnly = !p.classList.contains('m-open'); return; } if (!p.classList.contains('m-open')) { p.classList.add('m-open'); opsOpen[name()] = true; if (inp) { inp.readOnly = false; inp.blur(); } } });
      });
    };
    watch($('ops-tables'), tag, true); watch($('ops-todos'), tag, true);
  };

  /* ═══ MSFS SETTINGS: one PC at a time, or all three side by side ════════════ */
  enhancers.settings = function () {
    var t = document.querySelector('#view-settings table.mset'); if (!t) return;
    var names = Array.prototype.slice.call(t.tHead.rows[0].cells, 1).map(function (th) { var s = th.querySelector('span'); return (s ? s.textContent : th.textContent).replace(/^[^A-Za-zÀ-ÿ]+/, '').trim(); });
    var items = names.map(function (n, i) { return { key: 'c' + (i + 1), label: n.replace('PARIS – ', 'Paris ').replace('SUISSE', 'Suisse') }; }); items.push({ key: 'call', label: 'All' });
    var wrap = el('div', 'm-set-scroll'); t.parentNode.insertBefore(wrap, t); wrap.appendChild(t);
    var s = seg(items, function (k) { t.className = 'mset m-' + k; LS.set('mm_set', k); });
    s.id = 'm-set-seg'; wrap.parentNode.insertBefore(s, wrap);
    var k0 = LS.get('mm_set') || 'c1'; s._pick(k0, true); t.className = 'mset m-' + k0;
  };

  /* ═══ SCENERIES ═════════════════════════════════════════════════════════════ */
  enhancers.sceneries = function () {
    var v = $('view-sceneries'); grip({ pane: v.firstElementChild, key: 'scmap', snaps: [0, 200, 0.6], def: 1, label: 'Map' });
    watch($('sceneries-table'), function (root) {
      Array.prototype.forEach.call(root.querySelectorAll('div'), function (h) {
        if (h.children.length || h._mAdd || !/Press Tab in the last/.test(h.textContent)) return;
        h._mAdd = true; h.textContent = 'Type a 4-letter ICAO — the airport name fills in automatically.';
        var b = el('button', 'm-addrow', '+ Add scenery');
        b.onclick = function () { var tb = root.querySelector('tbody'), last = tb && tb.lastElementChild; if (!last) return; var f = last.querySelectorAll('input,textarea'); tabKey(f[f.length - 1]); setTimeout(function () { var l = root.querySelector('tbody').lastElementChild, i = l && l.querySelector('input'); if (i) i.focus(); }, 60); };
        h.parentNode.insertBefore(b, h);
      });
    }, true);
  };

  /* ═══ FLEET: sort buttons instead of the column heads ═══════════════════════ */
  enhancers.fleet = function () {
    watch($('fleet-list'), function (root) {
      Array.prototype.forEach.call(root.querySelectorAll('thead th'), function (th, i) {
        var b = th.querySelector('button'); if (!b || th.classList.contains('m-sort')) return;
        th.classList.add('m-sort'); if (!/[A-Za-z]/.test(b.textContent)) b.textContent = (i === 1 ? 'Type ' : 'Source ') + b.textContent;
      });
    });
  };


  /* ═══ AI GENERATOR: the set-up block folds away, the route rows swipe sideways ═ */
  enhancers.aigen = function () {
    var val = function (id) { var e = $(id); return e && e.value ? e.value.toUpperCase() : ''; };
    [['aigen-airline-mode', 'al', function () { return [val('aigen-al-input'), val('aigen-al-hub-input')].filter(Boolean).join(' · '); }],
     ['aigen-airport-mode', 'ap', function () { var b = $('aigen-ap-box'); return val('aigen-ap-input') || (b ? b.textContent.trim().slice(0, 24) : ''); }]].forEach(function (m) {
      var mode = $(m[0]), head = mode && mode.firstElementChild; if (!head) return;
      head.classList.add('m-setup');
      var f = fold('aigen_' + m[1], 'Set-up', [head], false, m[2]); mode.insertBefore(f, head);
      mode.addEventListener('change', function () { f._mFold.refresh(); });
    });
    var hint = function (c) { if (!c || c._mHint) return; c._mHint = true; var h = el('div', 'm-swipe-hint', '⇆ swipe a route sideways to reach all its fields'); c.parentNode.insertBefore(h, c); };
    hint($('aigen-al-legs-container')); hint($('aigen-legs-container'));
  };

  /* ═══ ROTATION PLANNER ══════════════════════════════════════════════════════ */
  enhancers.rotations = function () {
    var v = $('view-rotations'), bars = $('rot-bars-container'), lanes = $('rot-lanes-container'); if (!bars || !lanes) return;
    var topPane = bars.parentNode, bottom = lanes.parentNode; topPane.id = 'm-rot-top'; bottom.id = 'm-rot-bottom';
    var back = v.querySelector('button[onclick*="switchView(\'aigen\')"]'); if (back) back.textContent = '← Routes';
    grip({ pane: topPane, key: 'rot', snaps: [0, 0.42, 0.8], def: 1, label: 'Time bars ▲ · Aircraft ▼' });
  };

  /* ═══ AI TRAFFIC MANAGER: one column at a time ══════════════════════════════ */
  enhancers.aitm = function () {
    var v = $('view-aitm'), cols = v.querySelector('.aitm-col'); if (!cols) return; cols = cols.parentNode; cols.id = 'm-aitm-cols';
    var status = $('aitm-status'), toolbar = v.firstElementChild; toolbar.id = 'm-aitm-tools'; if (status) v.insertBefore(status, toolbar.nextSibling);
    var cnt = function (id) { var e = $(id); return e ? e.children.length : 0; };
    var s = seg([{ key: 'k1', label: 'Legs' }, { key: 'k2', label: 'Airports' }, { key: 'k3', label: 'Aircraft ⇄ Fleet' }], function (k) { cols.className = 'm-' + k; LS.set('mm_aitm', k); });
    v.insertBefore(s, cols); var k0 = LS.get('mm_aitm') || 'k1'; s._pick(k0, true); cols.className = 'm-' + k0;
    var head = $('aitm-head'); if (head) v.insertBefore(fold('aitm_head', 'Flight plan', [head], false, function () { var c = $('aitm-legs-count'); return c ? c.textContent : ''; }), head);
    var bar = v.lastElementChild; if (bar && bar.querySelector('#aitm-compile')) { bar.id = 'm-aitm-bar'; v.insertBefore(fold('aitm_bar', 'Check · Sort · Compile · Save', [bar], true), bar); }
    if (!W.showDirectoryPicker && !LS.get('mm_aitm_note')) {
      var n = el('div', 'm-note', '<u>✕</u><b>On the phone:</b> you can look at a plan and change it here. Reading your installed aircraft and writing the BGL into the simulator\'s folders needs Chrome on the PC — on the phone, Compile and Save txt download the files instead.');
      n.querySelector('u').onclick = function () { n.remove(); LS.set('mm_aitm_note', '1'); }; v.insertBefore(n, v.firstElementChild);
    }
  };

  /* ═══ start ═════════════════════════════════════════════════════════════════ */
  W.mMobile = { sheet: sheet, grip: grip, fold: fold, seg: seg, watch: watch, toast: toast, enhancers: enhancers, onShow: onShow, go: go, kick: kick, el: el, LS: LS };
  var cur0 = 'logbook'; try { cur0 = currentView || 'logbook'; } catch (e) {}
  var first = LS.get('mm_view'); if (!first || !VIEWS[first] || !$('view-' + first)) first = cur0;
  var boot = function () { try { W.switchView(first); } catch (e) { console.warn('mobile: start', e); afterSwitch(cur0); } };
  boot();
})();
