// ═══════════════════════════════════════════════════════════
// AI TRAFFIC MANAGER — TTools text + FSX traffic BGL codec
// ═══════════════════════════════════════════════════════════
// Traffic BGL (FSX format, as written by AI Flight Planner):
//   header 0xA8 bytes (constant), u32 section count at 0xA8, 20-byte table
//   {count, recSize, 1, id, offset}; sections 1 airports, 2 aircraft, 5 flight plans,
//   6 sector transition table. Each section: index of 8-byte (key, offset) entries, then records.
//   Times: u32 = periodCode<<24 | round(minute / period * 2^24); FSX minute 0 = Monday 00:00 UTC.
//   Sector table: the earth in 256 latitude rows x 384 longitude columns; for every plan the
//   timeline of cells it is in (on the ground and along the great circle, flying from
//   departure+15 to arrival-15 min), times rounded to whole minutes.
var AITM_CODEC = (function () {
  'use strict';
  var HEADER_HEX = '0100569d9800aa6267ffffffffff0000000000000000000000000000000000000000000000000000000000000000a80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000214365870000000000000000000000000000000000000000000000000000ca00000000000000000000000000000000000000';
  var PERIODS = { // TTools name -> [code, minutes]
    '1HR': [0, 60], '2HR': [1, 120], '4HR': [2, 240], '6HR': [3, 360], '8HR': [4, 480], '12HR': [5, 720],
    '24HR': [6, 1440], 'WEEK': [7, 10080], '2WEEKS': [8, 20160]
  };
  var PERIOD_NAME = { 0: '1Hr', 1: '2Hr', 2: '4Hr', 3: '6Hr', 4: '8Hr', 5: '12Hr', 6: '24Hr', 7: 'Week', 8: '2Weeks' };
  function periodOf(name) {
    var k = String(name || 'Week').toUpperCase().replace(/\s+/g, '');
    if (k === 'WEEKLY') k = 'WEEK';
    if (k === 'DAILY' || k === '1DAY') k = '24HR';
    if (k === '2WEEK' || k === 'BIWEEKLY') k = '2WEEKS';
    return PERIODS[k] || PERIODS.WEEK;
  }
  function periodName(name) { return PERIOD_NAME[periodOf(name)[0]]; }
  // TTools days count from Sunday (FS9); FSX traffic files count from Monday.
  function dayShift(P) { return P >= 10080 ? 1440 : 0; }
  function mod(a, n) { return ((a % n) + n) % n; }

  // ── time stamps "D/HH:MM", "W/D/HH:MM", "DD/HH:MM", "HH:MM" ──
  function parseStamp(s, P) {
    s = String(s || '').trim().replace(/^@/, '');
    if (!s) return null;
    var p = s.split('/');
    var hm = p.pop().split(':');
    var h = parseInt(hm[0], 10), m = parseInt(hm[1] || '0', 10);
    if (isNaN(h) || isNaN(m)) return null;
    var day = 0;
    if (p.length === 1) day = parseInt(p[0], 10);
    else if (p.length === 2) day = parseInt(p[0], 10) * 7 + parseInt(p[1], 10);
    if (isNaN(day)) return null;
    return mod(day * 1440 + h * 60 + m, P);
  }
  function fmtStamp(min, P) {
    min = mod(Math.round(min), P);
    var hh = String(Math.floor((min % 1440) / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
    if (P < 1440) return hh;
    if (P === 1440) return hh;
    var d = Math.floor(min / 1440);
    if (P === 10080) return d + '/' + hh;
    return Math.floor(d / 7) + '/' + (d % 7) + '/' + hh;
  }

  // ── TTools text files ──
  function stripComment(l) { var i = l.indexOf('//'); return (i >= 0 ? l.slice(0, i) : l).trim(); }
  function parseAircraftTxt(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var l = stripComment(raw);
      var m = /^AC#\s*(\d+)\s*,\s*(\d*)\s*,\s*"?([^"]*)"?/i.exec(l);
      if (m) out.push({ n: parseInt(m[1], 10), speed: parseInt(m[2] || '0', 10) || 0, title: m[3].trim() });
    });
    return out;
  }
  function dmsToDeg(s) {
    s = String(s || '').trim();
    var m = /^([NSEW])\s*(\d+)\s*[*°]\s*([\d.]+)'?/i.exec(s);
    if (m) {
      var v = parseInt(m[2], 10) + parseFloat(m[3]) / 60;
      return /[SW]/i.test(m[1]) ? -v : v;
    }
    var f = parseFloat(s);
    return isNaN(f) ? null : f;
  }
  function degToDms(v, pos, neg) {
    var h = v < 0 ? neg : pos; v = Math.abs(v);
    var d = Math.floor(v), mm = (v - d) * 60;
    if (mm >= 59.999995) { d += 1; mm = 0; }
    return h + String(d).padStart(pos === 'N' ? 2 : 3, '0') + '* ' + mm.toFixed(5).padStart(8, '0') + "'";
  }
  function parseAirportsTxt(text) {
    var out = {};
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var l = stripComment(raw); if (!l) return;
      var f = l.split(',');
      if (f.length < 3) return;
      var icao = f[0].trim().toUpperCase();
      var lat = dmsToDeg(f[1]), lon = dmsToDeg(f[2]);
      if (!icao || lat == null || lon == null) return;
      out[icao] = { lat: lat, lon: lon, altFt: parseInt(f[3] || '0', 10) || 0 };
    });
    return out;
  }
  function parseFlightplansTxt(text) {
    var plans = [], errors = [];
    String(text || '').split(/\r?\n/).forEach(function (raw, ln) {
      var l = stripComment(raw); if (!l) return;
      var f = l.split(',').map(function (x) { return x.trim(); });
      var m = /^AC#\s*(\d+)$/i.exec(f[0]); if (!m) return;
      var per = periodOf(f[3]); var P = per[1];
      var plan = { ac: parseInt(m[1], 10), reg: f[1], pct: parseInt(f[2], 10) || 1, period: PERIOD_NAME[per[0]],
                   rules: (f[4] || 'IFR').toUpperCase() === 'VFR' ? 'VFR' : 'IFR', legs: [] };
      var rest = f.slice(5);
      while (rest.length && rest[rest.length - 1] === '') rest.pop();
      for (var i = 0; i < rest.length; i += 6) {
        var g = rest.slice(i, i + 6);
        if (g.length < 6) { errors.push('Line ' + (ln + 1) + ': incomplete leg'); break; }
        var dep = parseStamp(g[0], P), arr = g[1] === '' ? null : parseStamp(g[1], P);
        if (dep == null) { errors.push('Line ' + (ln + 1) + ': bad time ' + g[0]); }
        plan.legs.push({ dep: dep, arr: arr, alt: parseInt(g[2], 10) || 0, fr: (g[3] || 'F').toUpperCase() === 'R' ? 'R' : 'F',
                         fnum: g[4].replace(/\D/g, ''), to: g[5].toUpperCase(), tng: false });
      }
      plans.push(plan);
    });
    return { plans: plans, errors: errors };
  }
  function planToTxt(p) {
    var P = periodOf(p.period)[1];
    var out = ['AC#' + p.ac, p.reg, (p.pct || 1) + '%', periodName(p.period), p.rules || 'IFR'];
    p.legs.forEach(function (l) {
      out.push(fmtStamp(l.dep, P), l.arr == null ? '' : fmtStamp(l.arr, P), String(l.alt), l.fr || 'F',
               String(l.fnum || '0').padStart(4, '0'), l.to);
    });
    return out.join(',');
  }
  function aircraftToTxt(list) {
    return list.map(function (a, i) { return 'AC#' + (a.n || i + 1) + ',' + (a.speed || 0) + ',"' + a.title + '"'; }).join('\n');
  }
  function airportsToTxt(icaos, coords) {
    return icaos.map(function (c) {
      var a = coords(c); if (!a) return null;
      return c + ',' + degToDms(a.lat, 'N', 'S') + ',' + degToDms(a.lon, 'E', 'W') + ',' + Math.round(a.altFt || 0);
    }).filter(Boolean).join('\n');
  }

  // ── geometry ──
  var D2R = Math.PI / 180, RS = 180 / 256, CS = 360 / 384;
  function gcDist(la1, lo1, la2, lo2) {
    var a = Math.sin((la2 - la1) / 2), b = Math.sin((lo2 - lo1) / 2);
    return 2 * Math.asin(Math.min(1, Math.sqrt(a * a + Math.cos(la1) * Math.cos(la2) * b * b)));
  }
  function cellOf(lat, lon) {
    var r = Math.floor((90 - lat) / RS); if (r > 255) r = 255; if (r < 0) r = 0;
    var c = Math.floor(mod(lon + 180, 360) / CS); if (c > 383) c = 383;
    return r * 65536 + c;
  }
  // cells crossed on the great circle p1 -> p2: [startCell, [[fraction, newCell], ...]]
  function crossings(lat1, lon1, lat2, lon2) {
    var la1 = lat1 * D2R, lo1 = lon1 * D2R, la2 = lat2 * D2R, lo2 = lon2 * D2R;
    var d = gcDist(la1, lo1, la2, lo2);
    var c0 = cellOf(lat1, lon1);
    if (d < 1e-12) return [c0, []];
    var sd = Math.sin(d);
    var x1 = Math.cos(la1) * Math.cos(lo1), y1 = Math.cos(la1) * Math.sin(lo1), z1 = Math.sin(la1);
    var x2 = Math.cos(la2) * Math.cos(lo2), y2 = Math.cos(la2) * Math.sin(lo2), z2 = Math.sin(la2);
    function cellAt(f) {
      var A = Math.sin((1 - f) * d) / sd, B = Math.sin(f * d) / sd;
      var x = A * x1 + B * x2, y = A * y1 + B * y2, z = A * z1 + B * z2;
      return cellOf(Math.atan2(z, Math.sqrt(x * x + y * y)) / D2R, Math.atan2(y, x) / D2R);
    }
    var N = Math.max(8, Math.ceil(d / D2R / 0.02));
    var out = [], prevF = 0, prevC = c0;
    for (var i = 1; i <= N; i++) {
      var f = i / N, c = cellAt(f);
      if (c === prevC) { prevF = f; continue; }
      var lo = prevF;
      for (;;) {
        var a = lo, b = f;
        for (var k = 0; k < 45; k++) { var mm = (a + b) / 2; if (cellAt(mm) === prevC) a = mm; else b = mm; }
        var nc = cellAt(b);
        out.push([b, nc]); prevC = nc; lo = b;
        if (nc === c) break;
      }
      prevF = f;
    }
    return [c0, out];
  }

  // ── BGL writer ──
  // model: { aircraft:[{title, speed}], plans:[{ac (1-based AC#), reg, pct, period, rules, legs}] }
  // coords(icao) -> {lat, lon, altFt} | null.  opts: { halve: true }
  function writeBGL(model, coords, opts) {
    opts = opts || {};
    var halve = opts.halve !== false;
    var errors = [];
    // aircraft actually used, in AC# order
    var usedAc = {};
    model.plans.forEach(function (p) { if (p.legs.length) usedAc[p.ac] = true; });
    var acNums = Object.keys(usedAc).map(Number).sort(function (a, b) { return a - b; });
    var acId = {}; acNums.forEach(function (n, i) { acId[n] = i; });
    var plans = model.plans.filter(function (p) { return p.legs.length && model.aircraft[p.ac - 1]; });
    model.plans.forEach(function (p) { if (p.legs.length && !model.aircraft[p.ac - 1]) errors.push(p.reg + ': AC#' + p.ac + ' does not exist'); });
    if (opts.order) plans = opts.order(plans);
    // airports in order of first use
    var apList = [], apIdx = {};
    plans.forEach(function (p) { p.legs.forEach(function (l) { if (apIdx[l.to] == null) { apIdx[l.to] = apList.length; apList.push(l.to); } }); });
    var apC = {};
    apList.forEach(function (c) { var a = coords(c); if (!a) errors.push('Airport ' + c + ' has no coordinates'); else apC[c] = a; });
    if (errors.length) return { errors: errors };

    var chunks = [], size = 0;
    function U8(n) { var b = new Uint8Array(n); chunks.push(b); size += n; return new DataView(b.buffer); }
    function latin1(str, len) { var b = []; for (var i = 0; i < str.length && (len == null || i < len); i++) { var c = str.charCodeAt(i); b.push(c < 256 ? c : 63); } return b; }

    var nsec = 4;
    var base = 0xA8 + 4 + 20 * nsec;
    // section 1: airports
    var dummies = halve ? ['*#!', '*#@'] : ['*#@'];
    var apAll = dummies.concat(apList);
    var s1off = base, s1len = apAll.length * 8 + apAll.length * 16;
    // section 2: aircraft
    var acRecs = acNums.map(function (n) { var t = latin1(model.aircraft[n - 1].title); return { n: n, t: t, len: 10 + t.length + 1 }; });
    var s2off = s1off + s1len, s2len = acRecs.length * 8 + acRecs.reduce(function (s, r) { return s + r.len; }, 0);
    // section 5: plans
    var nP = plans.length;
    var s5off = s2off + s2len, s5len = nP * 8 + plans.reduce(function (s, p) { return s + 22 + 16 * p.legs.length; }, 0);
    // section 6: sector table
    var cells = {};
    plans.forEach(function (p, i) {
      var key = -(nP + 1) + i;
      planTimeline(p, apC).forEach(function (e) { (cells[e[2]] = cells[e[2]] || []).push([key, e[0], e[1], e[3]]); });
    });
    var cellKeys = Object.keys(cells).map(Number).sort(function (a, b) { return a - b; });
    var s6off = s5off + s5len;
    var s6len = cellKeys.length * 8 + cellKeys.reduce(function (s, k) { return s + 8 + 12 * cells[k].length; }, 0);
    var total = s6off + s6len;

    var buf = new ArrayBuffer(total), dv = new DataView(buf), u8 = new Uint8Array(buf);
    for (var h = 0; h < 0xA8; h++) u8[h] = parseInt(HEADER_HEX.substr(h * 2, 2), 16);
    dv.setUint32(0xA8, nsec, true);
    [[apAll.length, 16, 1, s1off], [acRecs.length, 0, 2, s2off], [nP, 0, 5, s5off], [cellKeys.length, 0, 6, s6off]].forEach(function (s, i) {
      var o = 0xAC + 20 * i;
      dv.setUint32(o, s[0], true); dv.setUint32(o + 4, s[1], true); dv.setUint32(o + 8, 1, true);
      dv.setUint32(o + 12, s[2], true); dv.setUint32(o + 16, s[3], true);
    });
    // airports
    var o = s1off, r = s1off + apAll.length * 8;
    apAll.forEach(function (c) {
      var nb = latin1(c, 4);
      for (var k = 0; k < 4; k++) { u8[o + k] = nb[k] || 0; u8[r + k] = nb[k] || 0; }
      dv.setUint32(o + 4, r, true);
      var a = apC[c];
      if (a) {
        dv.setInt32(r + 4, Math.round(a.lat * 10001750 / 90), true);
        var lon = mod(a.lon + 180, 360) - 180;
        dv.setInt32(r + 8, Math.max(-2147483648, Math.min(2147483647, Math.round(lon * 4294967296 / 360))), true);
        dv.setInt32(r + 12, Math.round((a.altFt || 0) * 0.3048), true);
      } else { dv.setInt32(r + 12, -1000, true); }
      o += 8; r += 16;
    });
    // aircraft
    o = s2off; r = s2off + acRecs.length * 8;
    acRecs.forEach(function (rec, i) {
      dv.setUint32(o, i, true); dv.setUint32(o + 4, r, true);
      dv.setUint32(r, rec.len, true); dv.setUint32(r + 4, i, true);
      var sp = model.aircraft[rec.n - 1].speed || 0;
      dv.setUint16(r + 8, Math.max(0, Math.min(65535, halve ? Math.floor(sp / 2) : sp)), true);
      for (var k = 0; k < rec.t.length; k++) u8[r + 10 + k] = rec.t[k];
      o += 8; r += rec.len;
    });
    // plans
    o = s5off; r = s5off + nP * 8;
    plans.forEach(function (p, i) {
      var key = -(nP + 1) + i, per = periodOf(p.period), P = per[1], code = per[0];
      var len = 22 + 16 * p.legs.length;
      dv.setInt32(o, key, true); dv.setUint32(o + 4, r, true);
      dv.setUint32(r, len, true); dv.setInt32(r + 4, key, true); dv.setUint32(r + 8, acId[p.ac], true);
      var rb = latin1(String(p.reg || ''), 7);
      for (var k = 0; k < 8; k++) u8[r + 12 + k] = rb[k] || 0;
      u8[r + 20] = Math.max(0, Math.min(100, p.pct || 1));
      u8[r + 21] = (p.rules === 'VFR' ? 0 : 0x10) | code;
      p.legs.forEach(function (l, j) {
        var q = r + 22 + 16 * j;
        dv.setUint32(q, encTime(l.dep, P, code), true);
        dv.setUint32(q + 4, encTime(l.arr, P, code), true);
        var nb = latin1(l.to, 4); for (var k = 0; k < 4; k++) u8[q + 8 + k] = nb[k] || 0;
        var v = (Math.max(0, Math.min(1023, l.alt | 0))) | ((parseInt(l.fnum, 10) & 0x3FFF) << 10);
        v = (v >>> 0) + (l.fr === 'R' ? 0 : 0x1000000) + (l.tng ? 0x2000000 : 0);
        dv.setUint32(q + 12, v, true);
      });
      o += 8; r += len;
    });
    // sector table
    o = s6off; r = s6off + cellKeys.length * 8;
    cellKeys.forEach(function (ck) {
      var ents = cells[ck].sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
      var len = 8 + 12 * ents.length;
      dv.setUint32(o, ck, true); dv.setUint32(o + 4, r, true);
      dv.setUint32(r, len, true); dv.setUint32(r + 4, ck, true);
      ents.forEach(function (e, j) {
        var q = r + 8 + 12 * j;
        dv.setInt32(q, e[0], true);
        dv.setUint32(q + 4, encMin(e[1], e[3]), true);
        dv.setUint32(q + 8, encMin(e[2], e[3]), true);
      });
      o += 8; r += len;
    });
    return { bytes: u8, airports: apList.length, aircraft: acRecs.length, plans: nP, cells: cellKeys.length };
  }
  function encTime(min, P, code) {
    var fsx = mod(Math.round(min) - dayShift(P), P);
    return encMin(fsx, [P, code]);
  }
  function encMin(fsxMin, pc) {
    var P = pc[0], code = pc[1];
    var v = Math.round(mod(fsxMin, P) * 16777216 / P);
    if (v >= 16777216) v -= 16777216;
    return ((code << 24) >>> 0) + v;
  }
  // timeline of cells for one plan: [[tinFSX, toutFSX, cell, [P, code]], ...]
  function planTimeline(p, apC) {
    var per = periodOf(p.period), P = per[1], code = per[0], sh = dayShift(P);
    var n = p.legs.length, segs = [];
    for (var j = 0; j < n; j++) {
      var l = p.legs[j], from = p.legs[(j - 1 + n) % n].to;
      var dep = mod(l.dep - sh, P), arr = mod(l.arr - sh, P);
      if (arr < dep) arr += P;
      var a = apC[from], b = apC[l.to];
      var t0 = dep + 15, t1 = arr - 15;
      if (t1 < t0) { t0 = t1 = (dep + arr) / 2; }
      var cr = crossings(a.lat, a.lon, b.lat, b.lon);
      var leg = [[cr[0], t0, 0]];
      cr[1].forEach(function (x) { var t = t0 + x[0] * (t1 - t0); leg[leg.length - 1][2] = t; leg.push([x[1], t, 0]); });
      leg[leg.length - 1][2] = t1;
      segs.push(leg);
    }
    // put legs on one time line
    var flat = [], basePer = 0, last = null;
    segs.forEach(function (leg) {
      if (last != null) while (leg[0][1] + basePer < last - 1e-6) basePer += P;
      leg.forEach(function (s) { flat.push([s[0], s[1] + basePer, s[2] + basePer]); });
      last = flat[flat.length - 1][2];
    });
    // the aircraft stays in the arrival cell until the next departure
    var tl = [];
    flat.forEach(function (s) {
      if (tl.length && tl[tl.length - 1][0] === s[0]) tl[tl.length - 1][2] = s[2];
      else { if (tl.length) tl[tl.length - 1][2] = s[1]; tl.push(s.slice()); }
    });
    var first = tl[0], lastE = tl[tl.length - 1];
    var end = first[1] + P * (Math.floor((lastE[2] - first[1]) / P) + 1);
    if (tl.length > 1 && lastE[0] === first[0]) {
      tl = [[first[0], lastE[1], first[2] + (end - first[1])]].concat(tl.slice(1, -1));
    } else if (tl.length === 1) {
      tl = [[first[0], first[1], first[1] + P]];
    } else { lastE[2] = end; }
    var res = [];
    tl.forEach(function (s) {
      var ra = Math.floor(s[1] + 0.5), rb = Math.floor(s[2] + 0.5);
      if (rb - ra <= 0) return;
      res.push([mod(ra, P), mod(rb, P), s[0], [P, code]]);
    });
    return res;
  }

  // ── BGL reader ──
  function readBGL(buffer) {
    var dv = new DataView(buffer), u8 = new Uint8Array(buffer);
    if (u8.length < 0x100 || dv.getUint32(0x76, true) !== 0x87654321) throw new Error('Not a traffic BGL file');
    var n = dv.getUint32(0xA8, true), secs = {};
    if (!n || n > 32) throw new Error('Not a traffic BGL file');
    for (var i = 0; i < n; i++) { var p = 0xAC + 20 * i; secs[dv.getUint32(p + 12, true)] = { off: dv.getUint32(p + 16, true), count: dv.getUint32(p, true) }; }
    if (!secs[1] || !secs[2] || !secs[5]) throw new Error('Not a traffic BGL file');
    function str(o, max) { var s = ''; for (var k = 0; k < max && o + k < u8.length && u8[o + k]; k++) s += String.fromCharCode(u8[o + k]); return s; }
    var airports = {}, halved = false;
    for (i = 0; i < secs[1].count; i++) {
      var ro = dv.getUint32(secs[1].off + 8 * i + 4, true);
      var ic = str(ro, 4);
      if (ic === '*#!') { halved = true; continue; }
      if (!ic || ic.charAt(0) === '*') continue;
      airports[ic] = { lat: dv.getInt32(ro + 4, true) * 90 / 10001750, lon: dv.getInt32(ro + 8, true) * 360 / 4294967296, altFt: Math.round(dv.getInt32(ro + 12, true) / 0.3048) };
    }
    var acById = {}, ids = [];
    for (i = 0; i < secs[2].count; i++) {
      var id = dv.getUint32(secs[2].off + 8 * i, true), ro2 = dv.getUint32(secs[2].off + 8 * i + 4, true);
      var len = dv.getUint32(ro2, true);
      acById[id] = { title: str(ro2 + 10, len - 10), speed: dv.getUint16(ro2 + 8, true) * (halved ? 2 : 1) };
      ids.push(id);
    }
    ids.sort(function (a, b) { return a - b; });
    var acNum = {}; var aircraft = ids.map(function (id, k) { acNum[id] = k + 1; return acById[id]; });
    var plans = [];
    for (i = 0; i < secs[5].count; i++) {
      var o = dv.getUint32(secs[5].off + 8 * i + 4, true), L = dv.getUint32(o, true);
      if (L < 22) continue;
      var code = u8[o + 21] & 0x0F, P = (PERIODS[(PERIOD_NAME[code] || 'Week').toUpperCase()] || PERIODS.WEEK)[1];
      var plan = { ac: acNum[dv.getUint32(o + 8, true)] || 1, reg: str(o + 12, 8).trim(), pct: u8[o + 20] || 1,
                   period: PERIOD_NAME[code] || 'Week', rules: (u8[o + 21] & 0x10) ? 'IFR' : 'VFR', legs: [] };
      var nl = Math.floor((L - 22) / 16), sh = dayShift(P);
      for (var j = 0; j < nl; j++) {
        var q = o + 22 + 16 * j;
        var a = dv.getUint32(q, true) & 0xFFFFFF, b = dv.getUint32(q + 4, true) & 0xFFFFFF, v = dv.getUint32(q + 12, true);
        plan.legs.push({ dep: mod(Math.round(a * P / 16777216) + sh, P), arr: mod(Math.round(b * P / 16777216) + sh, P),
          alt: v & 0x3FF, fr: (v >>> 24) & 1 ? 'F' : 'R', fnum: String((v >>> 10) & 0x3FFF).padStart(4, '0'),
          to: str(q + 8, 4).trim(), tng: !!((v >>> 25) & 1) });
      }
      plans.push(plan);
    }
    return { aircraft: aircraft, plans: plans, airports: airports, halved: halved };
  }

  return { parseAircraftTxt: parseAircraftTxt, parseFlightplansTxt: parseFlightplansTxt, parseAirportsTxt: parseAirportsTxt,
           planToTxt: planToTxt, aircraftToTxt: aircraftToTxt, airportsToTxt: airportsToTxt, fmtStamp: fmtStamp, parseStamp: parseStamp,
           periodOf: periodOf, periodName: periodName, writeBGL: writeBGL, readBGL: readBGL, planTimeline: planTimeline, crossings: crossings,
           gcDistNm: function (a, b, c, d) { return gcDist(a * D2R, b * D2R, c * D2R, d * D2R) * 3440.065; } };
})();
if (typeof module !== 'undefined') module.exports = AITM_CODEC;

// ═══════════════════════════════════════════════════════════
// AI TRAFFIC MANAGER — page
// ═══════════════════════════════════════════════════════════
var AITM_TYPES = {
  'A19N':'Airbus A319neo','A20N':'Airbus A320neo','A21N':'Airbus A321neo','A318':'Airbus A318-100','A319':'Airbus A319-100',
  'A320':'Airbus A320-200','A321':'Airbus A321-200','A30B':'Airbus A300B4','A306':'Airbus A300-600','A310':'Airbus A310-300',
  'A332':'Airbus A330-200','A333':'Airbus A330-300','A338':'Airbus A330-800neo','A339':'Airbus A330-900neo','A342':'Airbus A340-200',
  'A343':'Airbus A340-300','A345':'Airbus A340-500','A346':'Airbus A340-600','A359':'Airbus A350-900','A35K':'Airbus A350-1000',
  'A388':'Airbus A380-800','A3ST':'Airbus A300-600ST Beluga','A400':'Airbus A400M','BCS1':'Airbus A220-100','BCS3':'Airbus A220-300',
  'B703':'Boeing 707-320','B712':'Boeing 717-200','B720':'Boeing 720','B721':'Boeing 727-100','B722':'Boeing 727-200',
  'B731':'Boeing 737-100','B732':'Boeing 737-200','B733':'Boeing 737-300','B734':'Boeing 737-400','B735':'Boeing 737-500',
  'B736':'Boeing 737-600','B737':'Boeing 737-700','B738':'Boeing 737-800','B739':'Boeing 737-900','B37M':'Boeing 737 MAX 7',
  'B38M':'Boeing 737 MAX 8','B39M':'Boeing 737 MAX 9','B3XM':'Boeing 737 MAX 10','B741':'Boeing 747-100','B742':'Boeing 747-200','VC25':'Boeing VC-25A',
  'B743':'Boeing 747-300','B744':'Boeing 747-400','B748':'Boeing 747-8','B74S':'Boeing 747SP','B74R':'Boeing 747SR',
  'B752':'Boeing 757-200','B753':'Boeing 757-300','B762':'Boeing 767-200','B763':'Boeing 767-300','B764':'Boeing 767-400',
  'B772':'Boeing 777-200','B77L':'Boeing 777-200LR','B773':'Boeing 777-300','B77W':'Boeing 777-300ER','B788':'Boeing 787-8',
  'B789':'Boeing 787-9','B78X':'Boeing 787-10','C130':'Lockheed C-130 Hercules','C30J':'Lockheed C-130J','C17':'Boeing C-17',
  'C160':'Transall C-160','CRJ1':'Bombardier CRJ-100','CRJ2':'Bombardier CRJ-200','CRJ7':'Bombardier CRJ-700','CRJ9':'Bombardier CRJ-900',
  'CRJX':'Bombardier CRJ-1000','DH8A':'Dash 8-100','DH8B':'Dash 8-200','DH8C':'Dash 8-300','DH8D':'Dash 8-Q400','DHC6':'DHC-6 Twin Otter',
  'DC10':'McDonnell Douglas DC-10','DC3':'Douglas DC-3','DC6':'Douglas DC-6','DC85':'Douglas DC-8-50','DC86':'Douglas DC-8-60',
  'DC87':'Douglas DC-8-70','DC91':'Douglas DC-9-10','DC93':'Douglas DC-9-30','MD11':'McDonnell Douglas MD-11','MD81':'McDonnell Douglas MD-81',
  'MD82':'McDonnell Douglas MD-82','MD83':'McDonnell Douglas MD-83','MD87':'McDonnell Douglas MD-87','MD88':'McDonnell Douglas MD-88',
  'MD90':'McDonnell Douglas MD-90','L101':'Lockheed L-1011 TriStar','E110':'Embraer EMB-110','E120':'Embraer EMB-120',
  'E135':'Embraer ERJ-135','E140':'Embraer ERJ-140','E145':'Embraer ERJ-145','E170':'Embraer 170','E75L':'Embraer 175',
  'E190':'Embraer 190','E195':'Embraer 195','E290':'Embraer 190-E2','E295':'Embraer 195-E2','AT43':'ATR 42-300','AT45':'ATR 42-500',
  'AT46':'ATR 42-600','AT72':'ATR 72-200','AT75':'ATR 72-500','AT76':'ATR 72-600','F27':'Fokker F27','F28':'Fokker F28',
  'F50':'Fokker 50','F70':'Fokker 70','F100':'Fokker 100','SF34':'Saab 340','SB20':'Saab 2000','RJ70':'Avro RJ70','RJ85':'Avro RJ85',
  'RJ1H':'Avro RJ100','B461':'BAe 146-100','B462':'BAe 146-200','B463':'BAe 146-300','FA7X':'Dassault Falcon 7X','FA8X':'Dassault Falcon 8X',
  'F900':'Dassault Falcon 900','F2TH':'Dassault Falcon 2000','GLEX':'Bombardier Global Express','GL5T':'Bombardier Global 5000',
  'GLF4':'Gulfstream IV','GLF5':'Gulfstream V','GLF6':'Gulfstream G650','CL30':'Challenger 300','CL60':'Challenger 600',
  'IL62':'Ilyushin Il-62','IL76':'Ilyushin Il-76','IL86':'Ilyushin Il-86','IL96':'Ilyushin Il-96','T134':'Tupolev Tu-134',
  'T154':'Tupolev Tu-154','A124':'Antonov An-124','A225':'Antonov An-225','SU95':'Sukhoi Superjet 100','VC10':'Vickers VC10',
  'CONC':'Concorde','BN2P':'BN-2 Islander','PC12':'Pilatus PC-12','B190':'Beechcraft 1900D','C208':'Cessna 208 Caravan',
  'L410':'Let L-410','K35R':'Boeing KC-135','SH36':'Shorts 360','J328':'Dornier 328JET','D328':'Dornier 328','IL18':'Ilyushin Il-18','CVLT':'Convair 990'
};
// IATA equipment codes (as used in schedules) -> ICAO
var AITM_IATA_EQP = {
  '319':'A319','320':'A320','321':'A321','318':'A318','32N':'A20N','32Q':'A21N','31N':'A19N','332':'A332','333':'A333','338':'A338',
  '339':'A339','342':'A342','343':'A343','345':'A345','346':'A346','359':'A359','351':'A35K','388':'A388','380':'A388','221':'BCS1',
  '223':'BCS3','703':'B703','707':'B703','717':'B712','721':'B721','722':'B722','727':'B722','732':'B732','733':'B733','734':'B734',
  '735':'B735','736':'B736','73G':'B737','738':'B738','739':'B739','7M8':'B38M','7M9':'B39M','741':'B741','742':'B742','743':'B743',
  '744':'B744','748':'B748','74H':'B748','74L':'B74S','752':'B752','753':'B753','762':'B762','763':'B763','764':'B764','772':'B772',
  '77L':'B77L','773':'B773','77W':'B77W','788':'B788','789':'B789','781':'B78X','D10':'DC10','M11':'MD11','M81':'MD81','M82':'MD82',
  'M83':'MD83','M87':'MD87','M88':'MD88','M90':'MD90','L10':'L101','E70':'E170','E75':'E75L','E90':'E190','E95':'E195','ER4':'E145',
  'ER3':'E135','AT7':'AT72','AT5':'AT45','ATR':'AT72','DH4':'DH8D','DH8':'DH8C','CR2':'CRJ2','CR7':'CRJ7','CR9':'CRJ9','CRK':'CRJX',
  '100':'F100','F70':'F70','SU9':'SU95','SF3':'SF34','146':'B462','AR8':'RJ85','ARJ':'RJ85','CNC':'CONC','SSC':'CONC'
};

// military and government versions -> the civil type they are built on (size, type name): VC-25A is a 747-200 …
var AITM_MIL_TYPES = [
  [/\bVC[- ]?25[- ]?B\b/, 'B748'], [/\bVC[- ]?25(?:[- ]?A)?\b/, 'VC25'], [/\bE[- ]?4B\b/, 'B742'],
  [/\bKC[- ]?10A?\b/, 'DC10'], [/\b(?:KC|RC|EC|WC|OC)[- ]?135[A-Z]?\b|\bK35[RE]\b/, 'K35R'], [/\bKC[- ]?46A?\b/, 'B762'],
  [/\bC[- ]?32[AB]?\b/, 'B752'], [/\bC[- ]?40[ABC]?\b/, 'B737'], [/\bP[- ]?8[AI]\b/, 'B738'], [/\bVOYAGER\b|\bKC[- ]?30A?\b/, 'A332']
];
// recognise an aircraft type in a title, ui_type or schedule code -> ICAO designator ('' = unknown)
function aitmTypeSig(text) {
  var s = String(text || '').toUpperCase();
  if (!s) return '';
  if (AITM_TYPES[s]) return s;
  if (AITM_IATA_EQP[s]) return AITM_IATA_EQP[s];
  for (var q = 0; q < AITM_MIL_TYPES.length; q++) if (AITM_MIL_TYPES[q][0].test(s)) return AITM_MIL_TYPES[q][1];
  var toks = s.replace(/[_\-\/,()]/g, ' ').split(/\s+/);
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];
    if (AITM_TYPES[t]) return t;
    if (t.length === 5 && /S$/.test(t) && AITM_TYPES[t.slice(0, 4)]) return t.slice(0, 4); // FAIB "A320S"
  }
  var m;
  if ((m = /\bA(3[1-8]\d)[- ]?(\d)?(\d\d)?\s*(NEO|N)?\b/.exec(s))) {
    var fam = m[1], sub = m[2] || '';
    if (fam === '380') return 'A388';
    if (fam === '350') return /1000/.test(s) ? 'A35K' : 'A359';
    if (/^3(1[89]|2[01])$/.test(fam)) return m[4] ? ({ '319': 'A19N', '320': 'A20N', '321': 'A21N' }[fam] || 'A' + fam) : 'A' + fam;
    if (fam === '330') return sub === '3' ? 'A333' : sub === '8' ? 'A338' : sub === '9' ? 'A339' : 'A332';
    if (fam === '340') return 'A34' + (sub || '3');
    if (fam === '300') return /600/.test(s) ? 'A306' : 'A30B';
    if (fam === '310') return 'A310';
    if (fam === '220') return /300/.test(s) ? 'BCS3' : 'BCS1';
  }
  if ((m = /\bA220[- ]?(\d)/.exec(s))) return m[1] === '3' ? 'BCS3' : 'BCS1';
  if ((m = /\b7([0-8])7[- ]?(\d)?(\d\d)?\s*(SP|SR|ER|LR|F|MAX\s*\d+)?/.exec(s))) {
    var f = m[1], v = m[2] || '';
    if (/MAX\s*(\d+)/.test(m[4] || '')) { var mx = /MAX\s*(\d+)/.exec(m[4])[1]; return { '7': 'B37M', '8': 'B38M', '9': 'B39M', '10': 'B3XM' }[mx] || 'B38M'; }
    if (f === '4' && /SP/.test(m[4] || '')) return 'B74S';
    if (f === '7' && v === '3' && /ER/.test(m[4] || '')) return 'B77W';
    if (f === '7' && v === '2' && /LR/.test(m[4] || '')) return 'B77L';
    if (f === '0') return 'B703';
    if (f === '1') return 'B712';
    if (f === '8') return v === '1' ? 'B78X' : v === '8' ? 'B788' : 'B789';
    var code = 'B7' + f + (v || (f === '4' ? '4' : f === '3' ? '8' : '2'));
    if (AITM_TYPES[code]) return code;
  }
  if (/\bMD[- ]?11\b/.test(s)) return 'MD11';
  if ((m = /\bMD[- ]?(8[1-8]|90)\b/.exec(s))) return 'MD' + m[1];
  if (/\bDC[- ]?10\b/.test(s)) return 'DC10';
  if ((m = /\bDC[- ]?9[- ]?(\d)/.exec(s))) return 'DC9' + m[1];
  if ((m = /\bDC[- ]?8[- ]?(\d)/.exec(s))) return 'DC8' + m[1];
  if (/CONCORDE/.test(s)) return 'CONC';
  if (/TRISTAR|L-?1011/.test(s)) return 'L101';
  if ((m = /\bCRJ[- ]?(\d+)/.exec(s))) return { '100': 'CRJ1', '200': 'CRJ2', '700': 'CRJ7', '900': 'CRJ9', '1000': 'CRJX' }[m[1]] || '';
  if ((m = /\bE(?:MB|RJ)?[- ]?(1[2479]\d)/.exec(s))) return { '120': 'E120', '135': 'E135', '140': 'E140', '145': 'E145', '170': 'E170', '175': 'E75L', '190': 'E190', '195': 'E195' }[m[1]] || '';
  if ((m = /\bATR[- ]?(42|72)/.exec(s))) return m[1] === '42' ? 'AT45' : 'AT76';
  if ((m = /FOKKER[- ]?(\d+)/.exec(s))) return { '50': 'F50', '70': 'F70', '100': 'F100' }[m[1]] || '';
  return '';
}
function aitmTypeName(sig) { return AITM_TYPES[sig] || sig || ''; }

// ── state ──
var aitm = {
  name: '', code: '', period: '', fileBase: '', source: '',
  ac: [], plans: [], apx: {},
  sel: [], selAnchor: null,
  tmode: 'utc',
  fleet: [], fleetQ: null, fleetSel: [], fleetAnchor: null, fleetShown: [],
  logoUrl: null, logos: null,
  inited: false
};
var AITM_KEY = 'aitm_state_v1';

// AC# numbers are kept as in the files (they may have gaps, e.g. 100, 110, 120 …)
function aitmAcByN(n) { for (var i = 0; i < aitm.ac.length; i++) if (aitm.ac[i].n === n) return aitm.ac[i]; return null; }
function aitmNormAc() { aitm.ac.forEach(function (a, i) { if (a.n == null) a.n = i + 1; }); aitm.ac.sort(function (x, y) { return x.n - y.n; }); }
// The same aircraft (title) under several AC#: one AC# is enough — the lowest keeps it, the flight plans of
// the others move there and those AC# are removed. Numbers 1…n without gaps stay without gaps (and a sorted
// list stays sorted). Returns the merges [{n, into, title, fps}] (empty: nothing to do).
function aitmConsolidateAc() {
  var first = {}, map = {}, gone = [];
  aitm.ac.forEach(function (a) {
    var k = String(a.title || '').trim().toLowerCase(); if (!k) return;
    if (first[k]) { map[a.n] = first[k].n; gone.push(a); if (!first[k].speed && a.speed) first[k].speed = a.speed; }
    else first[k] = a;
  });
  if (!gone.length) return [];
  var wasSorted = aitmSortedOk();
  var nums = aitm.ac.map(function (a) { return a.n; }).sort(function (x, y) { return x - y; });
  var noGaps = nums.every(function (v, k) { return v === k + 1; });
  var out = gone.map(function (a) { return { n: a.n, into: map[a.n], title: a.title, fps: aitm.plans.filter(function (p) { return p.ac === a.n; }).length }; });
  aitm.plans.forEach(function (p) { if (map[p.ac]) p.ac = map[p.ac]; });
  aitm.ac = aitm.ac.filter(function (a) { return gone.indexOf(a) < 0; });
  if (noGaps) {
    var ren = {}; aitm.ac.forEach(function (a, k) { ren[a.n] = k + 1; a.n = k + 1; });
    aitm.plans.forEach(function (p) { if (ren[p.ac]) p.ac = ren[p.ac]; });
    out.forEach(function (m) { m.into = ren[m.into] || m.into; });
  }
  if (wasSorted) aitm.sortSig = aitmSortSig();
  return out;
}
function aitmConsolidateMsg(m) {
  return m.map(function (x) { return 'AC#' + x.n + ' was the same aircraft as AC#' + x.into + ' (' + x.title + ')' + (x.fps ? ' — its ' + x.fps + ' flight plan' + (x.fps === 1 ? '' : 's') + ' now fl' + (x.fps === 1 ? 'ies' : 'y') + ' AC#' + x.into : ''); }).join(' · ');
}
// AC list from the Aircraft file entries, plus empty ones for numbers the flight plans use but the file lacks
function aitmAcList(acs, plans, extra) {
  var by = {};
  acs.forEach(function (a) { by[a.n] = { n: a.n, title: a.title, speed: a.speed }; });
  plans.forEach(function (p) { if (!by[p.ac]) by[p.ac] = { n: p.ac, title: 'AC#' + p.ac, speed: 0 }; });
  return Object.keys(by).map(Number).sort(function (x, y) { return x - y; }).map(function (k) { return extra ? extra(by[k]) : by[k]; });
}
function aitmEsc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function aitmSave() {
  if (typeof aitmUpdateCompileBtn === 'function') aitmUpdateCompileBtn();
  clearTimeout(aitm._saveT);
  aitm._saveDue = true;
  aitm._saveT = setTimeout(aitmSaveNow, 300);
}
function aitmSaveNow() {
  clearTimeout(aitm._saveT);
  if (!aitm._saveDue) return;
  aitm._saveDue = false;
  try {
    localStorage.setItem(AITM_KEY, JSON.stringify({ kind: aitm.kind || 'airline', apIcao: aitm.apIcao || '', name: aitm.name, code: aitm.code, period: aitm.period, fileBase: aitm.fileBase,
      source: aitm.source, ac: aitm.ac, plans: aitm.plans, apx: aitm.apx, tmode: aitm.tmode, outName: aitm.outName || '', sortSig: aitm.sortSig || '', checkSig: aitm.checkSig || '', compiledSig: aitm.compiledSig || '', savedSig: aitm.savedSig || '' }));
  } catch (e) {}
}
// a reload or a closed tab right after a change must not lose it
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', aitmSaveNow);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') aitmSaveNow(); });
}
function aitmRestore() {
  try {
    var s = JSON.parse(localStorage.getItem(AITM_KEY) || 'null');
    if (!s) return;
    ['kind', 'apIcao', 'name', 'code', 'period', 'fileBase', 'source', 'ac', 'plans', 'apx', 'tmode', 'outName', 'sortSig', 'checkSig', 'compiledSig', 'savedSig'].forEach(function (k) { if (s[k] != null) aitm[k] = s[k]; });
    aitmNormAc();
  } catch (e) {}
}

// ── IndexedDB (folder handles, scan cache) ──
function aitmIdb() {
  if (aitm._db) return aitm._db;
  aitm._db = new Promise(function (res, rej) {
    if (!window.indexedDB) { rej(new Error('no IndexedDB')); return; }
    var r = indexedDB.open('aitm', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
  return aitm._db;
}
function aitmKvGet(k) { return aitmIdb().then(function (db) { return new Promise(function (res) { var q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { res(undefined); }; }); }).catch(function () { return undefined; }); }
function aitmKvSet(k, v) { return aitmIdb().then(function (db) { return new Promise(function (res) { var t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = function () { res(true); }; t.onerror = function () { res(false); }; }); }).catch(function () { return false; }); }

// ── airports ──
function aitmAp(icao) { return aitmApWith(aitm.apx || {})(icao); }
function aitmApWith(apx) { return function (icao) {
  var r = (typeof lookupAirport === 'function') ? lookupAirport(String(icao || '')) : null;
  if (r && r[0] !== String(icao).toUpperCase()) r = null;
  var x = apx[String(icao || '').toUpperCase()];
  if (r) return { lat: r[3], lon: r[4], altFt: x ? x.altFt : 0, city: r[7] || r[2] || '', name: r[2] || '', row: r };
  if (x) return { lat: x.lat, lon: x.lon, altFt: x.altFt || 0, city: '', name: '', row: null };
  return null;
}; }
function aitmTzDate() {
  var d = new Date();
  if (aitm.tmode === 'eusummer') return d.getFullYear() + '-07-15';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function aitmOffset(icao) {
  var a = aitmAp(icao);
  if (!a || !a.row || typeof getUtcOffset !== 'function') return null;
  return getUtcOffset(a.row, aitmTzDate());
}
function aitmFmtOff(o) {
  if (o == null) return '?';
  var s = o < 0 ? '−' : '+', v = Math.abs(o), h = Math.floor(v), m = Math.round((v - h) * 60);
  return s + h + (m ? ':' + String(m).padStart(2, '0') : '');
}

// ── installed aircraft ──
function aitmParseCfg(text) {
  var secs = [], cur = null;
  String(text || '').split(/\r?\n/).forEach(function (raw) {
    var l = raw.trim();
    if (!l || l[0] === ';' || l.slice(0, 2) === '//') return;
    var m = /^\[([^\]]+)\]/.exec(l);
    if (m) { cur = { name: m[1].trim().toLowerCase(), kv: {} }; secs.push(cur); return; }
    if (!cur) return;
    var i = l.indexOf('='); if (i < 0) return;
    var k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1);
    var sc = v.indexOf(';'); if (sc >= 0) v = v.slice(0, sc);
    v = v.trim().replace(/^"(.*)"$/, '$1').trim();
    cur.kv[k] = v;
  });
  return secs;
}
function aitmAirlineOf(kv, title) {
  if (kv.icao_airline) return kv.icao_airline.toUpperCase();
  var pc = String(kv.atc_parking_codes || '').split(',')[0].trim().toUpperCase();
  if (/^[A-Z]{4}$/.test(pc)) return pc;                                   // USAF, RAAF …
  if (/^[A-Z]{3}/.test(pc)) return pc.slice(0, 3);
  var t = String(title || '').trim().split(/\s+/);
  for (var i = t.length - 1; i >= 0; i--) if (/^[A-Z]{3}$/.test(t[i]) && !AITM_TYPES[t[i]]) return t[i];
  // 4 letters only when there is no 3-letter code ("FAIB B742 USAF"); model makers are no airline
  for (i = t.length - 1; i >= 0; i--) if (/^[A-Z]{4}$/.test(t[i]) && !AITM_TYPES[t[i]] && !/^(FAIB|IVAO|NAAI|MAIW|HTAI|WOAI|SNAI|WVIP|ESAI|FSPX)$/.test(t[i])) return t[i];
  return '';
}
function aitmCfgEntries(cfgText, fmText, folder, src) {
  var secs = aitmParseCfg(cfgText), gen = {}, out = [];
  secs.forEach(function (s) { if (s.name === 'general') gen = s.kv; });
  var fm = { speed: 0, wing: 0 };
  if (fmText) aitmParseCfg(fmText).forEach(function (s) {
    if (s.name === 'reference speeds' && s.kv.cruise_speed) fm.speed = Math.round(parseFloat(s.kv.cruise_speed)) || 0;
    if (s.name === 'airplane_geometry' && s.kv.wing_span) fm.wing = parseFloat(s.kv.wing_span) || 0;
  });
  var icaoType = String(gen.icao_type_designator || '').toUpperCase();
  secs.forEach(function (s) {
    if (!/^fltsim\.\d+$/.test(s.name) || !s.kv.title) return;
    var kv = s.kv;
    var sig = (AITM_TYPES[icaoType] ? icaoType : '') || aitmTypeSig(kv.ui_type) || aitmTypeSig(kv.title) || icaoType;
    out.push({ title: kv.title, model: kv.model || '', texture: kv.texture || '', uiType: kv.ui_type || '', uiVar: kv.ui_variation || '', atcAirline: kv.atc_airline || '',
               codes: kv.atc_parking_codes || '', ptypes: kv.atc_parking_types || '', airline: aitmAirlineOf(kv, kv.title),
               sig: sig, icaoType: icaoType, speed: fm.speed, wing: fm.wing, folder: folder, src: src });
  });
  return out;
}
// Chrome treats *.cfg as a "dangerous" file type on Windows and hides it from folder access
// (showDirectoryPicker). The classic folder upload of the browser still hands them over —
// nothing is sent anywhere, the page only reads aircraft.cfg / flight_model.cfg locally.
async function aitmPermOk(h, write) {
  var opt = { mode: write ? 'readwrite' : 'read' };
  if ((await h.queryPermission(opt)) === 'granted') return true;
  try { return (await h.requestPermission(opt)) === 'granted'; } catch (e) { return false; }
}
function aitmReadAircraftFolder() {
  var inp = document.createElement('input');
  inp.type = 'file'; inp.webkitdirectory = true; inp.multiple = true;
  inp.onchange = async function () {
    var files = Array.prototype.slice.call(inp.files || []);
    if (!files.length) return;
    var wasInst = {}; aitm.ac.forEach(function (a) { if (aitmInstalled(a.title)) wasInst[a.n] = 1; });
    var oldTitles = {}; aitm.fleet.forEach(function (e) { oldTitles[String(e.title).toLowerCase()] = 1; });
    aitmToast('Reading ' + files.length + ' files …');
    await new Promise(function (r) { setTimeout(r, 20); });
    var byDir = {}, subCfg = {}, root = '';
    files.forEach(function (f) {
      var p = (f.webkitRelativePath || f.name).split('/');
      if (!root) root = p[0];
      var n = p.pop().toLowerCase();
      if (n === 'aircraft.cfg' || n === 'flight_model.cfg' || n === 'aircraft.cfgaig') { var d = p.join('/'); (byDir[d] = byDir[d] || {})[n] = f; }
      else if (n === 'model.cfg' || n === 'texture.cfg') { var sub = p.pop(), dd = p.join('/'); ((subCfg[dd] = subCfg[dd] || {})[sub.toLowerCase()] = subCfg[dd][sub.toLowerCase()] || {})[n] = f; }
    });
    var src = /aig/i.test(root) || Object.keys(byDir).some(function (d) { return /aig-aitraffic/i.test(d); }) ? 'AIG' : 'Own';
    var entries = [], ncfg = 0, errs = [];
    var meta = {}, nsub = 0, dirs = Object.keys(byDir);
    for (var di = 0; di < dirs.length; di++) {
      var d = dirs[di], g = byDir[d], cf = g['aircraft.cfg'] || g['aircraft.cfgaig'];
      if (!cf) continue;
      var rel = d.split('/').slice(1).join('/');
      try {
        var cfg = await aitmReadText(cf), fm = g['flight_model.cfg'] ? await aitmReadText(g['flight_model.cfg']) : '';
        aitmCfgEntries(cfg, fm, d.split('/').pop(), src).forEach(function (e) { e.root = root; e.rel = rel; entries.push(e); });
        ncfg++;
      } catch (e) { errs.push(d + ': ' + e.message); }
      // for the 3D view: model.cfg [models] normal= and texture.cfg fallbacks of the sub folders
      // (Chrome hides *.cfg from folder access, so they are kept from here)
      var subs = subCfg[d] || {}, m = { m: {}, t: {} }, jobs = [];
      Object.keys(subs).forEach(function (sub) {
        if (subs[sub]['model.cfg']) jobs.push(aitmReadText(subs[sub]['model.cfg']).then(function (t) {
          aitmParseCfg(t).forEach(function (sc) { if (sc.name === 'models' && sc.kv.normal) m.m[sub] = sc.kv.normal; });
        }));
        if (subs[sub]['texture.cfg']) jobs.push(aitmReadText(subs[sub]['texture.cfg']).then(function (t) {
          var fb = [];
          aitmParseCfg(t).forEach(function (sc) { Object.keys(sc.kv).forEach(function (k) { var x = /^fallback\.(\d+)$/.exec(k); if (x) fb[parseInt(x[1], 10)] = sc.kv[k]; }); });
          m.t[sub] = fb.filter(Boolean);
        }));
      });
      await Promise.all(jobs); nsub += jobs.length;
      meta[rel] = m;
      if (di % 20 === 0) { aitmToast('Reading ' + root + ' … ' + ncfg + ' aircraft.cfg, ' + nsub + ' model/texture settings'); await new Promise(function (r) { setTimeout(r, 0); }); }
    }
    aitm.fleetMeta = aitm.fleetMeta || {}; aitm.fleetMeta[root] = meta;
    aitm.fleet = aitm.fleet.filter(function (e) { return e.root && e.root !== root; }).concat(entries);
    aitm.sources = (aitm.sources || []).filter(function (x) { return x.name !== root; })
      .concat([{ name: root, src: src, cfg: ncfg, liveries: entries.length, files: files.length, at: Date.now() }]);
    await aitmKvSet('fleetCache', { at: Date.now(), list: aitm.fleet, sources: aitm.sources, meta: aitm.fleetMeta });
    aitmFleetIndex(); aitmRenderAll();
    aitm.logos = null; aitmFindLogo(false);
    var lost = aitm.ac.filter(function (a) { return wasInst[a.n] && !aitmInstalled(a.title); });
    var added = entries.filter(function (e) { return !oldTitles[String(e.title).toLowerCase()]; }).length;
    aitm._lastRead = { root: root, at: Date.now(), cfg: ncfg, liveries: entries.length, added: added, lost: lost.map(function (a) { return { n: a.n, title: a.title }; }), errs: errs.length };
    aitmToast(root + ': ' + ncfg + ' aircraft.cfg, ' + entries.length + ' liveries read' + (added ? ' · ' + added + ' new title' + (added === 1 ? '' : 's') : '')
      + (lost.length ? ' · ' + lost.length + ' aircraft of this plan no longer installed (red)' : '') + (errs.length ? ' · ' + errs.length + ' could not be read' : '') + '.', !ncfg || errs.length > 0 || lost.length > 0);
    if (document.getElementById('aitm-modal')) aitmFoldersDialog();
  };
  inp.click();
}
async function aitmForgetSource(name) {
  aitm.fleet = aitm.fleet.filter(function (e) { return e.root && e.root !== name; });
  aitm.sources = (aitm.sources || []).filter(function (x) { return x.name !== name; });
  if (aitm.fleetMeta) delete aitm.fleetMeta[name];
  await aitmKvSet('fleetCache', { at: Date.now(), list: aitm.fleet, sources: aitm.sources, meta: aitm.fleetMeta || {} });
  aitmFleetIndex(); aitmRenderAll(); aitmFoldersDialog();
}
function aitmFleetIndex() {
  aitm.byTitle = {};
  aitm.fleet.forEach(function (e, i) { e.i = i; aitm.byTitle[e.title.toLowerCase()] = e; });
}
function aitmInstalled(title) { return aitm.byTitle ? aitm.byTitle[String(title || '').toLowerCase()] : null; }
function aitmAcSig(a) {
  var inst = aitmInstalled(a.title);
  if (inst && inst.sig) return inst.sig;
  return aitmTypeSig(a.hint) || aitmTypeSig(a.title);
}
function aitmAcTypeName(a) {
  var inst = aitmInstalled(a.title);
  if (inst && inst.uiType) return inst.uiType;
  return aitmTypeName(aitmAcSig(a)) || a.hint || '';
}

// airline of an AC# entry: set by the planner, of the installed livery, from the title, or the plan's airline
var AITM_MAKERS = /\s(Airbus|Boeing|Embraer|Bombardier|McDonnell|Douglas|ATR|De Havilland|DHC|Fokker|Canadair|Saab|Antonov|Lockheed|BAe|British Aerospace|Avro|Dornier|Sukhoi|COMAC|Comac|Ilyushin|Tupolev|Cessna|Beechcraft|Pilatus|Gulfstream|Dassault|Learjet|Hawker|Concorde|Aerospatiale|Vickers|Convair|Mitsubishi)\b/;
// airline of an AC# entry: {code, name} — set by the planner, of the installed livery, or from the title
function aitmAcAirlineInfo(a) {
  var t = String(a.title || ''), out = { code: '', name: '' };
  if (a.al) out.code = a.al;
  var inst = aitmInstalled(t); if (inst && inst.airline && !out.code) out.code = inst.airline;
  var m = /^AIGAIM_([A-Z0-9]{2,4})\s+\S+\s+NCv2$/.exec(t);           // planner placeholder
  if (m) { if (!out.code) out.code = m[1]; return out; }
  m = /^AIGAIM_(.+?)\s*$/.exec(t);
  if (m) { var mk = AITM_MAKERS.exec(' ' + m[1]); if (mk) out.name = (' ' + m[1]).slice(0, mk.index).trim(); }
  if (!out.code && !/^AIGAIM_/.test(t)) out.code = aitmAirlineOf({}, t);
  if (!out.code && !out.name && aitm.kind !== 'airport') out.code = aitm.code || '';
  return out;
}
// search term for the first AC# whose aircraft is not installed (red dot): airline + type, else type, else airline
function aitmDefaultQuery() {
  if (!aitm.fleet.length) return '';
  for (var i = 0; i < aitm.ac.length; i++) {
    var a = aitm.ac[i];
    if (aitmInstalled(a.title)) continue;
    var sig = aitmAcSig(a), inf = aitmAcAirlineInfo(a), al = inf.name || inf.code;
    var cands = [[al, sig].filter(Boolean).join(' '), sig, al].filter(Boolean);
    for (var k = 0; k < cands.length; k++) if (aitmFleetMatches(cands[k]).length) return cands[k];
    return cands[0] || '';
  }
  return '';
}
// ── matching: which installed livery fits which AC# best ──
function aitmMatchScore(a, e, code) {
  var s = 0, sig = aitmAcSig(a);
  if (e.title.toLowerCase() === String(a.title || '').toLowerCase()) s += 1000;
  if (sig && e.sig === sig) s += 100;
  else if (sig && e.sig && e.sig.slice(0, 3) === sig.slice(0, 3)) s += 40;
  else if (sig && e.sig) return s;
  var inf = aitmAcAirlineInfo(a), al = inf.code || (inf.name ? '' : code), an = inf.name.toLowerCase();
  if (al && (e.airline === al || (' ' + e.codes.toUpperCase() + ',').indexOf(al) >= 0)) s += 50;
  else if (an && (e.title.toLowerCase().indexOf('aigaim_' + an + ' ') === 0 || e.uiVar.toLowerCase().indexOf(an) === 0)) s += 50;
  var nm = aitm.kind === 'airport' ? '' : String(aitm.name || '').toLowerCase();
  if (nm && (e.uiVar.toLowerCase().indexOf(nm) >= 0 || e.title.toLowerCase().indexOf(nm) >= 0)) s += 30;
  var regs = String(a.title || '').match(/\b[A-Z0-9]{1,2}-[A-Z0-9]{3,5}\b|\bN\d{1,5}[A-Z]{0,2}\b/g) || [];
  regs.forEach(function (r) { if (e.title.indexOf(r) >= 0) s += 20; });
  return s;
}
function aitmBestMatches() {
  var code = String(aitm.code || '').toUpperCase(), used = {}, best = [];
  aitm.ac.forEach(function (a, i) {
    var top = null, topS = 59;
    aitm.fleet.forEach(function (e) {
      if (used[e.i]) return;
      var s = aitmMatchScore(a, e, code);
      if (s > topS) { topS = s; top = e; }
    });
    best[i] = top; if (top) used[top.i] = true;
  });
  return best;
}

// ── loading ──
function aitmSplitBase(fileName) {
  var b = String(fileName || '').replace(/\.[^.]+$/, '').replace(/^(Traffic|Flightplans|Aircraft|Airports)_/i, '');
  var period = '';
  var m = /_(Summer|Winter|Su|Wi)[_ ]?(\d{2,4}(?:-\d{2,4})?)(v\d+|b\d+)?$/i.exec(b);
  if (m) { period = (/^s/i.test(m[1]) ? 'Summer ' : 'Winter ') + (m[2].length === 2 ? '20' + m[2] : m[2]); }
  var name = b.replace(/_(Summer|Winter|Su|Wi)[_ ]?\d.*$/i, '').replace(/^(AIG|CRE|AIGFP|FP|DK|ESAI|MAIW|OCH|SNAI|WVIP|FAIB|TFS|UTT)_/i, '');
  name = name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return { base: b, name: name, period: period };
}
function aitmGuessCode() {
  var cnt = {};
  aitm.ac.forEach(function (a) {
    var inst = aitmInstalled(a.title);
    var c = inst ? inst.airline : aitmAirlineOf({}, a.title);
    if (c) cnt[c] = (cnt[c] || 0) + 1;
  });
  var best = '', n = 0; for (var k in cnt) if (cnt[k] > n) { n = cnt[k]; best = k; }
  return best;
}
function aitmLoad(d) {
  aitm.ac = d.aircraft; aitm.plans = d.plans; aitm.apx = d.apx || {}; aitm.sortSig = ''; aitm.checkSig = ''; aitm.compiledSig = ''; aitm.savedSig = ''; aitm.checkErrs = 0; aitm._srcDir = null;
  aitmNormAc();
  var merged = aitmConsolidateAc();                         // the same aircraft twice → one AC#
  aitm._loadMerged = merged.length;
  if (merged.length) setTimeout(function () { aitmToast('Merged: ' + aitmConsolidateMsg(merged) + '.'); }, 50);
  aitm.fileBase = d.base || ''; aitm.source = d.source || '';
  aitm.name = d.name || ''; aitm.period = d.period || ''; aitm.code = d.code || '';
  // an airport plan (file named after an ICAO code, or AIRPORT mode of the AI Generator): many airlines
  var ic = String(d.airport || d.name || '').replace(/\s+/g, '').toUpperCase();
  aitm.kind = d.kind || (/^[A-Z0-9]{4}$/.test(ic) && aitmAp(ic) ? 'airport' : 'airline');
  aitm.apIcao = aitm.kind === 'airport' ? ic : '';
  if (aitm.kind === 'airport') {
    var ap = aitmAp(ic); aitm.code = ''; aitm.name = ap ? (ap.city || ap.name || ic) : ic;
    aitm.outName = 'Traffic_' + (aitm.fileBase || ('CRE_' + ic)) + '.bgl';
    aitm.sel = []; aitm.fleetQ = null; aitm.fleetSel = [];
    if (aitm.logoUrl) { URL.revokeObjectURL(aitm.logoUrl); aitm.logoUrl = null; }
    aitmSave(); aitmRenderAll(); return;
  }
  if (!aitm.code) aitm.code = aitmGuessCode();
  if (!aitm.code && aitm.name && typeof AIRLINE_NAMES !== 'undefined') {
    var nm = aitm.name.toLowerCase().replace(/\s+/g, '');
    for (var k in AIRLINE_NAMES) if (String(AIRLINE_NAMES[k]).toLowerCase().replace(/\s+/g, '') === nm) { aitm.code = k; break; }
  }
  if (!aitm.name && aitm.code && typeof AIRLINE_NAMES !== 'undefined' && AIRLINE_NAMES[aitm.code]) aitm.name = AIRLINE_NAMES[aitm.code];
  aitm.outName = 'Traffic_' + (aitm.fileBase || ('CRE_' + (aitm.name || aitm.code || 'Airline').replace(/\s+/g, ''))) + '.bgl';
  aitm.sel = []; aitm.fleetQ = null; aitm.fleetSel = [];
  aitmSave(); aitmRenderAll(); aitmFindLogo();
}
// Open txt: pick Flightplans_<name>.txt — Aircraft_<name>.txt and Airports_<name>.txt are taken
// from the same folder (the page asks once per folder for permission to look there).
async function aitmOpenTxt() {
  if (!window.showOpenFilePicker) { aitmOpenTxtInput(); return; }
  var hs;
  try { hs = await window.showOpenFilePicker({ id: 'aitm-open-txt', multiple: true, types: [{ description: 'TTools flight plan', accept: { 'text/plain': ['.txt'] } }] }); }
  catch (e) { return; }
  var fpH = hs.find(function (h) { return /^flightplans/i.test(h.name); }) || null;
  var acH = hs.find(function (h) { return /^aircraft/i.test(h.name); }) || null;
  var apH = hs.find(function (h) { return /^airports/i.test(h.name); }) || null;
  var anyH = fpH || acH || apH;
  if (!anyH) { aitmLoadTxtHandles(hs[0], null, null); return; }   // not named the TTools way
  var suffix = anyH.name.replace(/^(flightplans|aircraft|airports)/i, '');
  if (fpH && acH && apH) { aitmLoadTxtHandles(fpH, acH, apH); return; }
  var dirs = (await aitmKvGet('txtDirs')) || [];
  var fpRoot = await aitmKvGet('fpRoot');           // the Installation Manager's flight plan folder counts too
  var cands = fpRoot ? [fpRoot].concat(dirs) : dirs;
  var known = null, path = null;
  for (var i = 0; i < cands.length && !known; i++) { try { path = await cands[i].resolve(anyH); if (path) known = cands[i]; } catch (e) {} }
  var go = async function (dir) {
    var sib = await aitmSiblings(dir, path || (await dir.resolve(anyH)) || [anyH.name], ['flightplans' + suffix.toLowerCase(), 'aircraft' + suffix.toLowerCase(), 'airports' + suffix.toLowerCase()]);
    var f = fpH || sib[0];
    if (!f) { aitmToast('Flightplans' + suffix + ' not found next to ' + anyH.name + '.', true); return; }
    await aitmLoadTxtHandles(f, acH || sib[1], apH || sib[2]);
    var pp = path || (await dir.resolve(anyH)) || [anyH.name], sd = dir;
    try { for (var k = 0; k < pp.length - 1; k++) sd = await sd.getDirectoryHandle(pp[k]); aitm._srcDir = { h: sd, label: [dir.name].concat(pp.slice(0, -1)).join(' \\ ') }; } catch (e) {}
  };
  if (known && (await known.queryPermission({ mode: 'read' })) === 'granted') { await go(known); return; }
  aitmModal('One more click: allow the folder',
    '<div style="font-size:13px;color:var(--txt2);line-height:1.7;">Chrome lets the page read only the file you picked (<b>' + aitmEsc(anyH.name) + '</b>). '
    + 'To load <b>Flightplans' + aitmEsc(suffix) + '</b>, <b>Aircraft' + aitmEsc(suffix) + '</b> and <b>Airports' + aitmEsc(suffix) + '</b> together, '
    + (known ? 'Chrome must allow the page to look into “' + aitmEsc(known.name) + '” again — click <b>Allow folder</b>.'
             : 'Chrome must allow the page to look into their folder — <b>once</b>:<br>click <b>Allow folder</b>, then in Chrome’s window click <b>Select folder</b> and <b>View files</b>. '
               + 'The folder is already selected.<br><span style="color:var(--txt3);">Tip: go up and pick “CRE flightplans” — then it works for all your flight plans in its sub folders at once.</span>') + '</div>',
    [['Allow folder', async function () {
      try {
        var dir = known;
        if (dir) { if (!(await aitmPermOk(dir))) return; }
        else {
          dir = await window.showDirectoryPicker({ id: 'aitm-txtdir', mode: 'read', startIn: anyH });
          path = await dir.resolve(anyH);
          if (!path) { aitmToast(anyH.name + ' is not inside “' + dir.name + '” — choose the folder that holds it.', true); return; }
          dirs.push(dir); await aitmKvSet('txtDirs', dirs);
        }
        aitmCloseModal(); await go(dir);
      } catch (e) { if (e && e.name !== 'AbortError') aitmToast(e.message, true); }
    }]].concat(fpH ? [['Load without them', function () { aitmCloseModal(); aitmLoadTxtHandles(fpH, acH, apH); }, true]] : []));
}
// files whose lower-case names are in `want`, in the folder of path (path = parts from dir, file last)
async function aitmSiblings(dir, path, want) {
  var d = dir;
  for (var i = 0; i < path.length - 1; i++) d = await d.getDirectoryHandle(path[i]);
  var found = want.map(function () { return null; });
  for await (var e of d.values()) {
    if (e.kind !== 'file') continue;
    var k = want.indexOf(e.name.toLowerCase()); if (k >= 0) found[k] = e;
  }
  return found;
}
async function aitmLoadTxtHandles(fpH, acH, apH) {
  try {
    await aitmLoadTxt(await fpH.getFile(), acH ? await acH.getFile() : null, apH ? await apH.getFile() : null);
  } catch (e) { aitmToast(e.message, true); }
}
async function aitmLoadTxt(fpFile, acFile, apFile) {
  var fpText = await aitmReadText(fpFile), acText = acFile ? await aitmReadText(acFile) : null, apText = apFile ? await aitmReadText(apFile) : null;
  var fp = AITM_CODEC.parseFlightplansTxt(fpText);
  if (!fp.plans.length || !fp.plans.some(function (p) { return p.legs.length; })) { aitmToast(fpFile.name + ' contains no flight plan lines with legs — is it a Flightplans_ file?', true); return; }
  var acs = acText ? AITM_CODEC.parseAircraftTxt(acText) : [];
  var list = aitmAcList(acs, fp.plans);
  var sb = aitmSplitBase(fpFile.name);
  aitmLoad({ aircraft: list, plans: fp.plans, apx: apText ? AITM_CODEC.parseAirportsTxt(apText) : {}, base: sb.base, name: sb.name, period: sb.period, source: fpFile.name });
  if (acFile && !aitm._loadMerged && !fp.errors.length) { aitm.savedSig = aitmTxtSig(); aitmSave(); }   // as on disk: Save txt green
  var msg = [fpFile.name, acFile ? acFile.name : null, apFile ? apFile.name : null].filter(Boolean).join(' + ') + ' loaded.';
  if (!acFile) msg = 'No Aircraft' + fpFile.name.replace(/^flightplans/i, '') + ' found — the AC# entries are empty; drag your aircraft onto them.';
  if (fp.errors.length) msg += ' ' + fp.errors.length + ' line(s) could not be read: ' + fp.errors.slice(0, 3).join('; ');
  aitmToast(msg, !acFile || fp.errors.length > 0);
}
// browsers without folder access: classic file selection (select Flightplans_ and Aircraft_ together)
function aitmOpenTxtInput() {
  var inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.txt'; inp.multiple = true;
  inp.onchange = async function () {
    var files = Array.prototype.slice.call(inp.files || []), fp = null, ac = null, ap = null;
    for (var i = 0; i < files.length; i++) {
      var t = await aitmReadText(files[i]), n = files[i].name;
      var kind = /^flightplans/i.test(n) ? 'fp' : /^aircraft/i.test(n) ? 'ac' : /^airports/i.test(n) ? 'ap'
        : /AC#\d+\s*,[^,\n]*,\s*\d+%/i.test(t) ? 'fp' : /AC#\d+\s*,\s*\d*\s*,\s*"/i.test(t) ? 'ac' : /^[A-Z0-9]{3,4},[NS]\d/m.test(t) ? 'ap' : '';
      if (kind === 'fp') fp = files[i]; else if (kind === 'ac') ac = files[i]; else if (kind === 'ap') ap = files[i];
    }
    if (!fp) { aitmToast('Select the Flightplans_….txt file (together with Aircraft_….txt).', true); return; }
    aitmLoadTxt(fp, ac, ap);
  };
  inp.click();
}
function aitmReadText(file) {
  return file.arrayBuffer().then(function (b) {
    var u = new Uint8Array(b);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u).replace(/^\uFEFF/, ''); }
    catch (e) { return new TextDecoder('windows-1252').decode(u); }
  });
}
function aitmOpenBgl() {
  var inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.bgl';
  inp.onchange = async function () {
    var f = inp.files && inp.files[0]; if (!f) return;
    try { aitmLoadBgl(await f.arrayBuffer(), f.name); } catch (e) { aitmToast(f.name + ': ' + e.message, true); }
  };
  inp.click();
}
function aitmLoadBgl(buf, name) {
  var d = AITM_CODEC.readBGL(buf);
  var sb = aitmSplitBase(name);
  aitmLoad({ aircraft: d.aircraft.map(function (a, i) { return { n: i + 1, title: a.title, speed: a.speed }; }), plans: d.plans, apx: d.airports,
             base: sb.base, name: sb.name, period: sb.period, source: name });
  aitm.outName = name; aitmSave(); aitmRenderBottom();
  aitmToast(name + ' loaded (' + d.plans.length + ' flight plans).');
}
// to the AI Generator: the loaded plan goes through its TTools import (routes on page 1, every rotation on its
// aircraft and day in the Rotation Planner), so legs and rotations can be added or deleted there. The import reads
// airline and type from the titles; real AIG titles ("AIGAIM_Aer Lingus Airbus A330-300") it would misread, so both
// are handed over per AC#. Plans shorter than a week (24Hr …) become weekly plans - the planner plans weeks.
function aitmToGenerator() {
  if (!aitm.plans.length) { aitmToast('Load a flight plan first.', true); return; }
  if (typeof aiGenAlImportTTools !== 'function') { aitmToast('The AI Generator is not available on this page.', true); return; }
  var unknown = aitmUsedAirports().filter(function (c) { return typeof schedByCode === 'undefined' || !schedByCode[c]; });
  if (!unknown.length) { aitmToGeneratorGo(); return; }
  aitmModal('Airports unknown to the AI Generator',
    '<div style="font-size:12px;color:var(--txt2);line-height:1.6;">' + unknown.length + ' airport' + (unknown.length === 1 ? ' is' : 's are') + ' not in the airport database: <b style="color:#fff;font-family:monospace;">' + unknown.map(aitmEsc).join(', ') + '</b>.<br>'
    + 'The AI Generator leaves out the rotations that use ' + (unknown.length === 1 ? 'it' : 'them') + '. Add ' + (unknown.length === 1 ? 'it' : 'them') + ' first (right-click the airport → Airport Data), or transfer without those rotations.</div>',
    [['Transfer anyway', function () { aitmCloseModal(); aitmToGeneratorGo(); }]]);
}
async function aitmToGeneratorGo() {
  var maps = aitmAirlineMaps(), info = {}, isAp = aitm.kind === 'airport';
  aitm.ac.forEach(function (a) {
    var inf = aitmAcAirlineInfo(a), inst = aitmInstalled(a.title);
    var code = inf.code || aitmCodeByName(inf.name, maps) || (isAp ? '' : aitm.code) || '';
    info[a.n] = { airline: String(code).toUpperCase(), eqp: (inst && inst.icaoType) || aitmAcSig(a) || '' };
  });
  var conv = 0;
  var plans = aitm.plans.map(function (p) {
    var P = AITM_CODEC.periodOf(p.period)[1];
    if (P >= 10080) return p;
    conv++;
    var legs = [];
    for (var r = 0; r < Math.floor(10080 / P); r++) p.legs.forEach(function (l) {
      var d = l.dep + r * P, blk = l.arr == null ? null : ((l.arr - l.dep) % P + P) % P;
      legs.push(Object.assign({}, l, { dep: d, arr: blk == null ? null : d + blk }));
    });
    return Object.assign({}, p, { period: 'WEEK', legs: legs });
  });
  var base = aitm.fileBase || ('CRE_' + (isAp ? aitm.apIcao : (aitm.code || 'Airline')));
  var fpTxt = '//FSXDAYS=False\n' + plans.map(AITM_CODEC.planToTxt).join('\n') + '\n';
  var acTxt = AITM_CODEC.aircraftToTxt(aitm.ac) + '\n';
  var what = isAp ? 'the flight plan of ' + aitm.apIcao : (aitm.name || aitm.code || 'this flight plan');
  switchView('aigen');
  setAiGenMode(isAp ? 'airport' : 'airline');
  await aiGenAlImportTTools([new File([fpTxt], 'Flightplans_' + base + '.txt'), new File([acTxt], 'Aircraft_' + base + '.txt')], {
    info: info, airline: isAp ? '' : aitm.code, hub: isAp ? aitm.apIcao : null,
    confirmText: 'Replace the current routes and the rotation planner of the AI Generator with ' + what + ' from the AI Traffic Manager?'
  });
  var rs = document.getElementById('rot-status');
  if (conv && rs && currentView === 'rotations') rs.textContent += ' · ' + conv + ' plan' + (conv === 1 ? '' : 's') + ' shorter than a week turned into weekly plans';
}

// from the Rotation Planner (AI Generator page 2)
function aitmFromGenerator() {
  if (typeof buildTToolsData !== 'function' || !rotAircraft || !rotAircraft.length) { alert('No rotations yet. Create rotations and assign them to aircraft first.'); return; }
  var data = buildTToolsData(1);
  if (!data) { alert('No flights have been assigned to any aircraft yet. Drag rotations onto the aircraft first.'); return; }
  var acs = AITM_CODEC.parseAircraftTxt(data.aircraftLines.join('\n'));
  var fp = AITM_CODEC.parseFlightplansTxt(data.fpLines.join('\n'));
  // AC# -> aircraft type of the planner (fpLines are written in rotAircraft order)
  var hints = {}, als = {}, withPlan = rotAircraft.filter(function (ac) { return rotAircraftCycle(ac); });
  fp.plans.forEach(function (p, i) { var ac = withPlan[i]; if (ac && !hints[p.ac]) { hints[p.ac] = ac.eqp || ''; als[p.ac] = ac.airline || ''; } });
  var list = aitmAcList(acs, fp.plans, function (a) {
    if (/^AIGAIM_\S+ \S+ NCv2$/.test(a.title)) a.speed = 0;   // planner placeholder
    a.hint = hints[a.n] || ''; a.al = als[a.n] || ''; return a;
  });
  var hub = (typeof aiGenMulti !== 'undefined' && aiGenMulti && typeof aiGenAlHub !== 'undefined' && aiGenAlHub) ? aiGenAlHub[0]
          : (aiGenMode === 'airport' && typeof aiGenTarget !== 'undefined' && aiGenTarget) ? aiGenTarget[0] : '';
  var code = (aiGenMode === 'airline' && aiGenAirline && !hub) ? aiGenAirline : '';
  var period = '';
  try { var tz = (typeof aiGenTzDateNow === 'function') ? aiGenTzDateNow() : ''; if (tz) { var mo = parseInt(tz.slice(5, 7), 10); period = (mo >= 4 && mo <= 10 ? 'Summer ' : 'Winter ') + tz.slice(0, 4); } } catch (e) {}
  var name = (code && typeof AIRLINE_NAMES !== 'undefined' && AIRLINE_NAMES[code]) || code;
  if (hub) aitmLoad({ aircraft: list, plans: fp.plans, apx: {}, base: 'CRE_' + hub, name: hub, airport: hub, kind: 'airport', period: period, source: 'AI Generator' });
  else aitmLoad({ aircraft: list, plans: fp.plans, apx: {}, base: 'CRE_' + String(name || code || 'Airline').replace(/\s+/g, ''), name: name, period: period, code: code, source: 'AI Generator' });
  switchView('aitm');
}

// ── rendering ──
function aitmInit() {
  if (!aitm.inited) {
    aitm.inited = true;
    aitmRestore();
    aitmKvGet('fleetCache').then(function (c) {
      if (c && c.list && !aitm.fleet.length) { aitm.fleet = c.list.filter(function (e) { return e.root; }); aitm.sources = c.sources || []; aitm.fleetMeta = c.meta || {}; aitmFleetIndex(); aitmRenderAll(); }
      // once Rotation Map has answered: read the installed aircraft again whenever the tab is opened
      // (background request only - no window pops up when the tab opens; Chrome must allow it, see aitmLnaState)
      var rmOk = false; try { rmOk = localStorage.getItem('aitm_rm_ok') === '1'; } catch (e) {}
      aitmLnaState().then(function (st) { aitm._lna = st; if (rmOk || st === 'granted') aitmUpdateInstalled({ silent: true }); });
    });
    aitmKvSet('acFolders', []);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') aitmCloseModal();
      // Del: delete the selected flight plans (Legs visible, no dialog open, not typing)
      if ((e.key === 'Delete' || e.key === 'Del') && aitm.sel.length && !document.getElementById('aitm-modal')) {
        var t = e.target, legs = document.getElementById('aitm-legs');
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        if (!legs || !legs.offsetParent) return;
        e.preventDefault(); aitmAskDeletePlans(aitm.sel.slice());
      }
    });
  }
  aitmRenderAll();
  if (!aitm.logoUrl) aitmFindLogo();
}
function aitmRenderAll() {
  if (!document.getElementById('aitm-legs')) return;
  if (!aitm.byTitle) aitmFleetIndex();
  aitmRenderHeader(); aitmRenderLegs(); aitmRenderAirports(); aitmRenderAircraft(); aitmRenderFleet(); aitmRenderBottom();
}
function aitmUsedAirports() {
  var seen = {}, list = [];
  aitm.plans.forEach(function (p) { p.legs.forEach(function (l) { if (!seen[l.to]) { seen[l.to] = 1; list.push(l.to); } }); });
  return list.sort();
}
function aitmRenderHeader() {
  var el = document.getElementById('aitm-head'); if (!el) return;
  var nLegs = 0; aitm.plans.forEach(function (p) { nLegs += p.legs.length; });
  var logo = aitm.kind === 'airport'
    ? '<div title="Airport plan — airport location sign" style="display:inline-flex;background:#0a0a0a;border-radius:4px;padding:5px;box-shadow:0 0 0 1px #2a2a2a;">'
      + '<span style="border:3px solid #f7c600;border-radius:2px;color:#f7c600;font:700 30px/1 \'Arial Narrow\',\'Roboto Condensed\',Arial,sans-serif;letter-spacing:.1em;padding:6px 12px 5px;">' + aitmEsc(aitm.apIcao) + '</span></div>'
    : aitm.logoUrl ? '<img src="' + aitm.logoUrl + '" alt="" style="max-height:46px;max-width:170px;object-fit:contain;">'
    : '<div onclick="aitm.logos=null;aitmFindLogo(true);" title="No logo found — click to look again (Chrome may ask for the logo folders). Logo folders: Folders, top right of the fleet list." style="cursor:pointer;font-size:22px;font-weight:800;letter-spacing:.12em;color:#fff;">' + aitmEsc(aitm.code || '—') + '</div>';
  var stat = function (k, v, click, tip) {
    return '<div style="display:flex;flex-direction:column;gap:2px;' + (click ? 'cursor:pointer;' : '') + '"' + (click ? ' onclick="' + click + '"' : '') + (tip ? ' title="' + tip + '"' : '') + '>'
      + '<span style="font-size:10px;color:var(--txt3);font-weight:600;text-transform:uppercase;letter-spacing:.06em;">' + k + '</span>'
      + '<span style="font-size:15px;font-weight:700;color:#fff;">' + v + '</span></div>';
  };
  el.innerHTML =
    '<div style="display:flex;align-items:center;gap:30px;flex-wrap:wrap;">'
    + '<div style="min-width:120px;display:flex;align-items:center;">' + logo + '</div>'
    + (aitm.kind === 'airport'
      ? stat('Airport', aitmEsc(aitm.name || aitm.apIcao) + ' <span style="font-size:11px;color:var(--txt2);font-weight:600;">' + aitmEsc(aitm.apIcao) + '</span>', 'aitmEditHead()', 'Click to change')
      : stat('Airline', aitmEsc(aitm.name || '—') + (aitm.code ? ' <span style="font-size:11px;color:var(--txt2);font-weight:600;">' + aitmEsc(aitm.code) + '</span>' : ''), 'aitmEditHead()', 'Click to change name and code'))
    + stat('Period', aitmEsc(aitm.period || '—'), 'aitmEditHead()', 'Click to change')
    + stat('Fleet', aitm.plans.length + ' aircraft')
    + stat('Legs', nLegs + ' legs')
    + (aitm.source ? '<div style="font-size:11px;color:var(--txt3);align-self:flex-end;">from ' + aitmEsc(aitm.source) + '</div>' : '')
    + '</div>'
    + '<div style="display:flex;align-items:center;gap:10px;">'
    + '<div style="display:flex;border:1px solid var(--bdr2);border-radius:6px;overflow:hidden;">'
    + [['utc', 'UTC'], ['today', 'Local today'], ['eusummer', 'Local EU summer']].map(function (m) {
        var on = aitm.tmode === m[0];
        return '<button onclick="aitmSetTmode(\'' + m[0] + '\')" style="font-size:12px;font-weight:600;padding:6px 12px;border:none;border-right:1px solid var(--bdr2);background:' + (on ? 'var(--acc)' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--txt2)') + ';cursor:pointer;">' + m[1] + '</button>';
      }).join('') + '</div>'
    + (aitm.plans.length ? '<button onclick="aitmRotationMap()" title="' + aitmEsc('Open ' + (aitm.kind === 'airport' ? 'airport ' + aitm.apIcao : (aitm.name || aitm.code || 'this airline')) + ' in Rotation Map.\nRotation Map has to run on this PC (globe icon next to the clock).') + '" style="font-size:12px;font-weight:600;padding:6px 12px;border-radius:6px;border:1px solid var(--bdr2);background:transparent;color:var(--txt2);cursor:pointer;white-space:nowrap;">🌐 Rotation Map ↗</button>' : '')
    + '</div>';
}
function aitmSetTmode(m) { aitm.tmode = m; aitmSave(); aitmRenderHeader(); aitmRenderLegs(); aitmRenderAirports(); }
function aitmEditHead() {
  var isAp = aitm.kind === 'airport';
  aitmModal('Flight plan of',
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;">'
    + '<label style="font-size:12px;color:var(--txt2);">Kind</label><select id="aitm-h-kind" class="aitm-in" style="width:140px;"><option value="airline"' + (isAp ? '' : ' selected') + '>Airline</option><option value="airport"' + (isAp ? ' selected' : '') + '>Airport</option></select>'
    + '<label style="font-size:12px;color:var(--txt2);">Name</label><input id="aitm-h-name" class="aitm-in" value="' + aitmEsc(aitm.name) + '">'
    + '<label style="font-size:12px;color:var(--txt2);">ICAO code</label><input id="aitm-h-code" class="aitm-in" style="width:90px;text-transform:uppercase;" value="' + aitmEsc(isAp ? aitm.apIcao : aitm.code) + '">'
    + '<label style="font-size:12px;color:var(--txt2);">Period</label><input id="aitm-h-period" class="aitm-in" value="' + aitmEsc(aitm.period) + '" placeholder="e.g. Summer 2026">'
    + '</div>',
    [['Save', function () {
      aitm.kind = document.getElementById('aitm-h-kind').value;
      aitm.name = document.getElementById('aitm-h-name').value.trim();
      var cd = document.getElementById('aitm-h-code').value.trim().toUpperCase();
      if (aitm.kind === 'airport') { aitm.apIcao = cd; aitm.code = ''; if (aitm.logoUrl) { URL.revokeObjectURL(aitm.logoUrl); aitm.logoUrl = null; } }
      else { aitm.code = cd; aitm.apIcao = ''; }
      aitm.period = document.getElementById('aitm-h-period').value.trim();
      aitmSave(); aitmCloseModal(); aitmRenderAll(); aitmFindLogo();
    }]]);
}
// minute in period -> display stamp in the chosen time mode at airport icao
function aitmStamp(min, P, icao) {
  if (min == null) return '—';
  if (aitm.tmode !== 'utc') { var o = aitmOffset(icao); if (o != null) min = min + Math.round(o * 60); }
  return AITM_CODEC.fmtStamp(((min % P) + P) % P, P);
}
function aitmPlanHtml(p, i) {
  var P = AITM_CODEC.periodOf(p.period)[1], n = p.legs.length;
  var a = aitmAcByN(p.ac);
  var tn = a ? aitmAcTypeName(a) : '';
  var parts = [];
  p.legs.forEach(function (l, j) {
    var from = p.legs[(j - 1 + n) % n].to;
    parts.push(aitmStamp(l.dep, P, from) + ',' + aitmStamp(l.arr, P, l.to) + ',' + l.alt + ',' + l.fr + ',' + aitmEsc(l.fnum) + ',<b style="color:#fff;font-weight:600;">' + aitmEsc(l.to) + '</b>');
  });
  var sel = aitm.sel.indexOf(i) >= 0;
  return '<div class="aitm-pl' + (sel ? ' sel' : '') + '" data-i="' + i + '">'
    + '<span class="aitm-tn" title="' + aitmEsc(tn) + '">' + aitmEsc(tn || '?') + '</span>'
    + '<span class="aitm-3d aitm-pl3d" title="3D view of ' + aitmEsc(a ? a.title : 'this aircraft') + ' (in Rotation Map)">3D</span> '
    + (sel ? '<span class="aitm-pldel" title="Delete this flight plan' + (aitm.sel.length > 1 ? ' (and the other selected ones)' : '') + ' — or press Del">🗑</span> ' : '')
    + '<span class="aitm-chip" data-i="' + i + '" title="Click to give this flight plan (or all selected ones) another AC#">AC#' + p.ac + '</span>'
    + '<span>, ' + aitmEsc(p.reg) + ', ' + (p.pct || 1) + '%, ' + aitmEsc(String(p.period).toUpperCase()) + ', ' + p.rules + ', ' + parts.join(', ') + '</span></div>';
}
function aitmRenderLegs() {
  var el = document.getElementById('aitm-legs'); if (!el) return;
  var cnt = document.getElementById('aitm-legs-count');
  if (cnt) cnt.textContent = aitm.plans.length ? aitm.plans.length + ' flight plans' + (aitm.sel.length ? ' · ' + aitm.sel.length + ' selected' : '') + (aitm.tmode !== 'utc' ? ' · times local' : ' · times UTC') : '';
  if (!aitm.plans.length) {
    el.innerHTML = '<div style="padding:30px 16px;color:var(--txt3);font-size:13px;line-height:1.7;">No flight plan loaded.<br>Use <b>Open txt</b> (Flightplans_… + Aircraft_…), <b>Open BGL</b>, or <b>→ AI Traffic Manager</b> in the Rotation Planner.</div>';
    return;
  }
  el.innerHTML = aitm.plans.map(aitmPlanHtml).join('');
}
function aitmLegsTip(i) {
  var p = aitm.plans[i]; if (!p) return '';
  var P = AITM_CODEC.periodOf(p.period)[1], n = p.legs.length, a = aitmAcByN(p.ac);
  var DN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var dayName = function (min, icao) {
    if (min == null || P < 10080) return '';
    var m = min; if (aitm.tmode !== 'utc') { var o = aitmOffset(icao); if (o != null) m += Math.round(o * 60); }
    m = ((m % P) + P) % P; return DN[Math.floor(m / 1440) % 7];
  };
  var rows = p.legs.map(function (l, j) {
    var from = p.legs[(j - 1 + n) % n].to;
    var blk = l.arr == null ? null : ((l.arr - l.dep) % P + P) % P;
    return '<tr><td style="color:var(--txt3);">' + (j + 1) + '</td><td>' + dayName(l.dep, from) + ' ' + aitmStamp(l.dep, P, from).replace(/^\d+\//, '') + '</td>'
      + '<td>' + aitmEsc(from) + '→<b style="color:#fff;">' + aitmEsc(l.to) + '</b></td>'
      + '<td>' + dayName(l.arr, l.to) + ' ' + aitmStamp(l.arr, P, l.to).replace(/^\d+\//, '') + '</td>'
      + '<td>' + (blk == null ? '' : Math.floor(blk / 60) + ':' + String(blk % 60).padStart(2, '0')) + '</td>'
      + '<td>FL' + l.alt + '</td><td>' + aitmEsc(l.fnum) + '</td></tr>';
  }).join('');
  return '<div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:6px;">' + aitmEsc(p.reg) + ' · AC#' + p.ac + ' ' + aitmEsc(a ? a.title : '') + '</div>'
    + '<div style="font-size:11px;color:var(--txt3);margin-bottom:6px;">' + aitmEsc(p.period) + ' · ' + p.rules + ' · ' + n + ' legs · times ' + (aitm.tmode === 'utc' ? 'UTC' : 'local') + '</div>'
    + '<table style="border-collapse:collapse;font-family:monospace;font-size:11px;color:var(--txt2);">'
    + '<tr style="color:var(--txt3);"><td>#</td><td>Dep</td><td>Route</td><td>Arr</td><td>Block</td><td>Alt</td><td>Flt</td></tr>' + rows + '</table>';
}
// departures per week from each airport (a leg departs from the previous leg's destination; DAY plans count 7×)
function aitmApDepCounts() {
  var cnt = {};
  aitm.plans.forEach(function (p) {
    var n = p.legs.length, P = 10080;
    try { P = AITM_CODEC.periodOf(p.period)[1] || 10080; } catch (e) {}
    p.legs.forEach(function (l, j) {
      if (l.dep == null) return;
      var from = p.legs[(j - 1 + n) % n].to;
      cnt[from] = (cnt[from] || 0) + 10080 / P;
    });
  });
  return cnt;
}
// columns: ICAO · city · UTC offset · departures per week (both right-aligned, fixed width, so they line up)
var AITM_AP_COLS = 'display:grid;grid-template-columns:44px minmax(0,1fr) 46px 38px;align-items:center;column-gap:8px;';
function aitmRenderAirports() {
  var el = document.getElementById('aitm-aps'); if (!el) return;
  var list = aitmUsedAirports(), cnt = aitmApDepCounts();
  var c = document.getElementById('aitm-aps-count'); if (c) c.textContent = list.length ? list.length : '';
  var fmtN = function (x) { x = Math.round((x || 0) * 10) / 10; return String(x); };
  var head = '<div style="' + AITM_AP_COLS + 'position:sticky;top:-4px;z-index:1;background:var(--bg);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--txt3);padding:2px 6px 4px;border-bottom:1px solid var(--bdr);margin-bottom:2px;">'
    + '<span>ICAO</span><span>City</span><span style="text-align:right;">UTC</span><span style="text-align:right;" title="Departures per week from this airport (arrivals not counted)">Dep</span></div>';
  el.innerHTML = list.length ? head + list.map(function (icao) {
    var a = aitmAp(icao), o = aitmOffset(icao), n = cnt[icao] || 0;
    var bad = !a;
    return '<div class="aitm-ap" data-icao="' + aitmEsc(icao) + '" style="' + AITM_AP_COLS + '" title="' + aitmEsc((a ? (a.name || '') : 'Unknown airport — no coordinates, cannot be compiled') + '\n' + fmtN(n) + ' departure' + (n === 1 ? '' : 's') + ' per week\nDouble-click: flight schedule · right-click: Airport Data and more') + '">'
      + '<span style="font-family:monospace;font-weight:700;color:' + (bad ? '#f85149' : '#fff') + ';">' + aitmEsc(icao) + '</span>'
      + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--txt2);">' + aitmEsc(a ? (a.city || a.name) : 'unknown') + '</span>'
      + '<span style="font-family:monospace;color:var(--txt2);text-align:right;">' + (a ? aitmFmtOff(o) : '') + '</span>'
      + '<span style="font-family:monospace;text-align:right;color:' + (n ? '#fff' : 'var(--txt3)') + ';">' + fmtN(n) + '</span></div>';
  }).join('') : '';
}
function aitmRenderAircraft() {
  var el = document.getElementById('aitm-acs'); if (!el) return;
  var use = {}; aitm.plans.forEach(function (p) { use[p.ac] = (use[p.ac] || 0) + 1; });
  el.innerHTML = aitm.ac.map(function (a, i) {
    var inst = aitmInstalled(a.title);
    var dot = inst ? '#3fb950' : (aitm.fleet.length ? '#f85149' : 'var(--txt3)');
    var tip = inst ? 'Installed (' + inst.src + ' · ' + inst.folder + ')' : (aitm.fleet.length ? 'Not found among your installed aircraft — drag one from the right' : 'Connect your aircraft folders on the right to check');
    return '<div class="aitm-ac" data-i="' + i + '" title="' + aitmEsc(tip) + ' · double-click for more">'
      + '<span style="font-family:monospace;color:var(--txt3);min-width:22px;flex-shrink:0;">' + a.n + '</span>'
      + '<span style="width:8px;height:8px;border-radius:50%;background:' + dot + ';flex-shrink:0;"></span>'
      + '<span style="flex:1;min-width:0;"><span style="display:block;color:#fff;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + aitmEsc(a.title) + '</span>'
      + '<span style="display:block;font-size:10px;color:var(--txt3);">' + (aitm.fleet.length && !inst ? '<span style="color:#f85149;font-weight:600;">' + (/^AC#\d+$/i.test(a.title) || /^AIGAIM_[A-Z0-9]{2,4}\s+\S+\s+NCv2$/.test(a.title) ? 'no aircraft assigned' : 'not installed') + '</span> · ' : '')
      + aitmEsc(aitmAcTypeName(a) || a.hint || '') + (a.speed ? ' · ' + a.speed + ' kts' : '') + ' · ' + (use[a.n] || 0) + ' FP</span></span></div>';
  }).join('') || '<div style="padding:12px;color:var(--txt3);font-size:12px;">—</div>';
}
// hits of the fleet search; aitm._fleetRank[i]: 0 = title starts with the first word, 1 = all words in the title,
// 2 = found only in type, airline, codes, folder … (AIG's model folders are called "FAIB_…", so "FAIB" matched
// thousands of AIG liveries before your own "FAIB B742 VRG"). aitm.fleetSrc: 'all' | 'own' | 'aig'
// AIG model: a livery in AIG's package, or AIG's model copied into one of your own packages
// (folder "AIG_A330-200_PW", title "AIG A332 CTM_…") - the AIG switch shows both, Own shows everything outside AIG's package
function aitmIsAigModel(e) { return e.src === 'AIG' || /^AIG(AIM)?_/i.test(e.folder || '') || /^AIG(AIM)?[ _]/i.test(e.title || ''); }
function aitmFleetMatches(q, srcOverride) {
  var toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean), src = srcOverride || aitm.fleetSrc || 'all', rank = {};
  var hits = aitm.fleet.filter(function (e) {
    if (src === 'aig' && !aitmIsAigModel(e)) return false;
    if (src === 'own' && e.src === 'AIG') return false;
    if (!toks.length) { rank[e.i] = 1; return true; }
    var t = String(e.title || '').toLowerCase();
    var hay = (t + ' ' + e.uiType + ' ' + e.uiVar + ' ' + e.airline + ' ' + e.sig + ' ' + e.icaoType + ' ' + e.codes + ' ' + e.folder + ' ' + e.atcAirline + ' ' + aitmTypeName(e.sig)).toLowerCase();
    if (!toks.every(function (k) { return hay.indexOf(k) >= 0; })) return false;
    rank[e.i] = toks.every(function (k) { return t.indexOf(k) >= 0; }) ? (t.indexOf(toks[0]) === 0 ? 0 : 1) : 2;
    return true;
  });
  aitm._fleetRank = rank;
  return hits;
}
function aitmSetFleetSrc(v) {
  aitm.fleetSrc = v; try { localStorage.setItem('aitm_fleet_src', v); } catch (e) {}
  aitmRenderFleet();
}
function aitmRenderFleet() {
  var el = document.getElementById('aitm-fleet'); if (!el) return;
  var q = aitm.fleetQ == null ? aitmDefaultQuery() : aitm.fleetQ;
  var inp = document.getElementById('aitm-fleet-q'); if (inp && document.activeElement !== inp) inp.value = q;
  var st = document.getElementById('aitm-fleet-status');
  if (!aitm.fleet.length) {
    el.innerHTML = '<div style="padding:16px 12px;color:var(--txt3);font-size:12px;line-height:1.7;">No installed aircraft read yet.<br>'
      + '<button class="aitm-btn" style="margin:6px 0;border-color:#3fb950;color:#3fb950;" onclick="aitmReadAircraftFolder()">Read aircraft folder…</button><br>'
      + 'Once for each folder:<br>· AIG <span style="font-family:monospace;font-size:11px;">C:\\MSFS\\Microsoft Flight Simulator Add-ons\\AIG AI Manager\\aig-aitraffic-oci</span><br>'
      + '· your own <span style="font-family:monospace;font-size:11px;">OneDrive …\\AI Traffic by CRE\\AI Traffic Aircraft</span><br>'
      + 'Chrome then asks whether to “upload” the files — nothing leaves your PC, the page only reads the aircraft.cfg files. The result is kept until you read a folder again.</div>';
    if (st) st.textContent = '';
    aitm.fleetShown = []; return;
  }
  if (aitm.fleetSrc == null) { try { aitm.fleetSrc = localStorage.getItem('aitm_fleet_src') || 'all'; } catch (e) { aitm.fleetSrc = 'all'; } }
  var sw = document.getElementById('aitm-fleet-src');
  if (sw) {
    var nOwn = aitm.fleet.filter(function (e) { return e.src !== 'AIG'; }).length, nAig = aitm.fleet.filter(aitmIsAigModel).length;
    sw.innerHTML = [['all', 'All', aitm.fleet.length], ['own', 'Own', nOwn], ['aig', 'AIG', nAig]].map(function (o) {
      var on = aitm.fleetSrc === o[0];
      return '<button onclick="aitmSetFleetSrc(\'' + o[0] + '\')" title="' + (o[0] === 'all' ? 'All installed liveries' : o[0] === 'own' ? 'Liveries outside AIG’s package (your own, IVAO, FSLTL …)' : 'AIG models: AIG’s package and AIG models in your own packages') + ' — ' + o[2] + '" style="padding:2px 8px;font-size:10px;border:1px solid ' + (on ? '#58a6ff' : 'var(--bdr2)') + ';background:' + (on ? 'rgba(88,166,255,.15)' : 'transparent') + ';color:' + (on ? '#58a6ff' : 'var(--txt3)') + ';cursor:pointer;margin-left:-1px;' + (o[0] === 'all' ? 'border-radius:4px 0 0 4px;' : o[0] === 'aig' ? 'border-radius:0 4px 4px 0;' : '') + '">' + o[1] + '</button>';
    }).join('');
  }
  // the switch hides some hits: say so, with a link to All
  var nAll = (aitm.fleetSrc && aitm.fleetSrc !== 'all') ? aitmFleetMatches(q, 'all').length : 0;
  var hits = aitmFleetMatches(q), rank = aitm._fleetRank || {};
  var hidden = Math.max(0, nAll - hits.length);
  // the best fitting livery for each AC# first, in AC# order — select them all and drag them over at once
  var best = aitmBestMatches(), top = [], seen = {};
  best.forEach(function (e, i) { if (e && !seen[e.i]) { seen[e.i] = 1; top.push({ e: e, ac: aitm.ac[i].n }); } });
  // titles that contain the search first, then your own liveries before AIG's, then by type
  var rest = hits.filter(function (e) { return !seen[e.i]; }).sort(function (a, b) {
    return (rank[a.i] - rank[b.i]) || ((a.src === 'AIG') - (b.src === 'AIG')) || (a.sig || 'ZZZ').localeCompare(b.sig || 'ZZZ') || a.title.localeCompare(b.title);
  });
  var shown = top.map(function (x) { return x.e; }).concat(rest.slice(0, 1500));
  aitm.fleetShown = shown;
  aitm.fleetSel = aitm.fleetSel.filter(function (ix) { return shown.some(function (e) { return e.i === ix; }); });
  var acOf = {}; top.forEach(function (x) { acOf[x.e.i] = x.ac; });
  el.innerHTML = shown.map(function (e, k) {
    var sel = aitm.fleetSel.indexOf(e.i) >= 0;
    var used = aitm.ac.some(function (a) { return a.title.toLowerCase() === e.title.toLowerCase(); });
    return (k === top.length && top.length ? '<div style="border-top:1px dashed var(--bdr2);margin:4px 0;"></div>' : '')
      + '<div class="aitm-fl' + (sel ? ' sel' : '') + '" draggable="true" data-k="' + k + '" title="' + aitmEsc(e.title + '\n' + e.uiType + (e.uiVar ? ' · ' + e.uiVar : '') + '\n' + e.src + ' · ' + e.folder + (e.codes ? '\nparking codes ' + e.codes : '')) + '">'
      + (acOf[e.i] ? '<span class="aitm-hint" title="Best fit for AC#' + acOf[e.i] + '">→' + acOf[e.i] + '</span>' : '<span class="aitm-hint"></span>')
      + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + (used ? 'color:#3fb950;' : '') + '">' + aitmEsc(e.title) + '</span>'
      + '<span style="font-size:10px;color:var(--txt3);white-space:nowrap;">' + aitmEsc(e.sig || '') + (e.speed ? ' ' + e.speed : '') + '</span>'
      + '<span class="aitm-3d" title="3D view of this livery">3D</span></div>';
  }).join('') + (hidden ? '<div style="padding:8px 12px;color:#f0b400;font-size:12px;">' + hidden + ' more under <a href="#" style="color:#58a6ff;" onclick="aitmSetFleetSrc(\'all\');return false;">All</a> — the ' + (aitm.fleetSrc === 'aig' ? 'AIG' : 'Own') + ' switch hides them.</div>'
    : shown.length ? '' : '<div style="padding:12px;color:var(--txt3);font-size:12px;">Nothing matches “' + aitmEsc(q) + '”.</div>');
  if (st) st.title = hits.length > shown.length ? 'Only the first ' + shown.length + ' are listed — type more to narrow the search' : '';
  if (st) st.textContent = hits.length + ' of ' + aitm.fleet.length + (hits.length > shown.length ? ' · first ' + shown.length : '') + (aitm.fleetSel.length ? ' · ' + aitm.fleetSel.length + ' selected' : '');
}
function aitmRenderBottom() {
  aitmUpdateCompileBtn();
  var el = document.getElementById('aitm-out-name'); if (el && document.activeElement !== el) el.value = aitm.outName || '';
  aitmKvGet('outFolder').then(function (h) {
    var f = document.getElementById('aitm-out-folder');
    if (f) f.textContent = h ? h.name : 'not chosen — click to choose your “AI Traffic BGL” package folder';
  });
}

// ── interaction ──
function aitmBind() {
  var legs = document.getElementById('aitm-legs');
  if (legs && !legs._b) {
    legs._b = 1;
    legs.addEventListener('click', function (e) {
      var chip = e.target.closest('.aitm-chip');
      if (chip) { e.stopPropagation(); aitmAcMenu(parseInt(chip.dataset.i, 10), chip); return; }
      var b3 = e.target.closest('.aitm-pl3d');
      if (b3) { e.stopPropagation(); aitmPlan3D(parseInt(b3.closest('.aitm-pl').dataset.i, 10)); return; }
      var del = e.target.closest('.aitm-pldel');
      if (del) { e.stopPropagation(); var di = parseInt(del.closest('.aitm-pl').dataset.i, 10); aitmAskDeletePlans(aitm.sel.indexOf(di) >= 0 ? aitm.sel.slice() : [di]); return; }
      var row = e.target.closest('.aitm-pl'); if (!row) return;
      var i = parseInt(row.dataset.i, 10);
      if (e.shiftKey && aitm.selAnchor != null) {
        var a = Math.min(aitm.selAnchor, i), b = Math.max(aitm.selAnchor, i); aitm.sel = [];
        for (var k = a; k <= b; k++) aitm.sel.push(k);
      } else if (e.ctrlKey || e.metaKey) {
        var x = aitm.sel.indexOf(i); if (x >= 0) aitm.sel.splice(x, 1); else aitm.sel.push(i); aitm.selAnchor = i;
      } else { aitm.sel = (aitm.sel.length === 1 && aitm.sel[0] === i) ? [] : [i]; aitm.selAnchor = i; }
      aitmRenderLegs();
    });
    legs.addEventListener('dblclick', function (e) { var row = e.target.closest('.aitm-pl'); if (row) aitmEditPlan(parseInt(row.dataset.i, 10)); });
    legs.addEventListener('mousemove', function (e) {
      var row = e.target.closest('.aitm-pl');
      if (!row) { rotTipHide(); return; }
      if (aitm._tipRow !== row) { aitm._tipRow = row; rotTipShow(e, aitmLegsTip(parseInt(row.dataset.i, 10))); } else rotTipMove(e);
    });
    legs.addEventListener('mouseleave', function () { aitm._tipRow = null; rotTipHide(); });
  }
  var aps = document.getElementById('aitm-aps');
  if (aps && !aps._b) {
    aps._b = 1;
    aps.addEventListener('dblclick', function (e) { var r = e.target.closest('.aitm-ap'); if (r) aitmApSchedule(r.dataset.icao); });
    aps.addEventListener('contextmenu', function (e) { var r = e.target.closest('.aitm-ap'); if (!r) return; e.preventDefault(); aitmApMenu(r.dataset.icao, e.clientX, e.clientY); });
  }
  var acs = document.getElementById('aitm-acs');
  if (acs && !acs._b) {
    acs._b = 1;
    acs.addEventListener('dblclick', function (e) { var c = e.target.closest('.aitm-ac'); if (c) aitmAcDialog(parseInt(c.dataset.i, 10)); });
    acs.addEventListener('dragover', function (e) { var c = e.target.closest('.aitm-ac'); if (!c) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; aitmDropHint(c); });
    acs.addEventListener('dragleave', function (e) { if (!acs.contains(e.relatedTarget)) aitmDropHint(null); });
    acs.addEventListener('drop', function (e) {
      var c = e.target.closest('.aitm-ac'); aitmDropHint(null); if (!c) return; e.preventDefault();
      var ks = []; try { ks = JSON.parse(e.dataTransfer.getData('text/plain') || '[]'); } catch (x) {}
      aitmAssign(parseInt(c.dataset.i, 10), ks);
    });
  }
  var fl = document.getElementById('aitm-fleet');
  if (fl && !fl._b) {
    fl._b = 1;
    fl.addEventListener('click', function (e) {
      var b3 = e.target.closest('.aitm-3d');
      if (b3) { e.stopPropagation(); var rr = b3.closest('.aitm-fl'); aitmOpen3D(aitm.fleetShown[parseInt(rr.dataset.k, 10)]); return; }
      var r = e.target.closest('.aitm-fl'); if (!r) return;
      var k = parseInt(r.dataset.k, 10), ix = aitm.fleetShown[k].i;
      if (e.shiftKey && aitm.fleetAnchor != null) {
        var a = Math.min(aitm.fleetAnchor, k), b = Math.max(aitm.fleetAnchor, k); aitm.fleetSel = [];
        for (var q = a; q <= b; q++) aitm.fleetSel.push(aitm.fleetShown[q].i);
      } else if (e.ctrlKey || e.metaKey) {
        var x = aitm.fleetSel.indexOf(ix); if (x >= 0) aitm.fleetSel.splice(x, 1); else aitm.fleetSel.push(ix); aitm.fleetAnchor = k;
      } else { aitm.fleetSel = [ix]; aitm.fleetAnchor = k; }
      aitmRenderFleet();
    });
    fl.addEventListener('dragstart', function (e) {
      var r = e.target.closest('.aitm-fl'); if (!r) return;
      var k = parseInt(r.dataset.k, 10), ix = aitm.fleetShown[k].i;
      var list = aitm.fleetSel.indexOf(ix) >= 0
        ? aitm.fleetShown.filter(function (x) { return aitm.fleetSel.indexOf(x.i) >= 0; }).map(function (x) { return x.i; })
        : [ix];
      e.dataTransfer.setData('text/plain', JSON.stringify(list));
      e.dataTransfer.effectAllowed = 'copy';
    });
  }
}
function aitmDropHint(c) {
  document.querySelectorAll('.aitm-ac.drop').forEach(function (x) { x.classList.remove('drop'); });
  if (c) c.classList.add('drop');
}
// drop installed liveries (fleet indices, in list order) onto AC#(i+1), AC#(i+2), …
// Several liveries that all carry a "→ AC#" hint go to their own AC#, wherever they are dropped.
function aitmAssign(i, ks) {
  var targets = ks.map(function (ix, j) { return i + j; });
  if (ks.length > 1) {
    var best = aitmBestMatches(), hintOf = {};
    best.forEach(function (e, k) { if (e) hintOf[e.i] = k; });
    var hinted = ks.map(function (ix) { return hintOf[ix]; });
    if (hinted.every(function (h) { return h != null; }) && new Set(hinted).size === hinted.length) targets = hinted;
  }
  var done = [];
  ks.forEach(function (ix, j) {
    var e = aitm.fleet[ix], a = aitm.ac[targets[j]]; if (!e || !a) return;
    a.title = e.title; if (e.speed) a.speed = e.speed; a.wing = e.wing || 0; done.push(a.n);
  });
  if (!done.length) return;
  aitm.fleetSel = []; aitm.fleetQ = null;
  var merged = aitmConsolidateAc();                         // now the same aircraft as another AC# → one AC#
  aitmSave(); aitmRenderAll();
  aitmToast((done.length === 1 ? 'AC#' + done[0] + ' replaced.' : done.length + ' aircraft replaced: AC#' + done.sort(function (a, b) { return a - b; }).join(', #') + '.')
    + (merged.length ? ' Merged: ' + aitmConsolidateMsg(merged) + '.' : ''));
}
function aitmAcMenu(pi, anchor) {
  var m = document.getElementById('aitm-menu'); if (m) m.remove();
  m = document.createElement('div'); m.id = 'aitm-menu';
  var r = anchor.getBoundingClientRect();
  m.style.cssText = 'position:fixed;z-index:10001;left:' + Math.min(r.left, window.innerWidth - 340) + 'px;top:' + (r.bottom + 4) + 'px;background:var(--surf);border:1px solid var(--bdr2);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.6);max-height:320px;overflow:auto;min-width:300px;padding:4px;';
  var targets = aitm.sel.indexOf(pi) >= 0 ? aitm.sel.slice() : [pi];
  m.innerHTML = '<div style="font-size:10px;color:var(--txt3);padding:4px 8px;text-transform:uppercase;letter-spacing:.06em;">' + (targets.length > 1 ? targets.length + ' flight plans' : aitmEsc(aitm.plans[pi].reg)) + ' → AC#</div>'
    + aitm.ac.map(function (a, i) {
      return '<div class="aitm-mi" data-n="' + a.n + '" style="padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px;color:var(--txt);display:flex;gap:8px;' + (aitm.plans[pi].ac === a.n ? 'background:var(--surf3);' : '') + '">'
        + '<span style="font-family:monospace;color:var(--txt3);min-width:34px;">#' + a.n + '</span><span>' + aitmEsc(a.title) + '</span></div>';
    }).join('');
  m.addEventListener('click', function (e) {
    var it = e.target.closest('.aitm-mi'); if (!it) return;
    var n = parseInt(it.dataset.n, 10);
    targets.forEach(function (t) { aitm.plans[t].ac = n; });
    m.remove(); aitmSave(); aitmRenderLegs(); aitmRenderAircraft();
  });
  document.body.appendChild(m);
  setTimeout(function () { document.addEventListener('mousedown', function h(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', h); } }); }, 0);
}

// ICAO airline code -> radio callsign, from the AIG flight plan database (FPDatabase.xml); used when no installed
// livery of the airline carries atc_airline
// airline name (lower case, letters and digits only) -> ICAO code, from the same database
var AITM_AL_BY_NAME = {"21air":"CSB","2excelaviation":"BRO","40mileair":"MLA","748airservices":"IHO","7aircargo":"TXG","9air":"JYH","absjets":"ABP","abudhabiaviation":"BAR","abxair":"ABX","acebelgiumfreighters":"FRH","actairlines":"RUN","advancedair":"WSN","aercaribe":"ACL","aerlingus":"EIN","aerlingusuk":"EUK","aerlink":"HVL","aerodili":"DTL","aeroexpressregional":"BPS","aeroflotrussianairlines":"AFL","aeroflyer":"KFA","aerogaviota":"GTV","aeroitalia":"AEZ","aerok":"EOK","aerolineasargentinas":"ARG","aerolineasestelar":"ETR","aerolineassosa":"NSO","aerologic":"BOX","aeromas":"MSM","aeromongolia":"MNG","aeronavestsm":"VTM","aeronomad":"ANK","aeropostal":"ALV","aeroserviciosdelacosta":"TAA","aerostan":"BSC","aerosucre":"KRE","aerotranscargo":"ATG","aerounion":"TNO","aerus":"RFD","africaairlines":"AAT","africacharterairline":"FSK","africanexpressairways":"AXK","africaworldairlines":"AFW","afriqiyahairways":"AAW","air001":"AMQ","air65aviation":"FGB","airadelphi":"MUS","airalgerie":"DAH","airanka":"TAH","airantilles":"KES","airarabia":"ABY","airarabiaabudhabi":"ADY","airarabiaegypt":"RBG","airarabiamaroc":"MAC","airasia":"AXM","airasiacambodia":"KTC","airasiax":"XAX","airastana":"KZR","airastra":"AWA","airatlantaeurope":"AAE","airatlantaicelandic":"ABD","airaustral":"REU","airaxairservices":"BJO","airbaltic":"BTI","airbelgiumcargo":"AAB","airblue":"ABQ","airborealis":"LBR","airborneo":"MWG","airbotswana":"BOT","airburkina":"VBW","airbusan":"ABL","airbustransportintl":"BGA","aircairo":"MSC","aircaledonie":"TPC","aircalin":"ACI","aircambodia":"KHV","aircanadarouge":"ROU","aircaraibes":"FWI","aircargocarriers":"SNC","aircentral":"LHA","aircentury":"CEY","airchangan":"CGN","aircharterseurope":"AGR","airchathams":"CVA","airchina":"CCA","airchinacargo":"CAO","airclasscargo":"QCL","aircmglobal":"RJR","aircongo":"DRC","airconnect":"KON","aircorsica":"CCM","aircotedivoire":"VRE","aircreebec":"CRQ","airdilijans":"NGT","airdjibouti":"DJU","airdo":"ADO","airdolomiti":"DLA","aireagle":"EPE","airest":"AEG","aireuropa":"AEA","airexplore":"AXE","airfastindonesia":"AFE","airflamenco":"WAF","airghana":"GHN","airgreenland":"GRL","airguilin":"CGH","airhaifa":"HFA","airhongkong":"AHK","airhorizont":"HAT","airindependence":"BJO","airindia":"AIC","airindiaexpress":"AXB","airinuit":"AIE","airjapan":"AJX","airkeywest":"KWX","airkiribati":"AKL","airkoryo":"KOR","airliaison":"LSJ","airlink":"LNK","airloyaute":"RLY","airmacau":"AMU","airmarshallislands":"CWM","airmaster":"RMX","airmauritius":"MAU","airmediterranean":"MAR","airmoana":"NTR","airmontenegro":"MNE","airmountain":"AMT","airnesiaroyalcargo":"MKT","airnet":"USC","airniugini":"ANG","airnorth":"ANT","airnorthregional":"ANO","airnunavut":"BFF","airpacairlines":"APC","airpanama":"PST","airpeace":"APK","airpremia":"APZ","airrarotonga":"RAR","airsaintpierre":"SPM","airsamarkand":"UZS","airsenegal":"SZN","airseoul":"ASV","airserbia":"ASL","airseven":"CAT","airseychelles":"SEY","airsfflightservices":"XSN","airsial":"SIF","airswift":"ATX","airtahiti":"VTA","airtahitinui":"THT","airtanzania":"ATC","airtaxibenin":"ABT","airtetiaroa":"TOA","airthanlwin":"RTL","airtransat":"TSC","airtransportinternational":"ATN","airtravel":"OTC","airvanuatu":"AVN","airwork":"AWK","airworkskenya":"AKS","airxcharter":"AXY","airzeta":"AIH","airzimbabwe":"AZW","aisairlines":"PNX","ajet":"TKJ","akasaair":"AKJ","alaskaairlines":"ASA","alaskacentralexpress":"AER","albastar":"LAV","albatrosairlines":"GAL","albinatiaviation":"ULC","aleutianairways":"SRY","alhayaaviation":"HYA","alkanair":"AKN","allegiantair":"AAY","allianceair":"LLR","allianceairlines":"UTY","allianceexecutivejets":"ALE","alliedaircargo":"AJK","allnipponairways":"ANA","almasriauniversalairlines":"LMU","alohaaircargo":"AAH","alpavia":"APP","alphasky":"JAG","alpineairexpress":"AIP","alrosa":"DRU","alsieexpress":"MMD","amakusaairlines":"AHX","amapolaflyg":"APF","amaslineaaerea":"AZN","amazonaircargo":"AMZ","amcairlines":"AMV","amelia":"AIA","americanairlines":"AAL","americanjet":"AJB","ameriflight":"AMF","amerijetinternational":"AJT","ameristarjetcharter":"AJI","anawings":"AKX","andeslineasaereas":"ANS","anguillaairservices":"AXL","animawings":"AWG","arajet":"DWI","arcenciel":"JMS","arianaafghanairlines":"AFG","arikair":"ARA","arkiaisraeliairlines":"AIZ","armeniaairways":"AMW","armeniagovernment":"ARY","armenianairlines":"AAG","arubaairlines":"ARU","ascendairwaysmalaysia":"AYG","asiacargoairlines":"TMG","asianaairlines":"AAR","asiapacificairlines":"MGE","askyairlines":"SKK","aslairlinesaustralia":"SFZ","aslairlinesbelgium":"TAY","aslairlinesfrance":"FPO","aslairlinesireland":"ABR","aslairlinesuk":"ABV","asmanairlines":"KNG","astralaviation":"ACP","ataairlines":"TBZ","atlanticairways":"FLI","atlasair":"GTI","atran":"VAS","atsaairlines":"AMP","auricair":"AUK","aurignyairservices":"AUR","aurora":"SHU","avaairlines":"AXV","avantiair":"ATV","aveloairlines":"VXP","avianca":"AVA","aviancacargo":"TPA","aviancacostarica":"LRC","aviancaecuador":"GLG","aviancaelsalvador":"TAI","aviancaexpress":"AVR","aviancaguatemala":"GUG","aviastartu":"TUP","aviatrafficcompany":"AVJ","avionexpress":"NVD","aviorairlines":"ROI","awesomecargo":"WIN","azalazerbaijanairlines":"AHY","azimuth":"AZO","azmanair":"AZM","azoresairlines":"RZO","azul":"AZU","azulconecta":"ACN","azurair":"AZV","azureaviation":"ALZ","bacityflyer":"CFE","badrairlines":"BDR","baeuroflyer":"EFW","bahamasair":"BHS","bambooairways":"BAV","bangkokairways":"BKP","baronaviation":"BVN","barrierair":"GBA","batikair":"BTK","batikairmalaysia":"MXD","beavia":"BJO","beesairline":"BES","beijingairlines":"BJN","belavia":"BRU","beond":"BYD","berniqairways":"BNL","berryaviation":"BYA","bhair":"BGH","bhutanairlines":"BTN","bidaircargo":"BRH","bimanbangladeshairlines":"BBC","bintercanarias":"IBB","bluebirdairways":"BBG","bluedartaviation":"BDA","bolivianadeaviacion":"BOV","braspressaircargo":"BPC","brazzaairlines":"AIA","breezeairways":"MXY","bridgesaircargo":"BRD","britishairways":"BAW","brommaairmaintenance":"CFL","budgetlines":"BGN","bulair":"BVL","bulgariaair":"LZB","buraqair":"BRQ","businesswings":"JMP","caboverdeairlines":"TCV","caicosexpressairways":"CXE","calcargoairlines":"ICL","callyair":"NIG","calmair":"CAV","camairco":"CRC","cambodiaairways":"KME","camexairlines":"CMS","canadiannorth":"AKT","canaryfly":"CNF","canroyalcanadianmountedpolice":"SST","capeair":"KAP","capitalairlines":"CBJ","cardigair":"CAD","cargoair":"CGF","cargojet":"CJT","cargolux":"CLX","cargoluxitalia":"ICV","caribbeanairlines":"BWA","cathaypacific":"CPA","caymanairways":"CAY","cebgo":"SRQ","cebupacific":"CEB","ceibaintercontinental":"CEL","cemair":"KEM","centralairlines":"HLF","centralmountainair":"GLR","centrumair":"MFX","chairairlines":"CSW","chalairaviation":"CLG","challengegroup":"CHG","chamwingsairlines":"SAW","chengduairlines":"UEA","chinaairlines":"CAL","chinacargoairlines":"CKK","chinaeasternairlines":"CES","chinaexpressairlines":"HXA","chinapostalairlines":"CYZ","chinasouthernairlines":"CSN","chinasoutherncargo":"CSG","chinaunitedairlines":"CUA","chongqingairlines":"CQN","chronoaviation":"MBK","cinnamonair":"CIN","citilink":"CTV","cmacgmaircargo":"CMA","colorfulguizhouairlines":"CGZ","commscope":"BJO","compassaircargo":"ADZ","condor":"CFG","contourairlines":"VTE","conviasa":"VCV","copaairlines":"CMP","copaairlinescolombia":"RPB","copenhagenairtaxi":"CAT","corendonairlines":"CAI","corendonairlineseurope":"CXI","corendondutchairlines":"CND","corporateair":"CPT","corsairinternational":"CRL","croatiaairlines":"CTN","croatianairforce":"HRZ","cronosairlines":"CRA","csaair":"IRO","csaczechairlines":"CSA","cubana":"CUB","cygnusair":"RGN","cyprusairways":"CYP","daalloairlines":"DAO","dailyair":"DAC","dalianairlines":"CCD","danaair":"DAN","danair":"DNA","dat":"DTR","deltaairlines":"DAL","dhlaeroexpreso":"DAE","dhlairuk":"DHK","dhldeguatemala":"JOS","dhlintlaviationme":"DHX","directflight":"DCT","discoverairlines":"OCN","dividiviair":"DVR","donghaiairlines":"EPA","drukair":"DRK","dubaiairwing":"DUB","eastarjet":"ESR","easternairlines":"EAL","easyfly":"EFY","easyjet":"EZY","easyjeteurope":"EJU","easyjetswitzerland":"EZS","eatleipzig":"BCS","ecargoairlines":"ERF","echoflight":"UNO","ecojet":"ECO","edelweissair":"EDW","egyptair":"MSR","egyptaircargo":"MSX","electraairways":"EAF","eleronaviationcompany":"VVA","emeraldairlines":"EAI","emeraldairlinesuk":"EAG","emirates":"UAE","empireairlines":"CFS","enterair":"ENT","estafetacargaaerea":"ESF","eswatiniair":"SZL","ethiopianairlines":"ETH","euflightsomalia":"IHO","euroatlanticairways":"MMZ","europeanaircharter":"BUC","europeancargo":"URO","evaair":"EVA","ewaair":"EWR","expressaircargo":"XRC","eznisairways":"EZA","farcargo":"SWN","fastjetzimbabwe":"FJW","fedexexpress":"FDX","felixairways":"FXX","fijiairways":"FJI","fijilink":"FJA","finistair":"FTR","firefly":"FFM","fitsair":"EXV","flairairlines":"FLE","fly91":"GOA","flyadeal":"FAD","flyallways":"EDR","flyangola":"FLA","flyarystan":"AYN","flybaghdad":"FBA","flybig":"FLG","flycaa":"DBP","flydubai":"FDB","flygabon":"ABS","flyjaya":"FHS","flyjinnah":"FJL","flyjordan":"FJR","flykhiva":"FKH","flylili":"LIL","flyme":"VQI","flynamibia":"WAA","flynamibiasafari":"WAA","flynas":"KNE","flyone":"FIA","flyonearmenia":"FIE","flyoneasia":"AUV","flyoneromania":"FOE","flyoya":"OYA","flypelican":"FRE","flypro":"PVV","flysafair":"SFR","flyyo":"DIR","freebirdairlines":"FHY","freebirdairlineseurope":"FHM","freedomairline":"FDT","freightrunnersexpress":"FRG","frenchbee":"FBU","frontierairlines":"FFT","frostair":"FRO","fujidreamairlines":"FDA","fuzhouairlines":"FZA","garudaindonesia":"GIA","georgianairlines":"IGT","georgianairways":"TGZ","geosky":"GEL","getjetairlines":"GJT","ghadamesair":"GMS","globalxairlines":"GXA","goltransportesaereos":"GLO","gotofly":"MAR","gpaviation":"GPX","grandchinaair":"GDC","greaterbayairlines":"HGB","gulfair":"GFA","gulfcaribbeancargo":"TSU","gxairlines":"CBG","hainanairlines":"CHH","hapaglloydcruises":"BJO","haveriekommando":"PCT","hayways":"HYY","hebeiairlines":"HBH","hebrideanairservices":"HBR","hellojets":"HLJ","helveticairways":"OAW","hestonairlines":"HST","himalayaairlines":"HIM","hinterlandaviation":"HND","hisky":"HYM","hiskyeurope":"HYS","hismajestykingmahavajiralongkorn":"VMS","hkexpress":"HKE","hokkaidoairsystem":"NTH","hongkongaircargo":"HKC","hongkongairlines":"CRK","hunnuair":"MML","hydroquebec":"HYD","iberiaexpress":"IBS","iberojet":"EVE","ibexairlines":"IBX","ibomair":"IAN","icelandair":"ICE","iflgroup":"IFL","iflyairlines":"RSY","ikar":"KAR","indigo":"IGO","indonesiaairasia":"AWQ","intercaribbeanairways":"IWY","iraero":"IAE","iranair":"IRA","iranairtour":"IRB","iranasemanairlines":"IRC","iraqiairways":"IAW","islesofscillyskybus":"IOS","israirairlines":"ISR","izhavia":"IZA","jair":"JLJ","jambojet":"JMA","janet":"WWW","japanaircommuter":"JAC","japanairlines":"JAL","japantransoceanair":"JTA","jazeeraairways":"JZR","jdlogisticsairlines":"JDL","jejuair":"JJA","jet2com":"EXS","jetblue":"JBU","jetflite":"JEF","jetsmart":"JAT","jetsmartargentina":"JES","jetsmartcolombia":"JEC","jetsmartperu":"JAP","jetstarairways":"JST","jetstarjapan":"JJP","jettime":"JTD","jiangxiair":"CJX","jiangxicargoairlines":"CBJ","jinair":"JNA","jonair":"JON","jordanaviation":"JAV","joyair":"JOY","jsx":"JSX","jumpair":"JUP","juneyaoairlines":"DKH","justiceprisoneralientransportationsystem":"DOJ","kalittaair":"CKS","kalittachartersii":"KII","kamair":"KMF","kamakaair":"KMK","kargoxpress":"KXP","karunairlines":"KRU","kenyaairways":"KQA","keylimeair":"LYM","kfaerospace":"KFA","kingfisherairservices":"BEZ","kishair":"KIS","kmileair":"KMI","koreanairexclusive":"KAL","kunmingairlines":"KNA","kustbevakningen":"KBV","kuwaitairways":"KAC","lacompagnie":"DJT","lacostena":"NIS","ladelineasaereasdelestado":"LDE","lamlinhasaereasdemocambique":"LAM","lanexangairwaysinternational":"LXW","lanhsa":"LNH","laoairlines":"LAO","laoskyway":"LLL","laserairlines":"LER","latamairlinesbrasil":"TAM","latamairlineschile":"LAN","latamairlinescolombia":"ARE","latamairlinesecuador":"LNE","latamairlinesperu":"LPE","latamcargo":"LCO","latamcargobrasil":"LTG","leavaviation":"NGN","level":"LVL","liat20":"GAO","libyanairlines":"LAA","libyanwings":"LWA","lift":"GBB","linkairways":"FCX","linkpng":"ANG","lionair":"LNI","lodyssey":"VAA","loganair":"LOG","longjiangairlines":"SNG","loongair":"CDC","lotpolishairlines":"LOT","luckyair":"LKE","lufthansacargo":"GEC","lufthansacityairlines":"LHX","lufttransport":"LTR","lumiwings":"LWI","luxaviationafrica":"EXD","luxaviationfrance":"LEA","maerskaircargo":"SRR","maerskaircargouk":"MUK","magnicharters":"GMT","mahanair":"IRM","malawiairlines":"MWI","malaysiaairlines":"MAS","maldivian":"DQA","maltamedair":"MMO","mandarinairlines":"MDA","mannyadanarponairlines":"MYP","mantaair":"MAV","marabu":"MBU","marmongroup":"EJM","maroombaairlines":"MRB","martinair":"MPH","masaircargo":"MAA","mauritaniaairlines":"MAI","mavigokairlines":"MGH","maximusair":"MXM","meamiddleeastairlines":"MEA","medskyairways":"MNS","merajairlines":"MRJ","mexicanadeaviacion":"MXA","miatmongolianairlines":"MGL","minresair":"SND","mngairlines":"MNB","moalemaviation":"AMA","modernlogistics":"MWM","morningstarairexpress":"MAL","mountainaircargo":"MTN","mscair":"LSI","myanmarairwaysinternational":"MMA","myanmarnationalairlines":"UBA","myfreighter":"MFX","myindoairlines":"MYU","namair":"LKN","nationalairlines":"NCR","nationaljetexpress":"JTE","nauruairlines":"RON","neos":"NOS","nepalairlines":"RNA","nesmaairlines":"NMA","newcentralairservice":"CUK","nexusairlines":"NEX","nileair":"NIA","nipponcargoairlines":"NCA","nokair":"NOK","nolinoraviation":"NRL","nordica":"NDA","nordstar":"TYA","nordwindairlines":"NWS","norlandair":"FNA","norseatlanticairways":"NBT","norseatlanticuk":"UBT","northernaircargo":"NAC","northwesterncargo":"CNW","norwegian":"NOZ","nouvelair":"LBT","novoair":"NVQ","nyxair":"NYX","okayairways":"OKA","olympicair":"OAL","omanair":"OMA","omniairinternational":"OAE","oneair":"HGO","orientalairbridge":"ORC","originair":"OGN","owgopbnolinor":"NRL","pacificcoastalairlines":"PCO","pakistaninternationalairlines":"PIA","palairlines":"PVL","palexpress":"GAP","paranair":"AZP","parataair":"PTA","pascanaviation":"PSC","passionair":"DIG","pattayaairways":"PTW","peachaviation":"APJ","pecotoxair":"PXA","pegasusairlines":"PGT","pelairaviation":"PFY","pelitaair":"PAS","peoples":"PEV","philippineairlines":"PAL","philippinesairasia":"APG","pivotairlines":"GGN","plusultralineasaereas":"PUE","pngair":"TOK","pobeda":"PBD","polaraircargo":"PAC","polishgovernment":"PLF","porterairlines":"POE","posteaircargo":"MSA","pradhaanairexpress":"PRX","prattwhitneycanada":"PWC","precisionair":"PRF","princevilleair":"KDS","privatewings":"PWF","privilegestyle":"PVG","proflightzambia":"PFZ","pyramidsairlines":"PYR","qanotsharqairlines":"QNT","qantaslink":"QLK","qatarairways":"QTR","qazaqair":"QAZ","qeshmair":"QSM","qingdaoairlines":"QDA","queenbilqisairways":"QBA","quikjetairlines":"FQA","rafavia":"MTL","raindounitedservices":"RBF","ranoair":"RAN","rayaairways":"RMY","redair":"REA","redseaairlines":"RSX","redwingsairlines":"RWZ","reliableairlines":"HPN","republicofbulgaria":"BGF","rexairlines":"RXA","rgablackstoneairlines":"RGM","rheinneckarair":"MHV","riyadhair":"RXI","romcargoairlines":"RCR","rossiyaairlines":"SDM","royalairmaroc":"RAM","royalairmarocexpress":"RXP","royalairphilippines":"RYL","royalbruneiairlines":"RBA","royaljet":"ROJ","royaljordanian":"RJA","ruiliairlines":"RLH","rusline":"RLU","rutacaairlines":"RUC","rwandair":"RWD","ryanair":"RYR","ryukyuaircommuter":"RAC","s7airlines":"SBI","sahaairlines":"IRZ","salamair":"OMS","samoaairways":"PAO","sansa":"LRS","sap":"BJO","sarpa":"SRP","sataairacores":"SAT","satena":"NSE","saudia":"SVA","scatairlines":"VSV","scoot":"TGW","searca":"SRC","senorair":"SEN","sepehranairlines":"SHI","sevenair":"RVP","severstalaircompany":"SSF","sfairlines":"CSS","shandongairlines":"CDG","shanghaiairlines":"CSH","shenzhenairlines":"CSZ","shirakavia":"SHS","sichuanairlines":"CSC","sichuanlogisticsindustrycompany":"ABB","sierrapacificairlines":"SPA","silkavia":"USA","silkwayairlines":"AZQ","silkwaywestairlines":"AZG","silveraircz":"SLD","singaporeairlines":"SIA","skaneaviation":"FRO","skippersaviation":"SKP","skyairline":"SKU","skyairlineperu":"SKX","skyalps":"SWU","skyangkorairlines":"SWM","skybusjetcargo":"HVY","skyexpress":"SEH","skyguard":"SGA","skyhighdominicana":"SHH","skyleasecargo":"KYE","skylineexpress":"UTN","skylinkexpress":"SLQ","skymarkairlines":"SKY","skytaxi":"IGA","skyupairlines":"SQP","skyupeurope":"SEU","skywestcharter":"SCW","slovakgovernmentflightservice":"SSG","smartavia":"AUL","smartlynxaustralia":"SKP","smartwings":"TVS","smartwingshungary":"TVL","smartwingspoland":"TVP","smartwingsslovakia":"TVQ","solaair":"NYX","solaseedair":"SNJ","solinair":"SOP","solitair":"CGS","solomonairlines":"SOL","somonair":"SMR","soundsair":"SDA","southafricanairways":"SAA","southernairwaysexpress":"FDY","southwestairlines":"SWA","southwindairlines":"STW","spicejet":"SEJ","springairlines":"CQH","springjapan":"SJO","sprintair":"SRN","srilankanairlines":"ALK","sriwijayaair":"SJY","starairindia":"SDG","stareastairlines":"SEK","starflyer":"SFJ","starluxairlines":"SJX","starperu":"SRU","stbarthcommuter":"SBU","stephensinc":"BJO","stewartislandflights":"RKU","stpairways":"STP","sudanairways":"SUD","summitair":"SUT","sunairofscandinavia":"SUS","sunclassairlines":"VKG","suncountryairlines":"SCX","sundair":"SDR","sunexpress":"SXS","sunlightair":"RLB","sunphuquocairways":"SPQ","sunriseairways":"KSZ","suparnaairlines":"YZR","superairjet":"SJV","surinamairways":"SLM","swiftair":"SWT","swiftairhellas":"MDF","syrianair":"SYR","taaglinhasaereasdeangola":"DTA","tabanair":"TBN","tabcargo":"BOL","taccolombia":"TCB","tailwindairlines":"TWI","talofaairways":"XXX","tamep":"EPT","tapairportugal":"TAP","taraerolineas":"LCT","tarom":"ROT","tasmancargoairlines":"TMN","tcsworldtravel":"AWC","teamglobalexpress":"TFX","terraavia":"TVR","texelairaustralasia":"TNZ","tezjetairlines":"TEZ","thaiairasia":"AIQ","thaiairasiax":"TAX","thaiairways":"THA","thailionair":"TLM","thaivietjetair":"TVJ","tianjiaoairlines":"NMG","tianjinaircargo":"CTJ","tianjinairlines":"GCR","tibetairlines":"TBA","tigerairtaiwan":"TTW","titanairways":"AWC","tokiair":"TOK","tradeair":"TDR","tradewindaviation":"GPD","transaircongo":"TSG","transamaeroexpressdelecuador":"RTM","transavia":"TRA","transaviaexportcargoairline":"TXC","transaviafrance":"TVF","transnusa":"TNU","triganaairservice":"TGN","trinityairways":"TWB","tsaradia":"TDS","tuiairlinesnetherlands":"TFL","tuiairwaysuk":"TOM","tuifly":"TUI","tuiflybelgium":"JAF","tuiflynordic":"BLX","tunisair":"TAR","tunisairexpress":"TUX","turkishairlines":"THY","turkmenistanairlines":"TUA","turpialairlines":"VTU","twayair":"TWB","twinjet":"TJT","ugandaairlines":"UGD","ukraineinternationalairlines":"AUI","ulendoairlink":"NYS","uniair":"UIA","universalair":"UVL","uniworldaircargo":"UCG","upsairlines":"UPS","urairlines":"UBD","uralairlines":"SVR","urumqiair":"CUH","usajetairlines":"JUS","usbanglaairlines":"UBG","utair":"UTA","uvtaero":"UVT","uzbekistanairways":"UZB","valairprivatejets":"VVV","vareshairlines":"VRH","vasco":"VFC","venezolana":"VNE","vensecarinternacional":"VEC","vietjetair":"VJC","vietnamairlines":"HVN","vietravelairlines":"VAG","virginatlantic":"VIR","virginaustralia":"VOZ","virginaustraliaregional":"VOZ","visionair":"SQY","viva":"VIV","volaris":"VOI","volariscostarica":"VOC","volariselsalvador":"VOS","volotea":"VOE","voyageurairways":"VAL","vueling":"VLG","vulkanair":"VKA","westair":"CHB","westairinc":"PCM","westatlanticuk":"NPT","westernair":"WST","westernglobalairlines":"WGN","westjetencore":"WEN","wideroe":"WIF","wigginsairways":"WIG","winair":"WIA","windroseairlines":"WRC","windwardexpress":"WEA","wingopanama":"WWP","wingsair":"WON","wizzair":"WZZ","wizzairuk":"WUK","world2fly":"WFL","world2flyportugal":"WPT","worldatlanticairlines":"WAL","worldcargoairlines":"WCM","xiamenairlines":"CXA","yakutiaairlines":"SYL","yamalairlines":"LLM","yemenia":"IYE","ytocargoairlines":"HYT","zagrosairlines":"IZG","zair":"EZR","zambiaairways":"AZB","zimexaviation":"IMX","zimexaviationaustria":"AZD","zipair":"TZP"};
var AITM_CALLSIGNS = {"AAB":"AIR BELGIUM","AAE":"EUROVIKING","AAG":"APRICOT","AAH":"ALOHA","AAL":"AMERICAN","AAR":"ASIANA","AAT":"AFRICA AIRLINES","AAW":"AFRIQIYAH","AAY":"ALLEGIANT","ABB":"AIR BELGIUM","ABD":"ATLANTA","ABL":"AIR BUSAN","ABP":"BAIR","ABQ":"AIRBLUE","ABR":"CONTRACT","ABS":"AFRIJET","ABT":"BENWAYS","ABV":"CARGOBLUE","ABX":"ABEX","ABY":"ARABIA","ACI":"AIRCALIN","ACL":"ADMIRE","ACN":"AZUL CONECTA","ACP":"ASTRAL CARGO","ADO":"AIR DO","ADY":"NAWRAS","ADZ":"MIGRATOR","AEA":"EUROPA","AEG":"AIREST CARGO","AER":"ACE AIR","AEZ":"AEROITALIA","AFE":"AIRFAST","AFG":"ARIANA","AFL":"AEROFLOT","AFW":"BLACKSTAR","AGR":"ACE EUROPE","AHK":"AIR HONG KONG","AHX":"AMAKUSA AIR","AHY":"AZAL","AIA":"AMELIA","AIC":"AIR INDIA","AIE":"INUIT","AIH":"QUANTUM SKY","AIP":"ALPINE AIR","AIQ":"THAI ASIA","AIZ":"ARKIA","AJB":"AMJET","AJI":"AMERISTAR","AJK":"BAMBI","AJT":"AMERIJET","AJX":"AIR JAPAN","AKJ":"AKASA AIR","AKL":"AIR KIRIBATI","AKN":"ALKAN AIR","AKS":"AKEL","AKT":"ARCTIC","AKX":"ALL NIPPON","ALE":"ALLIANCE","ALK":"SRI LANKAN","ALV":"AEROPOSTAL","ALZ":"AZURE","AMA":"MOALEM","AMF":"AMFLIGHT","AMP":"ATSA","AMQ":"AMEX","AMT":"AIR MOUNTAIN","AMU":"AIR MACAU","AMV":"AMC AIRLINES","AMW":"ARMENIA","AMZ":"VARIOUS","ANA":"ALL NIPPON","ANG":"NIUGINI","ANK":"AERO NOMAD","ANO":"TOPEND","ANS":"AEROANDES","ANT":"AIR NORTH","APC":"AIRPAC","APF":"AMAPOLA","APG":"COOL RED","APJ":"AIR PEACH","APK":"PEACE BIRD","APP":"ALPAVIA","APZ":"AIR PREMIA","ARA":"ARIK AIR","ARE":"LAN COLOMBIA","ARG":"ARGENTINA","ARU":"ARUBA","ARY":"ARMENIAN AIR FORCE","ASA":"ALASKA","ASL":"AIR SERBIA","ASV":"AIR SEOUL","ATC":"TANZANIA","ATG":"MOLDCARGO","ATN":"AIR TRANSPORT","ATV":"AVANTI AIR","ATX":"AIRSWIFT","AUI":"UKRAINE INTERNATIONAL","AUK":"AURIC SERVICES","AUL":"ARCHANGELSK AIR","AUR":"AYLINE","AUV":"ASIA UNION","AVA":"AVIANCA","AVJ":"ATOMIC","AVN":"AIR VAN","AVR":"AVAEXPRESS","AWA":"CAPELLA","AWC":"ZAP","AWG":"ANIMA WINGS","AWK":"AIRWORK","AWQ":"WAGON AIR","AXB":"EXPRESS INDIA","AXE":"GALILEO","AXK":"EXPRESS JET","AXL":"ANGUILLA","AXM":"RED CAP","AXV":"AVA","AXY":"LEGEND","AYG":"ASTRA","AYN":"ARYSTAN","AZB":"AIR ZAMBIA","AZD":"MAILMAN","AZG":"SILK WEST","AZM":"AZMAN","AZN":"AMAZONAS","AZO":"AZIMUTH-DON","AZP":"GUARANI","AZQ":"SILK LINE","AZU":"AZUL","AZV":"AZUR AIR","AZW":"AIR ZIMBABWE","BAR":"BARAKAH","BAV":"BAMBOO","BAW":"SPEEDBIRD","BBC":"BANGLADESH","BBG":"CANDIA BIRD","BCS":"POSTMAN","BDA":"BLUE DART","BDR":"BADR AIR","BES":"SKYBEES","BEZ":"SEA BREEZE","BFF":"AIR BAFFIN","BGA":"BELOUGA","BGF":"BULGARIAN","BGH":"BALKAN HOLIDAYS","BGN":"SKYBUDDY","BHS":"BAHAMAS","BJN":"AIR JINGHUA","BJO":"ICEAIR","BKP":"BANGKOK AIR","BLX":"BLUESCAN","BNL":"BERNIQ AIRWAYS","BOL":"BOL","BOT":"BOTSWANA","BOV":"BOLIVIANA","BOX":"GERMAN CARGO","BPC":"BRASPRESS","BPS":"BASE","BRD":"BRIDGES","BRH":"BRIGHTSTAR","BRO":"BROADSWORD","BRQ":"BURAQAIR","BRU":"BELARUS AVIA","BSC":"BIG SHOT","BTI":"AIRBALTIC","BTK":"BATIK","BTN":"BHUTAN AIR","BUC":"EUROCHARTER","BVL":"BULGARY","BVN":"SHOW-ME","BWA":"CARIBBEAN AIRLINES","BYA":"BERRY","BYD":"BEOND","CAD":"CARDIG AIR","CAI":"CORENDON","CAL":"DYNASTY","CAO":"AIRCHINA FREIGHT","CAT":"AIRCAT","CAV":"CALM AIR","CAY":"CAYMAN","CBG":"GREEN CITY","CBJ":"CAPITAL JET","CCA":"AIR CHINA","CCD":"XIANGJIAN","CCM":"CORSICA","CDC":"LOONG AIR","CDG":"SHANDONG","CEB":"CEBU AIR","CEL":"CEIBA LINE","CES":"CHINA EASTERN","CEY":"CENTURYFLIGHT","CFE":"FLYER","CFG":"CONDOR","CFL":"CALIBRATION","CFS":"EMPIRE AIR","CGF":"CLEVER","CGH":"WELKIN","CGN":"CHANG AN","CGS":"GLOBAL SOUTH","CGZ":"COLORFUL","CHB":"WEST CHINA","CHG":"CHALLENGE","CHH":"HAINAN","CIN":"CINNAMON","CJT":"CARGOJET","CJX":"AIR CRANE","CKK":"CARGO KING","CKS":"CONNIE","CLG":"CHALLAIR","CLX":"CARGOLUX","CMA":"FRENCH CARGO","CMP":"COPA","CMS":"CAMEX","CND":"DUTCH CORENDON","CNF":"CANARY","CNW":"TANG","CPA":"CATHAY","CPT":"AIR SPUR","CQH":"AIR SPRING","CQN":"CHONG QING","CRA":"CRONOS","CRC":"CAMAIRCO","CRK":"BAUHINIA","CRL":"CORSAIR","CRQ":"CREE","CSA":"CSA","CSB":"CARGO SOUTH","CSC":"SICHUAN","CSG":"SOUTHERN CARGO","CSH":"SHANGHAI AIR","CSN":"CHINA SOUTHERN","CSS":"SHUN FENG","CSW":"EIGER","CSZ":"SHENZHEN AIR","CTJ":"TIANJIN CARGO","CTN":"CROATIA","CTV":"SUPERGREEN","CUA":"LIANHANG","CUB":"CUBANA","CUH":"LOULAN","CUK":"CHUOH AIR","CVA":"CHATHAM","CWM":"AIR MARSHALLS","CXA":"XIAMEN AIR","CXE":"CAICOS","CXI":"TOURISTIC","CYP":"CYPRUS","CYZ":"CHINA POST","DAC":"DAILY","DAE":"YELLOW","DAH":"AIR ALGERIE","DAL":"DELTA","DAN":"DANACO","DAO":"DAALLO AIRLINES","DBP":"AFRICAN","DCT":"AIRTASK","DHK":"WORLD EXPRESS","DHX":"DILMUN","DIG":"PASSION","DIR":"DIREKT WINGS","DJT":"DREAMJET","DJU":"AIR DJIB","DKH":"AIR JUNEYAO","DLA":"DOLOMITI","DNA":"JUST US","DOJ":"JUSTICE","DQA":"SKY SURFER","DRC":"LEO PARC","DRK":"ROYAL BHUTAN","DRU":"MIRNY","DTA":"ANGOLA","DTL":"AERO DILI","DTR":"DANISH","DUB":"DUBAI","DVR":"DIVI AIR","DWI":"DOMINICAN","EAF":"ELECTRA","EAG":"GREENSTONE","EAI":"GEMSTONE","EAL":"EASTERN","ECO":"ECOJET","EDR":"BIRDVIEW","EDW":"EDELWEISS","EFW":"GRIFFIN","EFY":"EASYFLY","EIN":"SHAMROCK","EJM":"JET SPEED","EJU":"ALPINE","ENT":"ENTERAIR","EOK":"AEROHANGUK","EPA":"DONGHAI AIR","EPE":"SWIFT CARGO","EPT":"TAMEP","ERF":"GULLIVER","ESF":"ESTAFETA","ESR":"EASTAR","ETH":"ETHIOPIAN","ETR":"ESTELAR","EUK":"GREEN FLIGHT","EVA":"EVA","EVE":"EVELOP","EWR":"MAYOTTE AIR","EXD":"PLATINUM EXEC","EXS":"CHANNEX","EXV":"EXPOAVIA","EZA":"EZNIS","EZR":"EASYWAY","EZS":"TOPSWISS","EZY":"EASY","FAD":"ADEAL","FBA":"IRAQ EXPRESS","FBU":"FRENCH BEE","FCX":"FLY CORP","FDA":"FUJI DREAM","FDB":"SKYDUBAI","FDT":"FREEDOM EAGLE","FDX":"FEDEX","FDY":"FRIENDLY","FFM":"FIREFLY","FFT":"FRONTIER FLIGHT","FGB":"KITEBIRD","FHM":"EUROBIRD","FHS":"SURYA","FHY":"FREEBIRD AIR","FIA":"FIA AIRLINES","FIE":"ARMRIDER","FJA":"LINK FIJI","FJI":"FIJI","FJL":"OKAAB","FJR":"SOLITAIRE AIR","FJW":"ZIMBIRD","FKH":"FLY KHIVA","FLE":"FLAIR","FLG":"KRIS","FLI":"FAROELINE","FNA":"NORLAND","FOE":"FIRST EAGLE","FPO":"FRENCH POST","FQA":"QUIK LIFT","FRE":"PELICAN","FRG":"FREIGHT RUNNERS","FRH":"ACE FREIGHT","FRO":"FROST","FSK":"AFRICAN SKY","FTR":"FINISTAIR","FWI":"FRENCH WEST","FXX":"FELIX","FZA":"STRAIT AIR","GAL":"ERRANTE","GAO":"SOAR","GAP":"AIRPHIL","GBA":"BARRIER","GBB":"GLOBE","GCR":"BO HAI","GDC":"GRAND CHINA","GEC":"LUFTHANSA CARGO","GEL":"SKY GEORGIA","GFA":"GULF AIR","GGN":"GREAT NORTH","GHN":"AIR GHANA","GIA":"INDONESIA","GJT":"GETJET","GLG":"GALAPAGOS","GLO":"GOL TRANSPORTE","GLR":"GLACIER","GMS":"GHADAMES","GMT":"GRUPOMONTERREY","GOA":"GOAN","GPD":"GOODSPEED","GPX":"IVORY","GRL":"GREENLAND","GTI":"GIANT","GTV":"GAVIOTA","GUG":"AVIATECA","GXA":"GEMINI","HAT":"SKY RUNNER","HBH":"HEBEI AIR","HBR":"HEBRIDEAN","HFA":"AIR HAIFA","HGB":"GREATER BAY","HGO":"HAMPTON","HIM":"HIMALAYA","HKC":"MASCOT","HKE":"HONGKONG SHUTTLE","HLF":"HOMELAND","HLJ":"HELLOJETS","HND":"HINTERLAND","HPN":"HARPOON","HRZ":"CROATIAN AIRFORCE","HST":"HESTON","HVL":"AERLINK","HVN":"VIETNAM","HVY":"LIFT PERU","HXA":"CHINA EXPRESS","HYA":"ALHAYA","HYD":"HYDRO","HYM":"SKY MOLDOVA","HYS":"SKY EUROPE","HYT":"QUICK AIR","HYY":"HAYWAYS","IAE":"IRAERO","IAN":"IBOM","IAW":"IRAQI","IBB":"BINTER","IBS":"IBEREXPRES","IBX":"IBEX","ICE":"ICEAIR","ICL":"CAL","ICV":"CARGOLUX ITALIA","IFL":"EIFEL","IGA":"IGUANA","IGO":"IFLY","IGT":"SKY IKA","IHO":"SEFEAS","IMX":"ZIMEX","IOS":"SCILLONIA","IRA":"IRANAIR","IRB":"IRAN AIRTOUR","IRC":"ASEMAN","IRM":"MAHAN AIR","IRO":"IRON AIR","IRZ":"SAHA","ISR":"ISRAIR","IWY":"ISLANDWAYS","IYE":"YEMENI","IZA":"IZHAVIA","IZG":"ZAGROS","JAC":"COMMUTER","JAF":"BEAUTY","JAG":"TULPAR","JAL":"JAPANAIR","JAP":"RED SMART","JAT":"ROCKSMART","JAV":"JORDAN AVIATION","JBU":"JETBLUE","JDL":"JINGDONG","JEC":"JETROCK","JEF":"JETFLITE","JES":"SMARTBIRD","JJA":"JEJUAIR","JJP":"ORANGE LINER","JLJ":"J-AIR","JMA":"CHUI","JMP":"JUMP RUN","JMS":"SKY AVIATION","JNA":"JIN AIR","JON":"JONAIR","JOY":"JOY AIR","JST":"JETSTAR","JSX":"BIGSTRIPE","JTA":"JAI OCEAN","JTD":"JETTIME","JTE":"JETEX","JUP":"JUMP AIR","JUS":"JET USA","JYH":"TRANS JADE","JZR":"JAZEERA","KAC":"KUWAITI","KAL":"KOREANAIR","KAP":"CAIR","KAR":"KRASJET","KBV":"SWECOAST","KDS":"KALEO","KEM":"CEMAIR","KES":"KARIBEES","KFA":"FLIGHTCRAFT","KHV":"CAMBODIA AIR","KII":"DRAGSTER","KIS":"KISH AIR","KME":"GIANT IBIS","KMF":"KAMGAR","KMI":"KAY-MILE AIR","KMK":"KAMAKA","KNA":"KUNMING AIR","KNE":"FLYNAS","KNG":"MANAS BIRD","KON":"AIR CONNECT","KOR":"AIR KORYO","KQA":"KENYA","KRE":"AEROSUCRE","KRU":"KARUN","KSZ":"SUNRISE","KTC":"RED NAGA","KWX":"KAY DUB","KXP":"XPRESS KARGO","KYE":"SKY CUBE","KZR":"ASTANALINE","LAA":"LIBYAN","LAM":"MOZAMBIQUE","LAN":"LAN CHILE","LAO":"LAO","LAV":"ALBASTAR","LBR":"NORTHLIGHT","LBT":"NOUVELAIR","LCO":"LAN CARGO","LCT":"CONEXION LINK","LDE":"LADE","LEA":"UNIJET","LER":"LASER","LHA":"AIR CANTON","LHX":"CITYAIR","LIL":"LILIES","LKE":"LUCKY AIR","LKN":"NAMAIR","LLL":"LAVIE","LLM":"YAMAL","LLR":"ALLIED","LMU":"ALMASRIA","LNE":"AEROLANE","LNI":"LION INTER","LNK":"LINK","LOG":"LOGAN","LOT":"LOT","LPE":"LANPERU","LRC":"LACSA","LRS":"SANSA","LSI":"POSEIDON","LSJ":"LIAISON","LTG":"TAMCARGO","LTR":"LUFTTRANSPORT","LVL":"DALI","LWA":"LIBYAN WINGS","LWI":"LUMI","LXW":"LANEXANG","LYM":"KEY LIME","LZB":"FLYING BULGARIA","MAA":"MAS CARGA","MAC":"ARABIA MAROC","MAI":"MAURITANIA AIRLINES","MAL":"MORNINGSTAR","MAR":"HELLASMED","MAS":"MALAYSIAN","MAU":"MAURITIUS","MAV":"SEA WING","MBK":"MATBLACK","MBU":"MARABU","MDA":"MANDARIN","MDF":"MED-FREIGHT","MEA":"CEDAR JET","MFX":"WHITEBIRD","MGE":"MAGELLAN","MGH":"MAVI","MGL":"MONGOL AIR","MHV":"SNOWCAP","MKT":"AIRNESIA","MLA":"MILE-AIR","MMA":"MYANMAR","MMD":"MERMAID","MML":"TRANS MONGOLIA","MMO":"MALIT","MMZ":"EUROATLANTIC","MNB":"BLACK SEA","MNE":"MONTENEGRO","MNG":"AERO MONGOLIA","MNS":"MEDSKY","MPH":"MARTINAIR","MRB":"MAROOMBA","MRJ":"MERAJ","MSA":"MISTRAL WINGS","MSC":"AIR CAIRO","MSM":"AEROMAS EXPRESS","MSR":"EGYPTAIR","MSX":"EGYPTAIR CARGO","MTL":"MITAVIA","MTN":"MOUNTAIN","MUK":"BLUE STAR","MUS":"ADELPHI","MWG":"MASWINGS","MWI":"MALAWIAN","MWM":"MODERNAIR","MXA":"MEXICANA","MXD":"MALINDO","MXM":"CARGO MAX","MXY":"MOXY","MYP":"MANN ROYAL","MYU":"INDO","NAC":"YUKON","NBT":"LONGSHIP","NCA":"NIPPON CARGO","NCR":"NATIONAL CARGO","NDA":"NORDICA AIR","NEX":"CONNECT","NGN":"YODA","NGT":"NIKA","NIA":"NILE BIRD","NIG":"AEROLINE","NIS":"NICA","NMA":"NESMA","NMG":"TIANJIAO AIR","NOK":"NOK AIR","NOS":"MOONFLOWER","NOZ":"NORDIC","NPT":"NEPTUNE","NRL":"NOLINOR","NSE":"SATENA","NSO":"SOSA","NTH":"NORTH AIR","NTR":"NATIREVA","NVD":"NORDVIND","NVQ":"NOVO AIR","NWS":"NORDLAND","NYS":"NYASA","NYX":"NYX AIR","OAE":"OMNI-EXPRESS","OAL":"OLYMPIC","OAW":"HELVETIC","OCN":"OCEAN","OGN":"ORIGIN","OKA":"OKAYJET","OMA":"OMAN AIR","OMS":"MAZOON","ORC":"ORIENTAL BRIDGE","OTC":"AIR TRAVEL","OYA":"OYAA","PAC":"POLAR","PAL":"PHILIPPINE","PAO":"POLYNESIAN","PAS":"PELITA","PBD":"POBEDA","PCM":"PAC VALLEY","PCO":"PASCO","PCT":"POLLUTION CONTROL","PEV":"PEOPLES","PFY":"AMBULANCE","PFZ":"PROFLIGHT-ZAMBIA","PGT":"SUNTURK","PIA":"PAKISTAN","PLF":"POLISH AIRFORCE","PNX":"SPINNER","POE":"PORTER AIR","PRF":"PRECISION AIR","PRX":"PRADHAAN","PSC":"PASCAN","PST":"TURISMO REGIONAL","PTA":"PARATA AIR","PTW":"PATTAYA","PUE":"SPANISH","PVG":"PRIVILEGE","PVL":"PROVINCIAL","PVV":"SUNDAY","PWC":"PRATT","PWF":"PRIVATE WINGS","PXA":"PECOTOX","PYR":"PYRAMIDS","QAZ":"SAMRUK","QBA":"BILQIS","QCL":"ACLA","QDA":"SKY LEGEND","QLK":"Q LINK","QNT":"QANOT SHARQ","QSM":"QESHM AIR","QTR":"QATARI","RAC":"RYUKYU","RAM":"ROYALAIR MAROC","RAN":"RANO AIR","RAR":"RAROTONGA","RBA":"BRUNEI","RBF":"RAINDO","RBG":"AIR ARABIA","RCR":"ROMCARGO","REA":"RED DOMINICANA","REU":"REUNION","RFD":"RAFILHER","RGM":"BLACK STONE","RGN":"CYGNUS AIR","RJA":"JORDANIAN","RJR":"MELITA","RKU":"RAKIURA","RLB":"SUNLIGHT","RLH":"SENDI","RLU":"RUSLINE AIR","RLY":"LOYAUTE","RMX":"AIR MASTER","RMY":"RAYA EXPRESS","RNA":"ROYAL NEPAL","ROI":"AVIOR","ROJ":"ROYALJET","RON":"AIR NAURU","ROT":"TAROM","ROU":"ROUGE","RPB":"AEROREPUBLICA","RSX":"RED SEA","RSY":"RUSSIAN SKY","RTL":"ROYAL BIRD","RTM":"AERO TRANSAM","RUC":"RUTACA","RUN":"CARGO TURK","RVP":"SEVAIR","RWD":"RWANDAIR","RWZ":"AIR RED","RXA":"REX","RXI":"RIYADH AIR","RXP":"ROYALAIR MAROC","RYL":"DOUBLEGOLD","RYR":"RYANAIR","RZO":"AIR AZORES","SAA":"SPRINGBOK","SAT":"SATA","SAW":"SHAMWING","SBI":"SIBERIAN","SBU":"BLACK FIN","SCW":"CHARTER WEST","SCX":"SUN COUNTRY","SDA":"SOUNDSAIR","SDG":"HI STAR","SDM":"ROSSIYA","SDR":"SUNDAIR","SEH":"AIR CRETE","SEJ":"SPICEJET","SEK":"EAST RIDER","SEN":"SENIOR AIR","SEU":"SKY MALTA","SEY":"SEYCHELLES","SFJ":"STARFLYER","SFR":"SAFAIR","SFZ":"SKYFORCE","SGA":"SKY GUARD","SHH":"SKY DOMENICANA","SHI":"SHIRAZI","SHS":"SHIRAK","SHU":"AURORA","SIA":"SINGAPORE","SIF":"AIR SIAL","SJO":"JEY SPRING","SJV":"PROSPER","SJX":"STARWALKER","SJY":"SRIWIJAYA","SKK":"ASKY AIRLINE","SKP":"SKIPPYS","SKU":"AEROSKY","SKX":"SKY PERU","SKY":"SKYMARK","SLD":"SILVERLINE","SLM":"SURINAM","SLQ":"SKYLINK","SMR":"SOMON AIR","SNC":"NIGHT CARGO","SND":"SNOWBIRD","SNG":"SNOW EAGLE","SNJ":"NEWSKY","SOL":"SOLOMON","SOP":"SOLINAIR","SPA":"SIERRA PACIFIC","SPM":"SAINT-PIERRE","SPQ":"SUN LUX","SQP":"SKYUP","SQY":"SKY TIRAS","SRC":"SEARCA","SRN":"SPRINTAIR","SRP":"SARPA","SRQ":"BLUE JAY","SRR":"WHITE STAR","SRU":"STAR-UP","SRY":"STINGRAY","SSF":"SEVERSTAL","SSG":"SLOVAK GOVERNMENT","SST":"STETSON","STP":"SAOTOME AIRWAYS","STW":"MOON STAR","SUD":"SUDANAIR","SUS":"SUNSCAN","SUT":"SUMMIT","SVA":"SAUDIA","SVR":"SVERDLOVSK AIR","SWA":"SOUTHWEST","SWM":"SKY ANGKOR","SWN":"AIR SWEDEN","SWT":"SWIFT","SWU":"SKYALPS","SXS":"SUNEXPRESS","SYL":"AIR YAKUTIA","SYR":"SYRIANAIR","SZL":"ESWATINI","SZN":"SENSA","TAA":"AERO COSTA","TAH":"AIR ANKA","TAI":"TACA","TAM":"TAM","TAP":"AIR PORTUGAL","TAR":"TUNAIR","TAX":"EXPRESS WING","TAY":"QUALITY","TBA":"TIBET AIR","TBN":"TABAN AIR","TBZ":"ATALAR","TCB":"AEREO COLOMBIA","TCV":"CABOVERDE","TDR":"TRADEAIR","TDS":"TSARADIA","TEZ":"TEZJET","TFL":"ORANGE","TFX":"TEXEL","TGN":"TRIGANA","TGW":"SCOOTER","TGZ":"TAMAZI","THA":"THAI","THT":"TAHITI AIRLINES","THY":"TURKISH","TJT":"TWINJET","TKJ":"ANATOLIA","TLM":"MENTARI","TMG":"TRILINES","TMN":"TASMAN","TNO":"AEROUNION","TNU":"TRANSNUSA","TNZ":"TEXEL","TOA":"TETIAROA","TOK":"BALUS","TOM":"TOMJET","TPA":"TAMPA","TPC":"AIRCAL","TRA":"TRANSAVIA","TSC":"AIR TRANSAT","TSG":"TRANS-AIR-CONGO","TSU":"TRANSAUTO","TTW":"SMART CAT","TUA":"TURKMENISTAN","TUI":"TUI JET","TUP":"TUPOLEVAIR","TUX":"TUNEXPRESS","TVF":"FRANCE SOLEIL","TVJ":"THAIVIET JET","TVL":"TRAVEL SERVICE","TVP":"JET TRAVEL","TVQ":"SLOVAKTRAVEL","TVR":"TERRAAVIA","TVS":"SKYTRAVEL","TWB":"TWAY AIR","TWI":"TAILWIND","TXC":"TRANSEXPORT","TXG":"CARGO BOX","TYA":"TAIMYR","TZP":"ZIPPY","UAE":"EMIRATES","UBA":"UNIONAIR","UBD":"URAIR","UBG":"BANGLA STAR","UBT":"LONGBOAT","UCG":"UNIWORLD","UEA":"UNITED EAGLE","UGD":"CRESTED","UIA":"GLORY","ULC":"ALBI","UNO":"ECHO","UPS":"UPS","URO":"EURO","USA":"SILK","USC":"UNISKY","UTA":"UTAIR","UTN":"UT-UKRAINE","UTY":"UNITY","UVL":"UNIVERSALAIR","UVT":"TAT-JET","UZB":"UZBEK","UZS":"SAMARKAND","VAA":"EUROVAN","VAG":"VIETRAVEL AIR","VAL":"VOYAGEUR","VAS":"ATRAN","VBW":"BURKINA","VCV":"CONVIASA","VEC":"VENCAR","VFC":"VASCO AIR","VIR":"VIRGIN","VIV":"AEROENLACES","VJC":"VIETJETAIR","VKA":"VULKAN AIR","VKG":"VIKING","VLG":"VUELING","VMS":"VICTOR MIKE","VNE":"VENEZOLANA","VOC":"COSTA RICAN","VOE":"VOLOTEA","VOI":"VOLARIS","VOS":"JETSAL","VOZ":"VELOCITY","VQI":"VILLA AIR","VRE":"COTE D'IVOIRE","VRH":"SKY VICTOR","VSV":"VLASTA","VTA":"AIR TAHITI","VTE":"VOLUNTEER","VTM":"AERONAVES TSM","VTU":"TURPIAL","VVA":"LOAD SHARK","VVV":"VALAIRJET","VXP":"AVELO","WAA":"WESTAIR WINGS","WAF":"FLAMENCO","WAL":"DORAL","WCM":"ASIA CARGO","WEN":"ENCORE","WFL":"BLUE WORLD","WGN":"WESTERN GLOBAL","WIA":"WINDWARD","WIF":"WIDEROE","WIG":"WIGGINS AIRWAYS","WIN":"TEME AIRLINES","WON":"WINGS ABADI","WPT":"NEW BLUE","WRC":"WIND ROSE","WSN":"WINGSPAN","WST":"WESTERN AIR","WUK":"WIZZ GO","WWP":"WINGO PANAMA","WWW":"JANET","WZZ":"WIZZAIR","XAX":"XANADU","XRC":"TUNISIA CARGO","XSN":"SANTANA","XXX":"NONE","YZR":"YANGTZE RIVER"};
// ── airport: flight schedule (double-click), menu (right-click), Airport Data, Rotation Map ──
// type as in a timetable: "Airbus A321-200neoLR" -> "A321-200neoLR", "Boeing 777-300ER" -> "B777-300ER";
// makers whose models are only numbers keep their name ("Fokker 100", "ATR 72-600")
function aitmShortType(t) {
  t = String(t || '').trim();
  var m = /^(Airbus|Boeing|McDonnell[ -]Douglas|Douglas|De Havilland(?: Canada)?|Embraer|Bombardier|Canadair|Lockheed|Sukhoi|COMAC|Antonov|Ilyushin|Tupolev|Gulfstream|Dassault|Cessna|Beechcraft|Pilatus|Learjet|Hawker|Vickers|Convair|BAe|British Aerospace|Dornier|Aerospatiale|Mitsubishi)\s+(.+)$/i.exec(t);
  if (!m) return t;
  if (/^boeing$/i.test(m[1]) && /^\d/.test(m[2])) return 'B' + m[2];
  if (/^[A-Z]/i.test(m[2]) && /\d/.test(m[2])) return m[2];
  return t;
}
// callsign: the installed livery's atc_airline (what the simulator says), else the most common one of your
// installed liveries of that airline, else the AIG flight plan database
function aitmNormName(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
// from your installed liveries: ICAO code -> callsign (atc_airline) and airline name of the AIG title -> ICAO code
function aitmAirlineMaps() {
  var cnt = {}, nmc = {};
  var vote = function (o, k, v) { (o[k] = o[k] || {})[v] = (o[k][v] || 0) + 1; };
  (aitm.fleet || []).forEach(function (e) {
    var c = String(e.airline || '').toUpperCase(); if (!/^[A-Z0-9]{3,4}$/.test(c)) return;
    var s = String(e.atcAirline || '').trim().toUpperCase(); if (s) vote(cnt, c, s);
    var m = /^AIGAIM_(.+)$/.exec(e.title || ''), mk = m && AITM_MAKERS.exec(' ' + m[1]);
    if (mk) vote(nmc, aitmNormName((' ' + m[1]).slice(0, mk.index)), c);
  });
  var top = function (o) { var out = {}; Object.keys(o).forEach(function (k) { var b = '', n = 0; for (var v in o[k]) if (o[k][v] > n) { n = o[k][v]; b = v; } out[k] = b; }); return out; };
  var byName = top(nmc);
  if (typeof AIRLINE_NAMES !== 'undefined') for (var c in AIRLINE_NAMES) { var k = aitmNormName(AIRLINE_NAMES[c]); if (k && !byName[k] && !AITM_AL_BY_NAME[k]) byName[k] = c; }
  return { cs: top(cnt), nm: byName };
}
function aitmCodeByName(name, maps) {
  var k = aitmNormName(name); if (!k) return '';
  var c = (maps && maps.nm[k]) || AITM_AL_BY_NAME[k]; if (c) return c;
  var m = /^([A-Z]{3})\s/.exec(String(name));                    // "SAS Scandinavian Airlines"
  if (m && (AITM_CALLSIGNS[m[1]] || (typeof AIRLINE_NAMES !== 'undefined' && AIRLINE_NAMES[m[1]]))) return m[1];
  return '';
}
function aitmCallsignOf(code, a, maps) {
  var inst = a ? aitmInstalled(a.title) : null;
  if (inst && inst.atcAirline) return String(inst.atcAirline).trim().toUpperCase();
  return (code && ((maps && maps.cs[code]) || AITM_CALLSIGNS[code])) || '';
}
function aitmApSchedule(icao) {
  icao = String(icao || '').toUpperCase();
  var ap = aitmAp(icao), loc = aitm.tmode !== 'utc', off = loc ? aitmOffset(icao) : null, offMin = off != null ? Math.round(off * 60) : 0;
  var maps = aitmAirlineMaps(), dep = {}, arr = {}, perWeek = { dep: 0, arr: 0 };
  var hhmm = function (m) { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  aitm.plans.forEach(function (p, pi) {
    var P = AITM_CODEC.periodOf(p.period)[1], n = p.legs.length, a = aitmAcByN(p.ac);
    var inf = a ? aitmAcAirlineInfo(a) : { code: '', name: '' };
    var code = inf.code || aitmCodeByName(inf.name, maps) || (aitm.kind !== 'airport' ? aitm.code : '') || '';
    var type = a ? aitmShortType(aitmAcTypeName(a) || a.hint || a.title) : 'AC#' + p.ac;
    var cs = aitmCallsignOf(code, a, maps);
    var add = function (map, l, t, other, kind) {
      var byReg = String(l.fr || 'F').toUpperCase() === 'R';
      var fn = String(l.fnum == null ? '' : l.fnum).replace(/^0+(?=\d)/, '');
      var sign = byReg ? String(p.reg || '') : cs;
      var key = [code, sign, fn, type, other].join('|');          // one line per destination / origin
      var r = map[key] = map[key] || { code: code, cs: sign, byReg: byReg, fn: fn, type: type, other: other, days: [0, 0, 0, 0, 0, 0, 0], via: {}, regs: {} };
      var m = ((t + offMin) % P + P) % P, dd = [];
      if (P < 10080) dd = [0, 1, 2, 3, 4, 5, 6];
      else dd = [(Math.floor(m / 1440) % 7 + 6) % 7];                  // TTools day 0 = Sunday; shown Monday first
      var v = r.via[other] = r.via[other] || { days: {}, times: {} };
      dd.forEach(function (d) { r.days[d] = 1; v.days[d] = 1; });
      v.times[hhmm(m)] = 1; r.regs[p.reg] = 1;
      perWeek[kind] += 10080 / P;
    };
    p.legs.forEach(function (l, j) {
      var from = p.legs[(j - 1 + n) % n].to;
      if (from === icao && l.dep != null) add(dep, l, l.dep, l.to, 'dep');
      if (l.to === icao && l.arr != null) add(arr, l, l.arr, from, 'arr');
    });
  });
  var sortRows = function (map) {
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (x, y) {
      var cx = x.code || '\uffff', cy = y.code || '\uffff';
      return (cx < cy ? -1 : cx > cy ? 1 : 0) || ((parseInt(x.fn, 10) || 0) - (parseInt(y.fn, 10) || 0)) || x.type.localeCompare(y.type) || String(x.other).localeCompare(String(y.other));
    });
  };
  var D = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  var th = 'position:sticky;top:0;background:var(--surf2);color:var(--txt3);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:6px 6px;text-align:left;white-space:nowrap;';
  var dayTh = D.map(function (d) { return '<th style="' + th + 'text-align:center;width:24px;padding:6px 2px;">' + d + '</th>'; }).join('');
  var dayTds = function (r) { return r.days.map(function (x) { return '<td style="text-align:center;color:#fff;font-weight:700;padding:4px 2px;">' + (x ? '✕' : '') + '</td>'; }).join(''); };
  var tip = function (r, dir) {
    return Object.keys(r.via).sort().map(function (k) {
      var o = aitmAp(k), v = r.via[k], ds = Object.keys(v.days).map(Number).sort();
      return (dir === 'dep' ? '→ ' : '← ') + k + (o && (o.city || o.name) ? ' (' + (o.city || o.name) + ')' : '') + ' · '
        + (ds.length === 7 ? 'daily' : ds.map(function (d) { return D[d]; }).join(' ')) + ' · ' + Object.keys(v.times).sort().join(', ') + (loc ? ' local' : ' UTC');
    }).join('\n') + '\n' + Object.keys(r.regs).join(', ') + (r.byReg ? ' · callsign = registration' : '');
  };
  var td = 'padding:4px 6px;white-space:nowrap;';
  var cells = {
    code: function (r) { return '<td style="' + td + 'font-family:monospace;font-weight:700;color:#fff;">' + aitmEsc(r.code || '—') + '</td>'; },
    cs: function (r) { return '<td style="' + td + 'color:var(--txt2);">' + aitmEsc(r.cs || '—') + '</td>'; },
    fn: function (r) { return '<td style="' + td + 'font-family:monospace;color:#fff;">' + aitmEsc(r.fn) + '</td>'; },
    type: function (r) { return '<td style="' + td + 'color:var(--txt2);">' + aitmEsc(r.type) + '</td>'; },
    other: function (r) { var o = aitmAp(r.other); return '<td style="' + td + '"><span style="font-family:monospace;font-weight:700;color:#fff;">' + aitmEsc(r.other || '—') + '</span>'
      + (o && (o.city || o.name) ? ' <span style="color:var(--txt3);">' + aitmEsc(o.city || o.name) + '</span>' : '') + '</td>'; }
  };
  var table = function (rows, dir) {
    // both tables: weekdays · aircraft · airline · callsign · flight · destination (departures) / origin (arrivals)
    var head = dayTh + '<th style="' + th + '">Aircraft</th><th style="' + th + '">Airline</th><th style="' + th + '">Callsign</th><th style="' + th + '">Flight</th><th style="' + th + '">' + (dir === 'dep' ? 'To' : 'From') + '</th>';
    var body = rows.map(function (r, i) {
      var c = dayTds(r) + cells.type(r) + cells.code(r) + cells.cs(r) + cells.fn(r) + cells.other(r);
      return '<tr title="' + aitmEsc(tip(r, dir)) + '" style="border-top:1px solid var(--bdr);' + (i % 2 ? 'background:rgba(255,255,255,.025);' : '') + '">' + c + '</tr>';
    }).join('') || '<tr><td colspan="12" style="padding:14px;color:var(--txt3);">None</td></tr>';
    return '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  };
  var fmtN = function (x) { return Math.round(x * 10) / 10; };
  var col = function (dir, rows) {
    return '<div style="min-width:0;display:flex;flex-direction:column;">'
      + '<div style="font-size:12px;font-weight:700;color:#fff;margin-bottom:6px;">' + (dir === 'dep' ? 'Departures' : 'Arrivals')
      + ' <span style="font-weight:400;color:var(--txt3);">· ' + rows.length + ' flight' + (rows.length === 1 ? '' : 's') + ' · ' + fmtN(perWeek[dir]) + ' per week</span></div>'
      + '<div style="max-height:64vh;overflow:auto;border:1px solid var(--bdr);border-radius:8px;">' + table(rows, dir) + '</div></div>';
  };
  var sign = '<span style="display:inline-block;vertical-align:middle;background:#0a0a0a;border-radius:3px;padding:2px;margin-right:10px;"><span style="display:inline-block;border:2px solid #f7c600;border-radius:2px;color:#f7c600;font:700 15px/1 \'Arial Narrow\',\'Roboto Condensed\',Arial,sans-serif;letter-spacing:.1em;padding:3px 7px 2px;">' + aitmEsc(icao) + '</span></span>';
  aitmModal(sign + aitmEsc(ap ? (ap.city || ap.name || icao) : icao) + (ap && ap.name && ap.city && ap.name !== ap.city ? ' <span style="font-weight:400;color:var(--txt3);font-size:12px;">' + aitmEsc(ap.name) + '</span>' : ''),
    '<div style="font-size:11px;color:var(--txt3);margin:-4px 0 10px;">Weekdays ' + (loc ? 'in local time (UTC' + aitmFmtOff(off) + (aitm.tmode === 'eusummer' ? ', EU summer' : '') + ')' : 'in UTC') + ' — switch with UTC / Local above. Point at a line for times and registrations.</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">' + col('dep', sortRows(dep)) + col('arr', sortRows(arr)) + '</div>',
    [['Airport Data', function () { aitmCloseModal(); aitmAirportData(icao); }, true], ['Rotation Map ↗', function () { aitmRotationMap(icao); }, true]], 'xl');
}
// right-click on an airport
function aitmApMenu(icao, x, y) {
  var m = document.getElementById('aitm-menu'); if (m) m.remove();
  m = document.createElement('div'); m.id = 'aitm-menu';
  m.style.cssText = 'position:fixed;z-index:10001;left:' + Math.min(x, window.innerWidth - 230) + 'px;top:' + Math.min(y, window.innerHeight - 170) + 'px;background:var(--surf);border:1px solid var(--bdr2);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.6);min-width:210px;padding:4px;';
  var items = [['sched', 'Flight schedule'], ['data', 'Airport Data'], ['repl', 'Replace airport…'], ['rm', 'Open in Rotation Map ↗']];
  m.innerHTML = '<div style="font-size:10px;color:var(--txt3);padding:4px 8px;text-transform:uppercase;letter-spacing:.06em;font-family:monospace;">' + aitmEsc(icao) + '</div>'
    + items.map(function (it) { return '<div class="aitm-mi" data-a="' + it[0] + '" style="padding:6px 10px;border-radius:5px;cursor:pointer;font-size:12px;color:var(--txt);">' + it[1] + '</div>'; }).join('');
  m.addEventListener('click', function (e) {
    var it = e.target.closest('.aitm-mi'); if (!it) return;
    m.remove();
    var a = it.dataset.a;
    if (a === 'sched') aitmApSchedule(icao);
    else if (a === 'data') aitmAirportData(icao);
    else if (a === 'repl') aitmMoveAirports(icao);
    else aitmRotationMap(icao);
  });
  document.body.appendChild(m);
  setTimeout(function () { document.addEventListener('mousedown', function h(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', h); } }); }, 0);
}
// the Airport Base Data window of the Data tab; an airport that is not in the database opens as "+ New" with what is known
function aitmAirportData(icao) {
  if (typeof openApEditor !== 'function') return;
  openApEditor();
  var known = typeof schedByCode !== 'undefined' && schedByCode[icao];
  if (known) { apEdSelectAp(icao); return; }
  apEdAddNew();
  var x = aitm.apx && aitm.apx[icao];
  var set = function (k, v) { var el = document.getElementById('ap-ed-new-' + k); if (el && v != null && v !== '') el.value = v; };
  set('icao', icao);
  if (x) { set('lat', x.lat); set('lon', x.lon); }
}
// called by the Airport Base Data window after saving or closing
function aitmAfterApEdit() {
  var v = document.getElementById('view-aitm');
  if (v && v.style.display !== 'none' && aitm.plans && aitm.plans.length) { aitmRenderHeader(); aitmRenderLegs(); aitmRenderAirports(); }
}
// Rotation Map (runs on this PC, http://127.0.0.1:47815): open the airport, or the airline of this flight plan.
// #ap=ICAO and #a=<airline id> are what Rotation Map reads when its page loads; the id of an airline from traffic BGL
// files is "B:" + the operator name in lower case (Air France -> "B:air france"). Rotation Map 4.11 and later also
// find it by #file (the traffic BGL), #find (ICAO code) and #name. The changing "t" makes an open tab load the link.
var AITM_RM_URL = 'http://127.0.0.1:47815/';
function aitmRotationMap(icao) {
  var h, enc = encodeURIComponent;
  if (icao || aitm.kind === 'airport') h = '#ap=' + enc(icao || aitm.apIcao || '');
  else {
    var file = /\.bgl$/i.test(aitm.source || '') ? aitm.source : (aitm.outName || '');
    var nm = String(aitm.name || '').trim();
    h = '#' + (nm ? 'a=' + enc('B:' + nm.toLowerCase()) + '&' : '') + 'file=' + enc(file) + '&find=' + enc(aitm.code || '') + '&name=' + enc(nm);
  }
  var w = window.open(AITM_RM_URL + '?from=msfs-manager&t=' + Date.now() + h, 'rotationmap');
  if (w) { try { w.focus(); } catch (e) {} }
  else aitmToast('The browser blocked the new tab — allow pop-ups for this page.', true);
}

// ── Sort by aircraft size, Check flightplans, Compile only after sorting ──
// wingspan in metres by ICAO type (approximate) - only for aircraft whose aircraft.cfg was not read (not installed)
var AITM_WINGSPAN = {
  A225: 88.4, A124: 73.3, A388: 79.8, B748: 68.4, B744: 64.4, B74R: 59.6, B743: 59.6, B742: 59.6, VC25: 59.6 /* VC-25A = 747-200 */, B741: 59.6, B74S: 59.6, BLCF: 64.4,
  B778: 71.8, B779: 71.8, B77W: 64.8, B77L: 64.8, B773: 60.9, B772: 60.9, A35K: 64.8, A359: 64.8, A346: 63.5, A345: 63.5,
  A343: 60.3, A342: 60.3, A339: 64.0, A338: 64.0, A333: 60.3, A332: 60.3, A337: 60.3, B789: 60.1, B788: 60.1, B78X: 60.1,
  C5M: 67.9, C5: 67.9, IL96: 60.1, IL86: 48.1, IL76: 50.5, IL62: 43.2, C17: 51.8, MD11: 51.7, DC10: 50.4, L101: 47.3,
  B764: 51.9, B763: 47.6, B762: 47.6, A306: 44.8, A30B: 44.8, A3ST: 44.8, A310: 43.9, DC86: 45.2, DC87: 45.2, DC85: 43.4, DC8: 43.4,
  B703: 44.4, B701: 39.9, B720: 39.9, K35R: 39.9, VC10: 44.6, A400: 42.4, C130: 40.4, C30J: 40.4, AN12: 38.0, T154: 37.6,
  B753: 38.1, B752: 38.1, CONI: 37.6, L049: 37.6, DC7: 38.9, DC6: 35.8, DC4: 35.8, IL18: 37.4, COMT: 35.0,
  A321: 35.8, A21N: 35.8, A320: 35.8, A20N: 35.8, A319: 35.8, A19N: 35.8, A318: 34.1, C919: 35.8, BCS3: 35.1, BCS1: 35.1, E295: 35.1,
  B39M: 35.9, B38M: 35.9, B37M: 35.9, B3XM: 35.9, B739: 35.8, B738: 35.8, B737: 35.8, B736: 34.3, B735: 28.9, B734: 28.9, B733: 28.9,
  B732: 28.4, B731: 28.4, CRVL: 34.3, YK42: 34.9, E290: 33.7, B722: 32.9, B721: 32.9, MD90: 32.9, MD88: 32.9, MD87: 32.9, MD83: 32.9,
  MD82: 32.9, MD81: 32.9, MD80: 32.9, CV44: 32.1, TRID: 29.9, F50: 29.0, F27: 29.0, DC3: 29.0, T134: 29.0, AN26: 29.2, AN24: 29.2,
  E190: 28.7, E195: 28.7, E75L: 28.6, DH8D: 28.4, BA11: 28.5, DC93: 28.5, DC9: 28.5, B712: 28.4, V814: 28.6, F100: 28.1, F70: 28.1,
  SU95: 27.8, DH8C: 27.4, AT76: 27.1, AT75: 27.1, AT72: 27.1, CRJX: 26.2, RJ1H: 26.3, RJ85: 26.3, RJ70: 26.3, B463: 26.3, B462: 26.3,
  B461: 26.3, FA8X: 26.3, FA7X: 26.2, E170: 26.0, E175: 26.0, DH8A: 25.9, DH8B: 25.9, CONC: 25.6, F28: 25.1, CRJ9: 24.9, SB20: 24.8,
  AT45: 24.6, AT43: 24.6, GLF4: 23.7, CRJ7: 23.2, C680: 22.0, C68A: 22.0, SF34: 21.4, CRJ2: 21.2, CRJ1: 21.2, D328: 21.0, E145: 20.0,
  E135: 20.0, DHC6: 19.8, CL60: 19.6, F2TH: 19.3, JS41: 18.3, B350: 17.7, B190: 17.7, PC24: 17.0, C560: 16.3, PC12: 16.3, E55P: 16.2,
  C208: 15.9, BN2P: 14.9, LJ45: 14.6, GLF5: 28.5, GLF6: 30.4, GLEX: 28.7, GL7T: 31.7
};
// size of an AC# entry: the real wingspan of its ICAO type; wing_span of aircraft.cfg only when the type is unknown -
// AI models carry unusable values there (AIG A321 78 ft, AIG B77W 164 ft, IVAO B742/DC10/MD11/B721 all 50.8 ft)
function aitmAcSize(a) {
  var e = aitmInstalled(a.title);
  // a military / government version named in the title or ui_type wins over the cfg type ("FAIB B742 USAF", ui_type "Boeing VC-25A")
  var mil = ''; [a.title, a.hint, e && e.uiType, e && e.title].some(function (x) { var u = String(x || '').toUpperCase(); return AITM_MIL_TYPES.some(function (r) { if (r[0].test(u)) { mil = r[1]; return true; } return false; }); });
  var cands = [mil, e && e.icaoType, e && e.sig, aitmAcSig(a), aitmTypeSig(a.hint), aitmTypeSig(a.title)], t = '', m = 0;
  for (var i = 0; i < cands.length && !m; i++) {
    var c = String(cands[i] || '').toUpperCase(); if (!c) continue;
    if (!t) t = c;
    if (AITM_WINGSPAN[c]) { t = c; m = AITM_WINGSPAN[c]; }
    else { var c2 = aitmTypeSig(c); if (AITM_WINGSPAN[c2]) { t = c2; m = AITM_WINGSPAN[c2]; } }   // e.g. icao_type "VC25"
  }
  if (m) return { ft: m * 3.2808, src: 'type', type: t };
  var w = (e && e.wing) || a.wing;
  return w ? { ft: w, src: 'cfg', type: t } : { ft: 0, src: '', type: t };
}
// "sorted" = Sort by aircraft size was pressed and the aircraft list has not changed since
// Sort is due again after any change of the flight plans, not only of the aircraft (button red until sorted again)
function aitmSortSig() { return aitmPlanSig() + '#' + aitm.ac.map(function (a) { return a.n + '=' + a.title; }).join('|') + '#' + aitm.plans.map(function (p) { return p.ac; }).join(','); }
function aitmSortedOk() { return !!aitm.plans.length && !!aitm.sortSig && aitm.sortSig === aitmSortSig(); }
// largest aircraft = AC#1 …; the flight plans follow their aircraft. Returns the aircraft with their sizes.
function aitmSortCore() {
  var sized = aitm.ac.map(function (a, i) { return { a: a, i: i, s: aitmAcSize(a) }; });
  sized.sort(function (x, y) { return (y.s.ft - x.s.ft) || (x.i - y.i); });
  var map = {};
  sized.forEach(function (x, k) { map[x.a.n] = k + 1; });
  aitm.plans.forEach(function (p) { if (map[p.ac]) p.ac = map[p.ac]; });
  aitm.ac = sized.map(function (x, k) { x.a.n = k + 1; return x.a; });
  aitm.plans = aitm.plans.map(function (p, i) { return { p: p, i: i }; })
    .sort(function (x, y) { return (x.p.ac - y.p.ac) || (x.i - y.i); }).map(function (x) { return x.p; });
  aitm.sel = []; aitm.selAnchor = null;
  aitm.sortSig = aitmSortSig();
  return sized;
}
// Save txt writes what Compile writes: same aircraft merged into one AC#, flight plans without legs and aircraft
// without flights left out, sorted by size (AC#1 = largest), flight plans in the order of their aircraft.
// Done on the plan itself, so the screen shows what is in the file. A Check / Compile that was green stays green
// (none of this changes what is flown).
function aitmMakeCompiled() {
  var wasChecked = aitmCheckedOk(), wasCompiled = aitmCompiledOk(), wasSorted = aitmSortedOk();
  var r = { merged: aitmConsolidateAc(), noLegs: [], unused: [], sorted: false };
  r.noLegs = aitm.plans.filter(function (p) { return !p.legs.length; });
  if (r.noLegs.length) aitm.plans = aitm.plans.filter(function (p) { return p.legs.length; });
  var use = {}; aitm.plans.forEach(function (p) { use[p.ac] = 1; });
  r.unused = aitm.ac.filter(function (a) { return !use[a.n]; });
  if (r.unused.length) aitm.ac = aitm.ac.filter(function (a) { return use[a.n]; });
  var before = aitm.ac.map(function (a) { return a.n + '=' + a.title; }).join('|') + '#' + aitm.plans.map(function (p) { return p.ac + p.reg; }).join('|');
  aitmSortCore();
  r.sorted = !wasSorted || before !== aitm.ac.map(function (a) { return a.n + '=' + a.title; }).join('|') + '#' + aitm.plans.map(function (p) { return p.ac + p.reg; }).join('|');
  if (wasChecked && !aitmCheck().errs.length) aitm.checkSig = aitmPlanSig();
  if (wasCompiled) aitm.compiledSig = aitmPlanSig() + '#' + aitmSortSig() + '#' + (aitm.outName || '');
  r.changed = r.merged.length || r.noLegs.length || r.unused.length || r.sorted;
  if (r.changed) { aitmSave(); aitmRenderAll(); }
  return r;
}
function aitmMakeCompiledMsg(r) {
  var t = [];
  if (r.sorted) t.push('sorted by size (AC#1 ' + (aitm.ac[0] ? aitm.ac[0].title : '') + ')');
  if (r.merged.length) t.push(r.merged.length + ' duplicate aircraft merged');
  if (r.unused.length) t.push(r.unused.length + ' aircraft without flights left out (' + r.unused.map(function (a) { return a.title; }).slice(0, 3).join(', ') + (r.unused.length > 3 ? ' …' : '') + ')');
  if (r.noLegs.length) t.push(r.noLegs.length + ' flight plan' + (r.noLegs.length === 1 ? '' : 's') + ' without legs left out');
  return t.join(' · ');
}
function aitmSortBySize() {
  if (!aitm.plans.length || !aitm.ac.length) { aitmToast('Load a flight plan first.', true); return; }
  var sized = aitmSortCore();
  aitmSave(); aitmRenderAll();
  var m = function (x) { return x.s.ft ? Math.round(x.s.ft / 3.2808 * 10) / 10 + ' m' : 'size unknown'; };
  var nCfg = sized.filter(function (x) { return x.s.src === 'cfg'; }).length, nUnk = sized.filter(function (x) { return !x.s.ft; }).length;
  var lbl = function (x) { return x.a.title + ' (' + (x.s.type ? x.s.type + ', ' : '') + m(x) + ')'; };
  aitmToast('Sorted by wingspan: AC#1 ' + lbl(sized[0]) + ' … AC#' + sized.length + ' ' + lbl(sized[sized.length - 1])
    + (nCfg ? ' · ' + nCfg + ' of unknown type: wingspan from aircraft.cfg' : '') + (nUnk ? ' · ' + nUnk + ' of unknown size placed last' : '') + ' — Compile is ready.', nUnk > 0);
}
// Check flightplans: errors, warnings (click one to select its flight plan in Legs), aircraft without flights
function aitmCheckPlans() {
  var merged = aitmConsolidateAc();
  if (merged.length) { aitmSave(); aitmRenderAll(); aitmToast('Merged: ' + aitmConsolidateMsg(merged) + '.'); }
  var c = aitmCheck(), nLegs = 0;
  aitm.checkErrs = c.errs.length;
  aitm.checkSig = c.errs.length || !aitm.plans.length ? '' : aitmPlanSig();
  aitmSave();
  aitm.plans.forEach(function (p) { nLegs += p.legs.length; });
  var row = function (it, col) {
    return '<div class="aitm-ck" data-pi="' + (it.pi == null ? '' : it.pi) + '" style="padding:4px 6px;border-bottom:1px solid var(--bdr);color:' + col + ';' + (it.pi == null ? '' : 'cursor:pointer;') + '"'
      + (it.pi == null ? '' : ' title="Click: select this flight plan in Legs"') + '>' + aitmEsc(it.t) + '</div>';
  };
  var errs = c.items.filter(function (x) { return x.lv === 'err'; }), warns = c.items.filter(function (x) { return x.lv === 'warn'; });
  var list = function (arr, col) { return arr.slice(0, 150).map(function (x) { return row(x, col); }).join('') + (arr.length > 150 ? '<div style="color:var(--txt3);padding:4px 6px;">… ' + (arr.length - 150) + ' more</div>' : ''); };
  var head = function (txt, col) { return '<div style="font-weight:700;color:' + col + ';margin:10px 0 4px;">' + txt + '</div>'; };
  var body = '<div style="font-size:12px;color:var(--txt2);">' + aitm.plans.length + ' flight plan' + (aitm.plans.length === 1 ? '' : 's') + ', ' + nLegs + ' legs, ' + aitm.ac.length + ' aircraft checked.</div>'
    + '<div id="aitm-ck-list" style="max-height:58vh;overflow:auto;font-size:12px;margin-top:4px;">'
    + (errs.length ? head(errs.length + ' error' + (errs.length === 1 ? '' : 's') + ' — cannot be flown / compiled', '#f85149') + list(errs, '#ffb4ab')
                   : '<div style="color:#3fb950;font-weight:700;margin:10px 0 4px;">✓ No errors — every flight plan can be flown.</div>')
    + (warns.length ? head(warns.length + ' warning' + (warns.length === 1 ? '' : 's'), '#f0b400') + list(warns, 'var(--txt2)') : '')
    + (c.unused.length ? head(c.unused.length + ' aircraft without flights', '#58a6ff')
        + '<div style="color:var(--txt2);padding:2px 6px 6px;line-height:1.6;">' + c.unused.map(function (a) { return 'AC#' + a.n + ' ' + aitmEsc(a.title); }).join('<br>')
        + '<div style="margin-top:6px;color:var(--txt3);">Remove them from this plan’s aircraft list? Your installed aircraft are not touched.</div></div>' : '')
    + '</div>';
  var btns = [];
  if (c.dups.length) {
    // identical rotations: delete the later copy of each (its aircraft goes too when it then flies nothing)
    var dropIdx = c.dups.map(function (x) { return x.drop; }).filter(function (v, k, arr) { return arr.indexOf(v) === k; });
    var names = dropIdx.map(function (i) { return aitm.plans[i].reg + ' (AC#' + aitm.plans[i].ac + ')'; });
    btns.push([dropIdx.length === 1 ? 'Delete the copy: ' + names[0] : 'Delete ' + dropIdx.length + ' copies (' + names.slice(0, 3).join(', ') + (names.length > 3 ? ' …' : '') + ')', function () {
      var r = aitmDeletePlans(dropIdx);
      aitmCheckPlans();
      aitmToast(r.plans.length + ' identical flight plan' + (r.plans.length === 1 ? '' : 's') + ' deleted' + (r.ac.length ? ' · aircraft removed: ' + r.ac.map(function (a) { return 'AC#' + a.n + ' ' + a.title; }).join(', ') : '') + '.');
    }, false, '#da3633']);
  }
  if (c.unused.length) btns.push(['Remove ' + c.unused.length + ' aircraft without flights', function () { aitmRemoveUnused(); aitmCheckPlans(); }, false, '#da3633']);
  var card = aitmModal('Check flightplans', body, btns, true);
  card.querySelectorAll('.aitm-ck[data-pi]').forEach(function (el) {
    if (el.dataset.pi === '') return;
    el.addEventListener('click', function () { aitmGoPlan(parseInt(el.dataset.pi, 10)); });
  });
}
function aitmGoPlan(pi) {
  aitmCloseModal();
  aitm.sel = [pi]; aitm.selAnchor = pi; aitmRenderLegs();
  var r = document.querySelector('#aitm-legs .aitm-pl[data-i="' + pi + '"]'); if (r) r.scrollIntoView({ block: 'center' });
}
function aitmRemoveUnused() {
  var use = {}; aitm.plans.forEach(function (p) { use[p.ac] = 1; });
  var gone = aitm.ac.filter(function (a) { return !use[a.n]; });
  if (!gone.length) return;
  var wasSorted = aitmSortedOk();
  aitm.ac = aitm.ac.filter(function (a) { return use[a.n]; });
  if (wasSorted) {                                   // keep it sorted: close the gaps in the numbers
    var map = {}; aitm.ac.forEach(function (a, k) { map[a.n] = k + 1; a.n = k + 1; });
    aitm.plans.forEach(function (p) { if (map[p.ac]) p.ac = map[p.ac]; });
    aitm.sortSig = aitmSortSig();
  }
  aitmSave(); aitmRenderAll();
  aitmToast(gone.length + ' aircraft without flights removed: ' + gone.map(function (a) { return a.title; }).join(', ') + '.');
}

// Update installed aircraft: Rotation Map (runs on this PC, reads every Community\*\SimObjects\Airplanes\*\aircraft.cfg)
// hands the list over - the page itself may not read *.cfg files without a folder dialog each time.
// silent: when the tab opens (only after it worked once, so Chrome does not ask unexpectedly).
var AITM_RM_INSTALLED = AITM_RM_URL + 'api/installed';
async function aitmFetchInstalled(fresh) {
  var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, fresh ? 90000 : 20000);
  try {
    var r = await fetch(AITM_RM_INSTALLED + (fresh ? '?fresh=1' : ''), { cache: 'no-store', signal: ctl.signal });
    if (r.status === 404) return { err: 'old' };
    if (!r.ok) return { err: 'http', code: r.status };
    return await r.json();
  } catch (e) { return { err: e && e.name === 'AbortError' ? 'timeout' : 'offline' }; }
  finally { clearTimeout(t); }
}
function aitmEntryFromRM(m) {
  var icaoType = String(m.type || '').toUpperCase();
  var kv = { icao_airline: m.icao || '', atc_parking_codes: m.codes || '' };
  var sig = (AITM_TYPES[icaoType] ? icaoType : '') || aitmTypeSig(m.uiType) || aitmTypeSig(m.title) || icaoType;
  return { title: m.title, model: m.model || '', texture: m.texture || '', uiType: m.uiType || '', uiVar: m.uiVar || '', atcAirline: m.atc || '',
           codes: m.codes || '', ptypes: m.ptypes || '', airline: aitmAirlineOf(kv, m.title), sig: sig, icaoType: icaoType,
           speed: Math.round(m.speed || 0), wing: m.wing || 0, folder: m.folder || '', src: /aig/i.test(m.pkg || '') ? 'AIG' : 'Own',
           root: m.pkg || '', rel: 'SimObjects/Airplanes/' + (m.folder || ''), viaRM: true };
}
// Chrome (from version 142) blocks background requests of a web site to programs on this PC unless the user allowed
// it ("Local Network Access"). A window the page opens is not blocked: Rotation Map 4.12.1 shows /msfs-bridge in a
// small window, reads the list there (same origin), hands it to this page with postMessage and closes the window.
// Must be called directly from the click (pop-up).
var AITM_RM_ORIGIN = AITM_RM_URL.replace(/\/$/, '');
function aitmBridgeInstalled(onWait) {
  var w = null;
  try { w = window.open(AITM_RM_URL + 'msfs-bridge?fresh=1&to=' + encodeURIComponent(location.origin), 'aitm-rm-bridge', 'popup,width=480,height=150,left=120,top=120'); } catch (e) {}
  if (!w) return Promise.resolve({ err: 'popup' });
  return new Promise(function (res) {
    var done = false, t0 = Date.now(), hinted = false;
    var fin = function (v) { if (done) return; done = true; window.removeEventListener('message', on); clearInterval(iv); res(v); };
    var on = function (e) {
      if (e.origin !== AITM_RM_ORIGIN || !e.data || e.data.type !== 'rm-installed') return;
      fin(e.data.error ? { err: 'bridge', msg: String(e.data.error) } : (e.data.data || { models: [] }));
    };
    window.addEventListener('message', on);
    var iv = setInterval(function () {
      var closed = true; try { closed = w.closed; } catch (e) {}
      if (closed) { setTimeout(function () { fin({ err: 'closed' }); }, 300); return; }   // a message may still be on its way
      if (!hinted && Date.now() - t0 > 8000) { hinted = true; if (onWait) onWait(); }
      if (Date.now() - t0 > 180000) { try { w.close(); } catch (e) {} fin({ err: 'timeout' }); }
    }, 400);
  });
}
// Chrome's permission for this page to reach programs on this PC ('granted' / 'prompt' / 'denied', '' = unknown).
// Only when it is granted does the page read the list in the background (also when the tab opens).
function aitmLnaState() {
  if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve('');
  return ['loopback-network', 'local-network-access', 'local-network'].reduce(function (p, n) {
    return p.then(function (st) { return st || navigator.permissions.query({ name: n }).then(function (r) { return r.state; }, function () { return ''; }); });
  }, Promise.resolve(''));
}
// opt.silent: tab opened (background request only, only once it has worked); opt.bridge: use the window
async function aitmUpdateInstalled(opt) {
  opt = opt || {};
  if (aitm._updating) return;
  var viaFetch = false; try { viaFetch = localStorage.getItem('aitm_rm_ok') === '1'; } catch (e) {}
  if (aitm._lna === 'granted') viaFetch = true;
  if (opt.silent) viaFetch = true; else if (opt.bridge) viaFetch = false;
  var btn = document.getElementById('aitm-upd-btn'), lbl = btn ? btn.textContent : '';
  // the window must open right away, still inside the click
  var job = viaFetch ? aitmFetchInstalled(true)
    : aitmBridgeInstalled(function () {
        aitmToast('Still waiting for Rotation Map … Look at the small Rotation Map window: “Reading your installed aircraft” = please wait; '
          + '“404 page not found” = your Rotation Map is older than 4.12.1; “This site can’t be reached” = Rotation Map is not running.', true);
      });
  aitm._updating = true;
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Reading …'; }
  if (!opt.silent) aitmToast('Reading your installed aircraft (through Rotation Map) …');
  var wasInst = {}; aitm.ac.forEach(function (a) { if (aitmInstalled(a.title)) wasInst[a.n] = 1; });
  var oldTitles = {}; aitm.fleet.forEach(function (e) { oldTitles[String(e.title).toLowerCase()] = 1; });
  var hadFleet = aitm.fleet.length > 0;
  var d = await job;
  aitm._updating = false;
  if (btn) { btn.disabled = false; btn.textContent = lbl; }
  if (d.err) {
    if (viaFetch && !opt.silent) { try { localStorage.removeItem('aitm_rm_ok'); } catch (e) {} }   // next time: through the window
    if (!opt.silent) aitmRmProblem(d.err, d.msg, viaFetch);
    return;
  }
  if (viaFetch) { try { localStorage.setItem('aitm_rm_ok', '1'); } catch (e) {} }
  var entries = (d.models || []).filter(function (m) { return m.title; }).map(aitmEntryFromRM);
  var by = {};
  entries.forEach(function (e) { var s = by[e.root] = by[e.root] || { dirs: {}, n: 0, src: e.src }; s.dirs[e.folder] = 1; s.n++; });
  aitm.fleet = entries;
  aitm.sources = Object.keys(by).sort().map(function (k) { return { name: k, src: by[k].src, cfg: Object.keys(by[k].dirs).length, liveries: by[k].n, at: Date.now(), via: 'Rotation Map' }; });
  await aitmKvSet('fleetCache', { at: Date.now(), list: aitm.fleet, sources: aitm.sources, meta: aitm.fleetMeta || {} });
  aitmFleetIndex(); aitmRenderAll();
  var lost = aitm.ac.filter(function (a) { return wasInst[a.n] && !aitmInstalled(a.title); });
  var missing = aitm.ac.filter(function (a) { return !aitmInstalled(a.title); });
  var addedL = hadFleet ? entries.filter(function (e) { return !oldTitles[String(e.title).toLowerCase()]; }) : [], added = addedL.length;
  aitm._lastRead = { root: 'Rotation Map', at: Date.now(), liveries: entries.length, added: added, lost: lost.map(function (a) { return { n: a.n, title: a.title }; }) };
  if (opt.silent && !lost.length) return;
  aitmToast('✓ Installed aircraft updated: ' + entries.length + ' liveries in ' + aitm.sources.length + ' package' + (aitm.sources.length === 1 ? '' : 's')
    + (added ? ' · ' + added + ' new: ' + addedL.slice(0, 4).map(function (e) { return e.title; }).join(', ') + (added > 4 ? ' …' : '') : hadFleet ? ' · no new titles' : '')
    + (missing.length ? ' · not installed (red): ' + missing.map(function (a) { return 'AC#' + a.n + ' ' + a.title; }).join(', ') : ''), missing.length > 0);
}
function aitmRmProblem(err, msg, wasFetch) {
  var not412 = 'Your Rotation Map is older than 4.12.1 — that version hands the installed aircraft over to this page. Replace RotationMap.exe with 4.12.1, start it, and press the button again.';
  var notRun = 'start <b>RotationMap.exe</b> (globe icon next to the clock) and press the button again.';
  var txt = err === 'old' ? not412
    : err === 'popup' ? 'Chrome blocked the small Rotation Map window. Allow pop-ups for this page (icon at the right end of the address bar: “Always allow pop-ups”) and press the button again.'
    : err === 'bridge' ? 'Rotation Map could not read your installed aircraft: ' + aitmEsc(msg || '') + '<br>Check the Community folders in Rotation Map’s settings.'
    : err === 'closed' ? 'The Rotation Map window closed before it handed over the list.<br>• It said <b>“404 page not found”</b>: ' + not412
        + '<br>• It said <b>“This site can’t be reached”</b>: Rotation Map is not running — ' + notRun
    : err === 'timeout' ? 'Rotation Map took more than ' + (wasFetch ? '90' : '180') + ' seconds. Press the button again.'
    : 'Rotation Map does not answer: ' + notRun
        + (wasFetch ? '<br><span style="color:var(--txt3);">“Try again” opens a small Rotation Map window that hands the list over — Chrome blocks this page’s background requests to programs on your PC.</span>' : '');
  aitmModal('Update installed aircraft', '<div style="font-size:12px;color:var(--txt2);line-height:1.7;">' + txt + '</div>',
    [['Try again', function () { aitmCloseModal(); aitmUpdateInstalled({ bridge: true }); }], ['Read a folder by hand…', function () { aitmCloseModal(); aitmReadAircraftFolder(); }, true]]);
}

// ── Check flightplans → Sort by aircraft size → Compile: red until done, green when done; Compile grey until both
// are done, then blue, green after compiling. A change to the plans or aircraft makes the steps due again.
function aitmHash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + '.' + s.length; }
// content of the plans, independent of AC# numbers and plan order (sorting keeps a check valid)
function aitmPlanSig() {
  var byN = {}; aitm.ac.forEach(function (a) { byN[a.n] = a.title + '/' + (a.speed || 0); });
  return aitmHash(aitm.plans.map(function (p) {
    return JSON.stringify([byN[p.ac] || '#' + p.ac, p.reg, p.pct, p.period, p.rules, p.legs.map(function (l) { return [l.dep, l.arr, l.alt, l.fr, l.fnum, l.to, l.tng ? 1 : 0]; })]);
  }).sort().join('\n') + '|' + aitm.ac.map(function (a) { return a.title; }).sort().join('|')
    + '|' + aitmUsedAirports().map(function (c) { var x = aitmAp(c); return c + (x ? ':' + x.lat + ',' + x.lon : '?'); }).join(','));
}
// Save txt: the three files as they would be written; green while they match what was last saved (or opened)
function aitmTxtContent() {
  return ['//FSXDAYS=False\n' + aitm.plans.map(AITM_CODEC.planToTxt).join('\n') + '\n', AITM_CODEC.aircraftToTxt(aitm.ac) + '\n',
    AITM_CODEC.airportsToTxt(aitmUsedAirports(), function (c) { return aitmAp(c); }) + '\n'];
}
function aitmTxtSig() { return aitmHash(aitmTxtContent().join('\u0001')); }
function aitmSavedOk() { return !!aitm.plans.length && !!aitm.savedSig && aitm.savedSig === aitmTxtSig(); }
function aitmCheckedOk() { return !!aitm.plans.length && !!aitm.checkSig && aitm.checkSig === aitmPlanSig(); }
function aitmCompiledOk() { return !!aitm.compiledSig && aitm.compiledSig === aitmPlanSig() + '#' + aitmSortSig() + '#' + (aitm.outName || ''); }
function aitmUpdateCompileBtn() {
  var set = function (id, state, tip) {
    var b = document.getElementById(id); if (!b) return;
    var c = { red: ['#b62324', '#fff', '#b62324'], green: ['#238636', '#fff', '#2ea043'], blue: ['#1f6feb', '#fff', '#1f6feb'], grey: ['#30363d', 'var(--txt3)', '#30363d'] }[state];
    b.style.background = c[0]; b.style.color = c[1]; b.style.borderColor = c[2]; b.style.border = '1px solid ' + c[2];
    b.disabled = state === 'grey'; b.style.cursor = state === 'grey' ? 'not-allowed' : 'pointer'; b.title = tip;
  };
  var has = !!aitm.plans.length, chk = aitmCheckedOk(), srt = aitmSortedOk(), done = aitmCompiledOk(), svd = aitmSavedOk();
  set('aitm-btn-savetxt', !has ? 'grey' : svd ? 'green' : 'red', !has ? 'Load a flight plan first' : svd ? 'Saved — after a change it turns red again'
    : (aitm.savedSig ? 'Changed since the last save — save again' : 'Not saved as txt yet') + ' (Flightplans_, Aircraft_ and Airports_….txt — name and folder in the next window)');
  set('aitm-btn-check', chk ? 'green' : 'red', chk ? 'Checked: every flight plan can be flown (warnings aside)'
    : aitm.checkErrs ? aitm.checkErrs + ' error' + (aitm.checkErrs === 1 ? '' : 's') + ' — fix them and check again' : 'Check every flight plan — needed before Compile');
  set('aitm-btn-sort', srt ? 'green' : 'red', srt ? 'Sorted: largest aircraft is AC#1' : (aitm.sortSig ? 'The flight plans changed since sorting — sort again' : 'Sort the aircraft by size — needed before Compile'));
  set('aitm-compile', !has || !chk || !srt ? 'grey' : done ? 'green' : 'blue',
    !has ? 'Load a flight plan first' : !chk || !srt ? 'First “Check flightplans” and “Sort by aircraft size” (both green)' : done ? 'Compiled — after a change it turns blue again' : 'Compile the traffic BGL');
}

// ── modal ──
function aitmModal(title, body, buttons, wide) {
  aitmCloseModal();
  var pop = document.createElement('div'); pop.id = 'aitm-modal';
  pop.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
  pop.addEventListener('mousedown', function (e) { if (e.target === pop) aitmCloseModal(); });
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--surf);border:1px solid var(--bdr2);border-radius:12px;padding:18px 22px;min-width:340px;max-width:' + (wide === 'xl' ? '1280px' : wide ? '900px' : '520px') + ';width:' + (wide ? (wide === 'xl' ? '95vw' : '90vw') : 'auto') + ';box-shadow:0 8px 32px rgba(0,0,0,.6);';
  card.innerHTML = '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:12px;">' + title + '</div><div>' + body + '</div>'
    + '<div id="aitm-modal-btns" style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px;"></div>';
  pop.appendChild(card); document.body.appendChild(pop);
  var bb = card.querySelector('#aitm-modal-btns');
  (buttons || []).concat([['Close', aitmCloseModal, true]]).forEach(function (b) {
    var btn = document.createElement('button'); btn.textContent = b[0];
    btn.style.cssText = 'font-size:12px;font-weight:600;padding:6px 16px;border-radius:6px;cursor:pointer;' + (b[2] ? 'border:1px solid var(--bdr);background:transparent;color:var(--txt2);' : 'border:none;background:' + (b[3] || 'var(--acc)') + ';color:#fff;');
    btn.onclick = b[1]; bb.appendChild(btn);
  });
  return card;
}
function aitmCloseModal() { var p = document.getElementById('aitm-modal'); if (p) p.remove(); aitm._updDlg = false; }
function aitmToast(msg, warn) {
  var el = document.getElementById('aitm-status'); if (!el) return;
  el.textContent = msg; el.style.color = warn ? '#f0b400' : '#3fb950';
  clearTimeout(aitm._toastT); aitm._toastT = setTimeout(function () { el.textContent = ''; }, 9000);
}

// ── aircraft window: Split (more functions to come) ──
function aitmAcDialog(i) {
  var a = aitm.ac[i]; if (!a) return;
  var nfp = aitm.plans.filter(function (p) { return p.ac === a.n; }).length;
  var taken = !!aitmAcByN(a.n + 1);
  var inst = aitmInstalled(a.title);
  var card = aitmModal('AC#' + a.n + ' · ' + aitmEsc(a.title),
    '<div style="font-size:12px;color:var(--txt2);line-height:1.7;margin-bottom:12px;">' + aitmEsc(aitmAcTypeName(a)) + (a.speed ? ' · ' + a.speed + ' kts' : '') + ' · used by ' + nfp + ' flight plan' + (nfp === 1 ? '' : 's')
    + (inst ? '<br><span style="color:#3fb950;">Installed</span> · ' + inst.src + ' · ' + aitmEsc(inst.folder) : '') + '</div>'
    + '<div style="font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px;">Split</div>'
    + '<div style="font-size:12px;color:var(--txt2);margin-bottom:8px;line-height:1.5;">Adds a new AC#' + (a.n + 1) + ' right after this one' + (taken ? '; AC#' + (a.n + 1) + ' and the following numbers move up by one (also in the flight plans)' : '') + '. All flight plans stay on AC#' + a.n + ' — afterwards give some of them the new number (click their AC# in Legs).</div>'
    + '<input id="aitm-split-title" class="aitm-in" style="width:100%;box-sizing:border-box;" value="' + aitmEsc(a.title) + '">'
    + '<div style="font-size:11px;color:var(--txt3);margin-top:4px;">Title of the new aircraft — add an ending (e.g. a registration) or type something completely different.</div>'
    + (nfp === 0 && aitm.ac.length > 1 ? '<div style="margin-top:14px;font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.06em;font-weight:600;">Delete</div><div style="font-size:12px;color:var(--txt2);">No flight plan uses this aircraft — it can be removed.</div>' : ''),
    [['Split', function () { aitmSplit(i, document.getElementById('aitm-split-title').value); }]]
      .concat(nfp === 0 && aitm.ac.length > 1 ? [['Delete AC#' + a.n, function () { aitmDeleteAc(i); }, false, '#da3633']] : []));
  var inp = card.querySelector('#aitm-split-title');
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') aitmSplit(i, inp.value); });
}
function aitmSplit(i, title) {
  title = String(title || '').trim(); if (!title) return;
  var same = aitm.ac.filter(function (a) { return String(a.title).trim().toLowerCase() === title.toLowerCase(); })[0];
  if (same) { aitmToast('AC#' + same.n + ' already is “' + title + '” — give the new aircraft another title (e.g. add a registration).', true); return; }
  var src = aitm.ac[i], nn = src.n + 1;
  var inst = aitmInstalled(title);
  if (aitmAcByN(nn)) {   // the number is taken: it and all following ones move up by one
    aitm.ac.forEach(function (a) { if (a.n >= nn) a.n += 1; });
    aitm.plans.forEach(function (p) { if (p.ac >= nn) p.ac += 1; });
  }
  aitm.ac.splice(i + 1, 0, { n: nn, title: title, speed: inst && inst.speed ? inst.speed : src.speed, hint: src.hint || '', al: src.al || '', wing: inst ? inst.wing : (src.wing || 0) });
  aitmCloseModal(); aitmSave(); aitmRenderAll();
  aitmToast('AC#' + nn + ' added. Click the AC# of a flight plan in Legs to move it there.');
}
function aitmDeleteAc(i) {
  var n = aitm.ac[i].n;
  if (aitm.plans.some(function (p) { return p.ac === n; })) return;
  var close = !!aitmAcByN(n + 1);   // numbered without gaps: close the gap again
  aitm.ac.splice(i, 1);
  if (close) { aitm.ac.forEach(function (a) { if (a.n > n) a.n -= 1; }); aitm.plans.forEach(function (p) { if (p.ac > n) p.ac -= 1; }); }
  aitmCloseModal(); aitmSave(); aitmRenderAll();
}

// ── edit one flight plan as text ──
function aitmEditPlan(i) {
  var p = aitm.plans[i]; if (!p) return;
  var card = aitmModal('Flight plan ' + aitmEsc(p.reg) + ' <span style="font-size:11px;color:var(--txt3);font-weight:400;">TTools format, times UTC</span>',
    '<textarea id="aitm-plan-txt" spellcheck="false" style="width:100%;box-sizing:border-box;height:180px;font-family:monospace;font-size:12px;background:var(--bg);color:var(--txt);border:1px solid var(--bdr2);border-radius:6px;padding:8px;">'
    + aitmEsc(AITM_CODEC.planToTxt(p)) + '</textarea>'
    + '<div id="aitm-plan-err" style="font-size:11px;color:#f85149;margin-top:4px;"></div>',
    [['Save', function () {
      var r = AITM_CODEC.parseFlightplansTxt(document.getElementById('aitm-plan-txt').value.replace(/\n/g, ''));
      if (r.errors.length || r.plans.length !== 1) { document.getElementById('aitm-plan-err').textContent = r.errors[0] || 'Exactly one line “AC#…” please.'; return; }
      aitm.plans[i] = r.plans[0]; aitmCloseModal(); aitmSave(); aitmRenderAll();
    }], ['Delete flight plan', function () {
      if (!confirm('Delete the flight plan of ' + p.reg + '?')) return;
      aitm.plans.splice(i, 1); aitm.sel = []; aitmCloseModal(); aitmSave(); aitmRenderAll();
    }, false, '#da3633']], true);
  card.querySelector('#aitm-plan-txt').focus();
}

// ── delete flight plans ──
// Removes the flight plans (indexes into aitm.plans). An aircraft that loses its last flight plan
// here is removed from the aircraft list as well (closing the AC# gaps when the list was sorted).
function aitmDeletePlans(idxs) {
  var del = {}; idxs.forEach(function (i) { del[i] = 1; });
  var gone = aitm.plans.filter(function (p, i) { return del[i]; });
  if (!gone.length) return { plans: [], ac: [] };
  var wasSorted = aitmSortedOk();
  aitm.plans = aitm.plans.filter(function (p, i) { return !del[i]; });
  var use = {}; aitm.plans.forEach(function (p) { use[p.ac] = 1; });
  var goneAc = aitm.ac.filter(function (a) { return !use[a.n] && gone.some(function (p) { return p.ac === a.n; }); });
  if (goneAc.length) {
    aitm.ac = aitm.ac.filter(function (a) { return goneAc.indexOf(a) < 0; });
    if (wasSorted) {
      var map = {}; aitm.ac.forEach(function (a, k) { map[a.n] = k + 1; a.n = k + 1; });
      aitm.plans.forEach(function (p) { if (map[p.ac]) p.ac = map[p.ac]; });
      aitm.sortSig = aitmSortSig();
    }
  }
  aitm.sel = []; aitm.selAnchor = null;
  aitmSave(); aitmRenderAll();
  return { plans: gone, ac: goneAc };
}
function aitmAskDeletePlans(idxs) {
  idxs = idxs.filter(function (i) { return aitm.plans[i]; });
  if (!idxs.length) return;
  var ps = idxs.map(function (i) { return aitm.plans[i]; });
  var left = {}; aitm.plans.forEach(function (p, i) { if (idxs.indexOf(i) < 0) left[p.ac] = 1; });
  var lose = []; ps.forEach(function (p) { if (!left[p.ac] && lose.indexOf(p.ac) < 0) lose.push(p.ac); });
  var list = ps.slice(0, 8).map(function (p) { return p.reg + ' (AC#' + p.ac + ')'; }).join(', ') + (ps.length > 8 ? ' …' : '');
  if (!confirm('Delete ' + (ps.length === 1 ? 'the flight plan ' : ps.length + ' flight plans: ') + list + '?'
    + (lose.length ? '\n\nAC#' + lose.join(', AC#') + ' then flies nothing and is removed from the aircraft list too.' : ''))) return;
  var r = aitmDeletePlans(idxs);
  aitmToast(r.plans.length + ' flight plan' + (r.plans.length === 1 ? '' : 's') + ' deleted' + (r.ac.length ? ' · aircraft removed: ' + r.ac.map(function (a) { return a.title; }).join(', ') : '') + '.');
}
// 3D view of a flight plan's aircraft: Rotation Map shows it (AI Companion's viewer on this PC, else its
// browser preview) — it reads the model files itself, no folder to choose here
function aitmPlan3D(i) {
  var p = aitm.plans[i], a = p ? aitmAcByN(p.ac) : null;
  if (!a || !a.title) { aitmToast('This flight plan has no aircraft.', true); return; }
  if (aitm.fleet.length && !aitmInstalled(a.title)) { aitmToast('“' + a.title + '” is not installed — nothing to show.', true); return; }
  var w = window.open(AITM_RM_URL + '?from=msfs-manager&t=' + Date.now() + '#model=' + encodeURIComponent(a.title) + '&label=' + encodeURIComponent(p.reg + ' · AC#' + p.ac), 'rotationmap');
  if (w) { try { w.focus(); } catch (e) {} }
  else aitmToast('The browser blocked the new tab — allow pop-ups for this page.', true);
}

// ── move airports ──
function aitmMoveAirports(fromIcao) {
  if (!aitm.plans.length) return;
  var opts = aitm.ac.map(function (a) { return '<option value="' + a.n + '">AC#' + a.n + ' · ' + aitmEsc(a.title) + '</option>'; }).join('');
  var nSel = aitm.sel.length;
  aitmModal('Replace airport',
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:12px;color:var(--txt2);">'
    + '<span>Replace</span><input id="aitm-mv-from" class="aitm-in" style="width:90px;text-transform:uppercase;" placeholder="KJFK" value="' + aitmEsc(fromIcao || '') + '">'
    + '<span>by</span><input id="aitm-mv-to" class="aitm-in" style="width:90px;text-transform:uppercase;" placeholder="KLGA">'
    + '<span style="align-self:start;padding-top:2px;">in</span><div style="display:flex;flex-direction:column;gap:6px;">'
    + '<label><input type="radio" name="aitm-mv-scope" value="all"' + (nSel ? '' : ' checked') + '> all flights</label>'
    + '<label><input type="radio" name="aitm-mv-scope" value="ac"> all flights of <select id="aitm-mv-ac" class="aitm-in" style="max-width:300px;">' + opts + '</select></label>'
    + '<label' + (nSel ? '' : ' style="opacity:.5;"') + '><input type="radio" name="aitm-mv-scope" value="sel"' + (nSel ? ' checked' : ' disabled') + '> all selected flights'
    + (nSel ? ' <b style="color:#fff;">(' + nSel + ' selected)</b>' : '') + '</label>'
    + '<div style="font-size:11px;color:var(--txt3);margin-left:22px;line-height:1.5;">' + (nSel ? '' : 'None selected yet. ') + 'Select them first in Legs: click a line, Shift-click for a range, Ctrl-click to add or remove single lines.</div>'
    + '</div></div><div id="aitm-mv-msg" style="font-size:11px;margin-top:10px;color:var(--txt3);"></div>',
    [['Replace', function () {
      var from = document.getElementById('aitm-mv-from').value.trim().toUpperCase(), to = document.getElementById('aitm-mv-to').value.trim().toUpperCase();
      var scope = (document.querySelector('input[name=aitm-mv-scope]:checked') || {}).value;
      var msg = document.getElementById('aitm-mv-msg');
      if (!/^[A-Z0-9]{3,4}$/.test(from) || !/^[A-Z0-9]{3,4}$/.test(to)) { msg.style.color = '#f85149'; msg.textContent = 'Two airport codes, please.'; return; }
      if (!aitmAp(to) && !msg.dataset.ok) { msg.style.color = '#f0b400'; msg.textContent = to + ' is not in the airport database (no coordinates) — click Replace again to do it anyway.'; msg.dataset.ok = '1'; return; }
      var acN = parseInt(document.getElementById('aitm-mv-ac').value, 10), n = 0, np = 0;
      aitm.plans.forEach(function (p, i) {
        if (scope === 'ac' && p.ac !== acN) return;
        if (scope === 'sel' && aitm.sel.indexOf(i) < 0) return;
        var hit = 0; p.legs.forEach(function (l) { if (l.to === from) { l.to = to; n++; hit = 1; } }); np += hit;
      });
      aitmCloseModal(); aitmSave(); aitmRenderAll();
      aitmToast(n ? from + ' → ' + to + ': ' + n + ' leg' + (n === 1 ? '' : 's') + ' in ' + np + ' flight plan' + (np === 1 ? '' : 's') + ' changed.' : from + ' was not found' + (scope === 'sel' ? ' in the selected flights.' : '.'), !n);
    }]]);
  document.getElementById(fromIcao ? 'aitm-mv-to' : 'aitm-mv-from').focus();
}

// ── checks + compile ──
function aitmCheck() { return aitmCheckData({ ac: aitm.ac, plans: aitm.plans, ap: aitmAp }); }
function aitmCheckData(d) {
  var errs = [], warns = [], items = [], byN = {}, seen = {}, used = [], regs = {};
  var E = function (t, pi) { errs.push(t); items.push({ lv: 'err', t: t, pi: pi }); };
  var W = function (t, pi) { warns.push(t); items.push({ lv: 'warn', t: t, pi: pi }); };
  var DN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var hm = function (m) { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  var dur = function (m) { return Math.floor(m / 60) + ':' + String(Math.round(m) % 60).padStart(2, '0'); };
  var nm = function (A, B) {
    var r = Math.PI / 180, dLa = (B.lat - A.lat) * r, dLo = (B.lon - A.lon) * r;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(A.lat * r) * Math.cos(B.lat * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  d.ac.forEach(function (a) { byN[a.n] = a; });
  d.plans.forEach(function (p) { p.legs.forEach(function (l) { if (!seen[l.to]) { seen[l.to] = 1; used.push(l.to); } }); });
  if (!d.plans.length) E('No flight plan loaded.');
  var missingAp = used.sort().filter(function (c) { return !d.ap(c); });
  if (missingAp.length) E('Unknown airport' + (missingAp.length > 1 ? 's' : '') + ' (no coordinates): ' + missingAp.join(', ') + ' — use Replace airport, or add it with right-click → Airport Data.');
  d.plans.forEach(function (p, pi) {
    var a = byN[p.ac], who = p.reg + ' (AC#' + p.ac + ')';
    if (!a) E(who + ': AC#' + p.ac + ' does not exist in the aircraft list.', pi);
    if (String(p.reg).length > 7) W(who + ': registration longer than 7 characters is cut to ' + String(p.reg).slice(0, 7) + '.', pi);
    if (regs[p.reg] != null) W(who + ': the registration ' + p.reg + ' is used by two flight plans.', pi); else regs[p.reg] = pi;
    if (parseInt(p.pct, 10) === 0) W(who + ': 0 % — this flight plan never flies.', pi);
    var n = p.legs.length;
    if (!n) { E(who + ': no legs.', pi); return; }
    var inst = a ? aitmInstalled(a.title) : null, spd = (inst && inst.speed) || (a && a.speed) || 0;
    var P = AITM_CODEC.periodOf(p.period)[1], T = 0, gaps = [];
    var at = function (m) { m = ((m % P) + P) % P; return (P >= 10080 ? DN[Math.floor(m / 1440) % 7] + ' ' : '') + hm(m); };
    p.legs.forEach(function (l, j) {
      var from = p.legs[(j - 1 + n) % n].to, nx = p.legs[(j + 1) % n], L = ' leg ' + (j + 1) + ' ' + from + '→' + l.to;
      if (l.dep == null) E(who + L + ': no departure time.', pi);
      if (l.arr == null) E(who + L + ': no arrival time.', pi);
      if (parseInt(l.fnum, 10) > 16383) E(who + L + ': flight number ' + l.fnum + ' is too high (max. 16383).', pi);
      if (l.alt > 1023) E(who + L + ': altitude ' + l.alt + ' is too high.', pi);
      if (n > 1 && from === l.to) E(who + L + ': departs from the airport it flies to — the flight before did not land somewhere else.', pi);
      if (l.dep == null || l.arr == null) return;
      var blk = ((l.arr - l.dep) % P + P) % P;
      if (blk === 0) E(who + L + ': no flight time (departs and lands at ' + at(l.dep) + ').', pi);
      else if (blk > 1440) E(who + L + ': flight time ' + dur(blk) + ' — more than 24 hours.', pi);
      else if (from !== l.to) {
        var A = d.ap(from), B = d.ap(l.to);
        if (A && B && spd >= 200) { var dist = nm(A, B), need = dist / spd * 60; if (need > blk * 1.1 && need - blk > 15) W(who + L + ': ' + Math.round(dist) + ' nm in ' + dur(blk) + ' — at ' + spd + ' kts it needs at least ' + dur(need) + '.', pi); }
      }
      T += blk;
      if (nx.dep != null) {
        var gap = ((nx.dep - l.arr) % P + P) % P; T += gap; gaps.push({ j: j, gap: gap });
        if (n > 1 && gap < 10) W(who + ': only ' + gap + ' min on the ground at ' + l.to + ' (leg ' + (j + 1) + ' → ' + ((j + 1) % n + 1) + ').', pi);
      }
    });
    // one cycle of the legs must take exactly one period; more means a departure before the previous landing
    if (gaps.length === n && T > P) {
      var g = gaps.slice().sort(function (x, y) { return y.gap - x.gap; })[0], k = (g.j + 1) % n;
      E(who + ': leg ' + (k + 1) + ' departs ' + at(p.legs[k].dep) + ' (' + p.legs[g.j].to + '), before leg ' + (g.j + 1) + ' has landed there (' + at(p.legs[g.j].arr) + ')'
        + ' — the legs need ' + Math.round(T / P) + ' × ' + AITM_CODEC.periodName(p.period).toLowerCase() + ' instead of one.', pi);
    }
  });
  // identical flight plans: the same legs at the same times over the whole period (registration, AC#,
  // altitudes and % aside) — two aircraft flying the same rotation side by side
  var dups = [], bySig = {};
  d.plans.forEach(function (p, pi) {
    if (!p.legs.length) return;
    var sig = String(p.period).toLowerCase() + '|' + p.legs.map(function (l) { return [l.dep, l.arr, l.to, String(l.fnum).replace(/^0+/, ''), l.tng ? 1 : 0].join('/'); }).sort().join(';');
    if (bySig[sig] == null) { bySig[sig] = pi; return; }
    var k = bySig[sig], q = d.plans[k];
    dups.push({ keep: k, drop: pi });
    E(p.reg + ' (AC#' + p.ac + ') flies exactly the same rotation as ' + q.reg + ' (AC#' + q.ac + ') — '
      + p.legs.length + ' legs at the same times. Delete one of them.', pi);
  });
  var use = {}; d.plans.forEach(function (p) { use[p.ac] = (use[p.ac] || 0) + 1; });
  d.ac.forEach(function (a) {
    if (!use[a.n]) return;
    var none = !a.title || /^AC#\d+$/i.test(a.title) || /^AIGAIM_[A-Z0-9]{2,4}\s+\S+\s+NCv2$/.test(a.title);
    if (none) W('AC#' + a.n + ' flies ' + use[a.n] + ' flight plan' + (use[a.n] === 1 ? '' : 's') + ' but has no aircraft assigned (' + (a.title || '—') + ') — drag one from the fleet on the right.');
    else if (aitm.fleet.length && !aitmInstalled(a.title)) W('AC#' + a.n + ' “' + a.title + '” is not among your installed aircraft — the simulator will not show it.');
    if (!a.speed) W('AC#' + a.n + ': no cruise speed — 450 kts is used.');
  });
  return { errs: errs, warns: warns, items: items, dups: dups, unused: d.ac.filter(function (a) { return !use[a.n]; }) };
}
function aitmShowCheck() { aitmCheckPlans(); }
function aitmShowCheckOld() {
  var c = aitmCheck();
  var li = function (arr, col) { return arr.slice(0, 60).map(function (x) { return '<div style="padding:3px 0;border-bottom:1px solid var(--bdr);color:' + col + ';">' + aitmEsc(x) + '</div>'; }).join('') + (arr.length > 60 ? '<div style="color:var(--txt3);">… ' + (arr.length - 60) + ' more</div>' : ''); };
  aitmModal('Check',
    '<div style="max-height:60vh;overflow:auto;font-size:12px;">'
    + (c.errs.length ? '<div style="font-weight:700;color:#f85149;margin:4px 0;">' + c.errs.length + ' error' + (c.errs.length > 1 ? 's' : '') + ' — cannot compile</div>' + li(c.errs, '#ffb4ab') : '<div style="color:#3fb950;font-weight:700;margin:4px 0;">No errors — ready to compile.</div>')
    + (c.warns.length ? '<div style="font-weight:700;color:#f0b400;margin:10px 0 4px;">' + c.warns.length + ' warning' + (c.warns.length > 1 ? 's' : '') + '</div>' + li(c.warns, 'var(--txt2)') : '')
    + '</div>', [], true);
}
function aitmModel() { return aitmModelOf(aitm.ac, aitm.plans); }
function aitmModelOf(ac, plans) {
  var arr = []; ac.forEach(function (a) { arr[a.n - 1] = { title: a.title, speed: a.speed || 450 }; });
  return { aircraft: arr, plans: plans };
}
// bigger aircraft first — the simulator hands out parking first come, first served
function aitmOrder(plans) { return aitmOrderFor(aitm.ac)(plans); }
function aitmOrderFor(ac) {
  var byN = {}; ac.forEach(function (a) { byN[a.n] = a; });
  var wing = function (p) { var a = byN[p.ac]; return a ? aitmAcSize(a).ft : 0; };
  return function (plans) {
    return plans.map(function (p, i) { return { p: p, i: i, w: wing(p) }; }).sort(function (x, y) { return (y.w - x.w) || (x.i - y.i); }).map(function (x) { return x.p; });
  };
}
async function aitmPickOut() {
  if (!window.showDirectoryPicker) { aitmToast('This browser cannot write into folders — the BGL is downloaded instead.', true); return null; }
  try {
    var h = await window.showDirectoryPicker({ id: 'aitm-out', mode: 'readwrite' });
    await aitmKvSet('outFolder', h); aitmRenderBottom(); return h;
  } catch (e) { return null; }
}
async function aitmCompile() {
  var name = (document.getElementById('aitm-out-name') || {}).value || aitm.outName || 'Traffic_CRE_Airline.bgl';
  name = name.trim(); if (!/\.bgl$/i.test(name)) name += '.bgl';
  aitm.outName = name; aitmSave();
  if (!aitmCheckedOk() || !aitmSortedOk()) { aitmUpdateCompileBtn(); aitmToast('First “Check flightplans” and “Sort by aircraft size” (both green).', true); return; }
  var c = aitmCheck();
  if (c.errs.length) { aitmCheckPlans(); return; }
  var doneSig = aitmPlanSig() + '#' + aitmSortSig() + '#' + name;
  aitmToast('Compiling …');
  await new Promise(function (r) { setTimeout(r, 30); });
  var t0 = Date.now();
  var res = AITM_CODEC.writeBGL(aitmModel(), function (icao) { return aitmAp(icao); }, { halve: true, order: aitmOrder });
  if (res.errors) { aitmModal('Cannot compile', res.errors.map(aitmEsc).join('<br>')); return; }
  var info = res.plans + ' flight plans, ' + res.aircraft + ' aircraft, ' + res.airports + ' airports · ' + Math.round(res.bytes.length / 1024) + ' KB';
  var dir = await aitmKvGet('outFolder');
  if (dir && window.showDirectoryPicker) {
    if (!(await aitmPermOk(dir, true))) { aitmToast('No write access to ' + dir.name + ' — click Compile again and allow it.', true); return; }
    try {
      var where = await aitmWriteBgl(dir, name, res.bytes);
      aitmToast('✓ ' + name + ' written to ' + where + ' (' + info + ', ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s).');
      aitm.compiledSig = doneSig; aitmSave();
      return;
    } catch (e) { aitmToast('Could not write into ' + dir.name + ': ' + e.message + ' — downloading instead.', true); }
  }
  aitmDownload(res.bytes, name, 'application/octet-stream');
  aitmToast('✓ ' + name + ' downloaded (' + info + ').');
  aitm.compiledSig = doneSig; aitmSave();
}
// package root (has layout.json): write Scenery/World/Traffic/<name> and update layout.json; else write into the folder
async function aitmWriteBgl(dir, name, bytes, opt) {
  opt = opt || {};
  var hasLayout = false, layoutH = null;
  try { layoutH = await dir.getFileHandle('layout.json'); hasLayout = true; } catch (e) {}
  var target = dir, rel = name;
  if (hasLayout) {
    target = await (await (await dir.getDirectoryHandle('Scenery', { create: true })).getDirectoryHandle('World', { create: true })).getDirectoryHandle('Traffic', { create: true });
    rel = 'Scenery/World/Traffic/' + name;
  }
  var exists = null; try { exists = await target.getFileHandle(name); } catch (e) {}
  if (exists) {
    if (opt.ask !== false && !confirm(name + ' already exists in ' + (hasLayout ? dir.name + '\\Scenery\\World\\Traffic' : dir.name) + '.\n\nReplace it? (A copy of the old file is kept in the Backups folder.)')) throw new Error('cancelled');
    var bdir = await dir.getDirectoryHandle('Backups', { create: true });
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    var old = await (await exists.getFile()).arrayBuffer();
    var bw = await (await bdir.getFileHandle(name.replace(/\.bgl$/i, '') + '_' + stamp + '.bgl.bak', { create: true })).createWritable();
    await bw.write(old); await bw.close();
  }
  var fh = await target.getFileHandle(name, { create: true });
  var w = await fh.createWritable(); await w.write(bytes); await w.close();
  if (hasLayout) {
    await aitmLayoutSet(layoutH, rel, fh);
    return dir.name + '\\Scenery\\World\\Traffic (layout.json updated)';
  }
  return dir.name;
}
// layout.json of the package: add/update the entry of rel (file handle fh), or remove it (fh = null)
async function aitmLayoutSet(layoutH, rel, fh) {
  var raw = (await (await layoutH.getFile()).text()).replace(/^\uFEFF/, '');
  var lay = JSON.parse(raw.replace(/("date"\s*:\s*)(\d+)/g, '$1"$2"'));
  var low = rel.toLowerCase();
  var content = (lay.content || []).filter(function (x) { return fh || String(x.path).toLowerCase() !== low; });
  if (fh) {
    var f = await fh.getFile(), hit = false;
    var ticks = ((BigInt(f.lastModified) + BigInt(11644473600000)) * BigInt(10000)).toString();
    content.forEach(function (x) { if (String(x.path).toLowerCase() === low) { x.size = f.size; x.date = ticks; hit = true; } });
    if (!hit) content.push({ path: rel, size: f.size, date: ticks });
  }
  lay.content = content;
  var txt = JSON.stringify(lay, null, 2).replace(/("date": )"(\d+)"/g, '$1$2');
  var lw = await layoutH.createWritable(); await lw.write(txt); await lw.close();
}
function aitmDownload(data, name, type) {
  var url = URL.createObjectURL(new Blob([data], { type: type || 'text/plain' }));
  var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
}
// Save txt: Flightplans_/Aircraft_/Airports_<name>.txt - name and folder chosen in a window. Folders offered: the one the
// plan was opened from, the one in "CRE flightplans" that holds Flightplans_<name>.txt, the txt folder, another one.
// Files that exist are replaced; the old ones are kept in a Backups folder (aitmTxtBackupDir).
async function aitmFindTxtDir(root, base) {
  var want = ('flightplans_' + base + '.txt').toLowerCase();
  async function walk(d, path, depth) {
    for await (var e of d.values()) {
      if (e.kind === 'file' && e.name.toLowerCase() === want) return { h: d, path: path };
      if (e.kind === 'directory' && depth > 0 && !/^backups$/i.test(e.name)) { var r = await walk(e, path.concat([e.name]), depth - 1); if (r) return r; }
    }
    return null;
  }
  try { return await walk(root, [], 4); } catch (e) { return null; }
}
async function aitmSaveTxt() {
  if (!aitm.plans.length) { aitmToast('Load a flight plan first.', true); return; }
  var base0 = aitm.fileBase || (aitm.outName || 'Traffic_CRE_Airline.bgl').replace(/\.bgl$/i, '').replace(/^Traffic_/i, '');
  var places = [];
  if (aitm._srcDir) places.push({ h: aitm._srcDir.h, label: aitm._srcDir.label, why: 'the folder it was opened from' });
  var fpRoot = await aitmKvGet('fpRoot');
  if (fpRoot && !aitm._srcDir && (await fpRoot.queryPermission({ mode: 'read' })) === 'granted') {
    var f = await aitmFindTxtDir(fpRoot, base0);
    if (f) places.push({ h: f.h, label: [fpRoot.name].concat(f.path).join(' \\ '), why: 'where Flightplans_' + base0 + '.txt is' });
  }
  var txtDir = await aitmKvGet('txtFolder');
  if (txtDir && !places.some(function (x) { return x.h.name === txtDir.name; })) places.push({ h: txtDir, label: txtDir.name, why: 'your txt folder' });
  var ckErrs = aitmCheck().errs;
  aitm._svNorm = null;
  var card = aitmModal('Save as txt',
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:10px 12px;align-items:start;font-size:12px;color:var(--txt2);">'
    + '<span style="padding-top:5px;">Name</span><div><input id="aitm-sv-name" class="aitm-in" style="width:260px;" value="' + aitmEsc(base0) + '">'
    + '<div id="aitm-sv-files" style="font-size:11px;color:var(--txt3);margin-top:4px;"></div></div>'
    + '<span>Folder</span><div style="display:flex;flex-direction:column;gap:6px;">'
    + places.map(function (x, i) { return '<label><input type="radio" name="aitm-sv-dir" value="' + i + '"' + (i ? '' : ' checked') + '> <b style="color:#fff;">' + aitmEsc(x.label) + '</b> <span style="color:var(--txt3);">· ' + x.why + '</span></label>'; }).join('')
    + '<label><input type="radio" name="aitm-sv-dir" value="other"' + (places.length ? '' : ' checked') + '> another folder…</label></div></div>'
    + '<div style="font-size:11px;color:var(--txt3);margin-top:12px;line-height:1.5;">Saved as it is compiled: aircraft sorted by size (AC#1 = largest), the same aircraft only once, aircraft without flights left out.</div>'
    + (ckErrs.length ? '<div style="font-size:11px;color:#f0b400;margin-top:6px;line-height:1.5;">⚠ Check flightplans finds ' + ckErrs.length + ' error' + (ckErrs.length === 1 ? '' : 's') + ' (' + aitmEsc(ckErrs[0].slice(0, 90)) + (ckErrs.length > 1 ? ' …' : '') + ') — this plan cannot be compiled yet. It is saved anyway.</div>' : '')
    + '<div id="aitm-sv-msg" style="font-size:11px;margin-top:10px;min-height:14px;line-height:1.5;"></div>',
    [['Save', function () { aitmSaveTxtGo(places); }, false, '#238636'], ['Download instead', function () { aitmSaveTxtGo(null); }, true]]);
  var inp = card.querySelector('#aitm-sv-name');
  var show = function () { var b = inp.value.trim(); card.querySelector('#aitm-sv-files').textContent = b ? 'Flightplans_' + b + '.txt · Aircraft_' + b + '.txt · Airports_' + b + '.txt' : ''; card.querySelector('#aitm-sv-msg').textContent = ''; aitm._svConfirm = null; };
  inp.addEventListener('input', show); show();
  card.querySelectorAll('input[name=aitm-sv-dir]').forEach(function (r) { r.addEventListener('change', function () { aitm._svConfirm = null; card.querySelector('#aitm-sv-msg').textContent = ''; }); });
  inp.focus(); inp.select();
}
// Backups of replaced txt files are not kept next to the flight plans: they go to one folder "Backups" in
// "CRE flightplans" (the Installation Manager's flight plan folder), else to a "Backups" folder inside the
// folder saved to. Names: Flightplans_X_<yyyymmdd_hhmm>.txt.bak (.bak: no tool takes them for a flight plan).
async function aitmTxtBackupDir(saveDir) {
  var root = await aitmKvGet('fpRoot');
  if (root) { try { if (await aitmPermOk(root, true)) return { h: await root.getDirectoryHandle('Backups', { create: true }), label: root.name + '\\Backups' }; } catch (e) {} }
  return { h: await saveDir.getDirectoryHandle('Backups', { create: true }), label: saveDir.name + '\\Backups' };
}
function aitmBakName(name, when) {
  var d = when ? new Date(when) : new Date(), p = function (n) { return String(n).padStart(2, '0'); };
  return name.replace(/\.txt$/i, '') + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.txt.bak';
}
// a name in the Backups folder that is not taken yet (…_2, …_3)
async function aitmFreeName(dir, name) {
  for (var k = 1; k < 100; k++) {
    var n = k === 1 ? name : name.replace(/\.txt\.bak$/i, '_' + k + '.txt.bak');
    try { await dir.getFileHandle(n); } catch (e) { return n; }
  }
  return name;
}
async function aitmSaveTxtGo(places) {
  var msg = document.getElementById('aitm-sv-msg'), say = function (t, col) { if (msg) { msg.innerHTML = t; msg.style.color = col || 'var(--txt2)'; } };
  var base = String((document.getElementById('aitm-sv-name') || {}).value || '').trim().replace(/[\\/:*?"<>|]/g, '');
  if (!base) { say('A name, please.', '#f85149'); return; }
  var norm = aitmMakeCompiled(), nm = aitmMakeCompiledMsg(norm);
  if (nm) aitm._svNorm = aitm._svNorm ? aitm._svNorm + ' · ' + nm : nm;
  var txt = aitmTxtContent(), txtSig = aitmTxtSig();
  var files = [['Flightplans_' + base + '.txt', txt[0]], ['Aircraft_' + base + '.txt', txt[1]], ['Airports_' + base + '.txt', txt[2]]];
  var rename = function () { if (base !== aitm.fileBase) { aitm.fileBase = base; aitm.outName = 'Traffic_' + base + '.bgl'; aitmSave(); aitmRenderBottom(); } };
  if (!places) { files.forEach(function (f, k) { setTimeout(function () { aitmDownload(f[1], f[0]); }, k * 400); }); aitmCloseModal(); aitm.savedSig = txtSig; aitmSave(); rename(); aitmToast('✓ ' + files.map(function (f) { return f[0]; }).join(', ') + ' downloaded' + (aitm._svNorm ? ' · ' + aitm._svNorm : '') + '.'); aitm._svNorm = null; return; }
  var pick = (document.querySelector('input[name=aitm-sv-dir]:checked') || {}).value, dir, label;
  if (pick === 'other' || pick == null) {
    try { dir = await window.showDirectoryPicker({ id: 'aitm-txt', mode: 'readwrite' }); } catch (e) { return; }
    await aitmKvSet('txtFolder', dir); label = dir.name;
  } else { dir = places[+pick].h; label = places[+pick].label; }
  if (!(await aitmPermOk(dir, true))) { say('Chrome did not allow writing into “' + aitmEsc(label) + '”. Click Save again and allow it.', '#f0b400'); return; }
  var exist = [];
  for (var i = 0; i < files.length; i++) { try { await dir.getFileHandle(files[i][0]); exist.push(files[i][0]); } catch (e) {} }
  var key = label + '|' + base;
  if (exist.length && aitm._svConfirm !== key) {
    aitm._svConfirm = key;
    say(exist.join(', ') + (exist.length === 1 ? ' already exists' : ' already exist') + ' in ' + aitmEsc(label) + '. Click <b>Save</b> again to replace — the old ' + (exist.length === 1 ? 'file is' : 'files are') + ' kept in the <b>Backups</b> folder.', '#f0b400');
    return;
  }
  var bak = null, moved = 0;
  try {
    if (exist.length) bak = await aitmTxtBackupDir(dir);
    for (var j = 0; j < files.length; j++) {
      if (exist.indexOf(files[j][0]) >= 0) {
        var oldF = await (await dir.getFileHandle(files[j][0])).getFile(), old = await oldF.arrayBuffer();
        var bw = await (await bak.h.getFileHandle(await aitmFreeName(bak.h, aitmBakName(files[j][0])), { create: true })).createWritable(); await bw.write(old); await bw.close();
      }
      // an old-style backup next to the flight plans (<name>.txt.bak) moves into the Backups folder too
      try {
        var ob = await dir.getFileHandle(files[j][0] + '.bak'), obF = await ob.getFile();
        if (!bak) bak = await aitmTxtBackupDir(dir);
        var ow = await (await bak.h.getFileHandle(await aitmFreeName(bak.h, aitmBakName(files[j][0], obF.lastModified)), { create: true })).createWritable(); await ow.write(await obF.arrayBuffer()); await ow.close();
        await dir.removeEntry(files[j][0] + '.bak'); moved++;
      } catch (e) {}
      var w = await (await dir.getFileHandle(files[j][0], { create: true })).createWritable();
      await w.write(new Blob([files[j][1]], { type: 'text/plain' })); await w.close();
    }
  } catch (e) { say('Could not write: ' + aitmEsc(e.message), '#f85149'); return; }
  aitm._svConfirm = null;
  aitm._srcDir = { h: dir, label: label };
  aitmCloseModal(); aitm.savedSig = txtSig; aitmSave(); rename();
  aitmToast('✓ ' + files.map(function (f) { return f[0]; }).join(', ') + ' saved in ' + label + (exist.length ? ' · old ones in ' + bak.label : '')
    + (moved ? ' · ' + moved + ' old .txt.bak moved there' : '') + (aitm._svNorm ? ' · ' + aitm._svNorm : '') + '.');
  aitm._svNorm = null;
}
async function aitmFoldersDialog() {
  var logos = (await aitmKvGet('logoFolders')) || [], out = await aitmKvGet('outFolder'), txt = await aitmKvGet('txtFolder');
  var btn = function (label, on) { return '<button onclick="' + on + '" style="font-size:11px;padding:2px 8px;border-radius:5px;border:1px solid var(--bdr);background:transparent;color:var(--txt2);cursor:pointer;">' + label + '</button>'; };
  var row = function (name, info, btns) { return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--bdr);"><span style="flex:1;color:#fff;">' + aitmEsc(name) + '</span><span style="color:var(--txt3);font-size:11px;">' + info + '</span>' + (btns || '') + '</div>'; };
  var srcs = aitm.sources || [];
  aitmModal('Folders',
    '<div style="font-size:12px;color:var(--txt2);line-height:1.6;">'
    + '<div style="font-weight:700;color:var(--txt);margin-bottom:4px;">Installed AI aircraft</div>'
    + (srcs.length ? srcs.map(function (x) {
        return row(x.name, x.src + ' · ' + x.cfg + ' aircraft.cfg · ' + x.liveries + ' liveries · read ' + new Date(x.at).toLocaleDateString(),
          btn('Read again', 'aitmReadAircraftFolder()') + ' ' + btn('Remove', "aitmForgetSource('" + aitmEsc(x.name).replace(/'/g, "\\'") + "')"));
      }).join('') : '<div style="color:var(--txt3);">none read yet</div>')
    + '<div style="font-size:11px;color:var(--txt3);margin:4px 0 12px;">AIG: <span style="font-family:monospace;">C:\\MSFS\\Microsoft Flight Simulator Add-ons\\AIG AI Manager\\aig-aitraffic-oci</span> · own: <span style="font-family:monospace;">OneDrive\\…\\AI Traffic by CRE\\AI Traffic Aircraft</span><br>'
    + '<b>⟳ Update installed aircraft</b> (above the fleet) reads every aircraft of your Community folder through Rotation Map — no folder to choose; Rotation Map has to run. '
    + 'Without Rotation Map a folder can be read by hand here: Chrome hides *.cfg files from folder access, so that uses the browser’s folder upload (Chrome calls it “upload”, but nothing leaves your PC).</div>'
    + '<div style="font-weight:700;color:var(--txt);margin-bottom:4px;">Logos</div>'
    + (logos.length ? logos.map(function (h, i) { return row(h.name, 'logos', btn('Remove', 'aitmRemoveLogoFolder(' + i + ')')); }).join('') : '<div style="color:var(--txt3);">none yet — e.g. your Rotation Map folder (it has “Logos” and “AI Companion\\logos”)</div>')
    + '<div style="font-weight:700;color:var(--txt);margin:12px 0 4px;">Output</div>'
    + row(out ? out.name : 'not chosen', 'BGL (package folder with layout.json)') + row(txt ? txt.name : 'not chosen (asked on first save)', 'txt')
    + '</div>',
    [['+ Read aircraft folder…', function () { aitmReadAircraftFolder(); }, false, '#3fb950'], ['+ Logo folder', function () { aitmAddLogoFolder(); }],
     ['BGL folder…', function () { aitmPickOut().then(aitmFoldersDialog); }], ['txt folder…', async function () { try { var h = await window.showDirectoryPicker({ id: 'aitm-txt', mode: 'readwrite' }); await aitmKvSet('txtFolder', h); aitmFoldersDialog(); } catch (e) {} }]], true);
}

// ── logos (like Rotation Map: logo folders, file named after the traffic file, the callsign or the airline) ──
async function aitmAddLogoFolder() {
  if (!window.showDirectoryPicker) return;
  try {
    var h = await window.showDirectoryPicker({ id: 'aitm-logos', mode: 'read' });
    var l = (await aitmKvGet('logoFolders')) || []; l.push(h); await aitmKvSet('logoFolders', l);
    aitm.logos = null; aitmCloseModal(); await aitmFindLogo(true); aitmFoldersDialog();
  } catch (e) {}
}
async function aitmRemoveLogoFolder(i) {
  var l = (await aitmKvGet('logoFolders')) || []; l.splice(i, 1); await aitmKvSet('logoFolders', l); aitm.logos = null; aitmFoldersDialog();
}
async function aitmLogoIndex(ask) {
  if (aitm.logos) return aitm.logos;
  var l = (await aitmKvGet('logoFolders')) || [], ix = {};
  async function walk(d, depth) {
    for await (var e of d.values()) {
      if (e.kind === 'file' && /\.(png|jpe?g|gif)$/i.test(e.name)) { var k = e.name.replace(/\.[^.]+$/, '').toLowerCase(); if (!ix[k]) ix[k] = e; }
      else if (e.kind === 'directory' && depth > 0 && /logo|companion/i.test(e.name)) await walk(e, depth - 1);
    }
  }
  for (var i = 0; i < l.length; i++) {
    var ok = (await l[i].queryPermission({ mode: 'read' })) === 'granted';
    if (!ok && ask) ok = await aitmPermOk(l[i]);
    if (ok) await walk(l[i], 3);
  }
  aitm.logos = ix; return ix;
}
async function aitmFindLogo(ask) {
  try {
    if (!window.showDirectoryPicker || aitm.kind === 'airport') return;
    var ix = await aitmLogoIndex(ask);
    var keys = [];
    if (aitm.outName) keys.push(aitm.outName.replace(/\.bgl$/i, ''));
    if (aitm.fileBase) keys.push('Traffic_' + aitm.fileBase);
    var cs = {};
    aitm.ac.forEach(function (a) { var e = aitmInstalled(a.title); if (e && e.atcAirline) cs[e.atcAirline] = (cs[e.atcAirline] || 0) + 1; });
    Object.keys(cs).sort(function (a, b) { return cs[b] - cs[a]; }).forEach(function (k) { keys.push(k); });
    if (aitm.name) { keys.push(aitm.name); keys.push(aitm.name.replace(/\s+/g, '')); }
    if (aitm.code) keys.push(aitm.code);
    var hit = null;
    for (var i = 0; i < keys.length && !hit; i++) hit = ix[String(keys[i]).toLowerCase()];
    if (aitm.logoUrl) { URL.revokeObjectURL(aitm.logoUrl); aitm.logoUrl = null; }
    if (hit) aitm.logoUrl = URL.createObjectURL(await hit.getFile());
    aitmRenderHeader();
  } catch (e) { console.warn('logo', e); }
}

// ═══ 3D view of a livery — as in Rotation Map's browser viewer (three.js; the simulator's glTF
// read directly, textures from the livery folder and its fallbacks; DDS handed to the graphics
// card as compressed textures). Model and texture files are read with folder access (only *.cfg
// is hidden by Chrome — model.cfg and texture.cfg are kept from reading the aircraft folder).
var AITM_ORBIT_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
async function aitmOpen3D(e) {
  if (!e) return;
  if (!window.showDirectoryPicker) { aitmToast('The 3D view needs Chrome or Edge.', true); return; }
  if (!e.rel && e.rel !== '' || e.model == null) {
    aitmModal('3D view', '<div style="font-size:12px;color:var(--txt2);line-height:1.6;">Read the folder <b>' + aitmEsc(e.root || '') + '</b> once more (Folders → Read again) — then the page knows where the model and texture files of each livery are.</div>',
      [['Read aircraft folder…', function () { aitmCloseModal(); aitmReadAircraftFolder(); }]]);
    return;
  }
  var roots = (await aitmKvGet('mdlRoots')) || {};
  var h = roots[e.root];
  if (h && (await aitmPermOk(h))) { aitmView3D(e, h, 0); return; }
  aitmModal('3D view',
    '<div style="font-size:12px;color:var(--txt2);line-height:1.6;">For the 3D view the page reads the model and texture files directly. '
    + (h ? 'Chrome needs your OK for “' + aitmEsc(e.root) + '” again.' : 'Choose the folder <b>' + aitmEsc(e.root) + '</b> once (the same one you read the aircraft from) and allow Chrome to view it — choose “Allow on every visit” if Chrome offers it.') + '</div>',
    [[h ? 'Allow' : 'Choose folder…', async function () {
      try {
        var x = h;
        if (x) { if (!(await aitmPermOk(x))) return; }
        else {
          x = await window.showDirectoryPicker({ id: 'aitm-3d', mode: 'read' });
          if (x.name.toLowerCase() !== String(e.root).toLowerCase() && !confirm('You chose “' + x.name + '”, but the aircraft were read from “' + e.root + '”. Use it anyway?')) return;
          roots[e.root] = x; await aitmKvSet('mdlRoots', roots);
        }
        aitmCloseModal(); aitmView3D(e, x, 0);
      } catch (err) { if (err && err.name !== 'AbortError') aitmToast(err.message, true); }
    }]]);
}
async function aitmDirMap(d) {
  if (d._aitmMap) return d._aitmMap;
  var m = {}; for await (var x of d.values()) m[x.name.toLowerCase()] = x;
  d._aitmMap = m; return m;
}
async function aitmChild(d, name, kind) { var m = await aitmDirMap(d); var x = m[String(name).toLowerCase()]; return x && x.kind === kind ? x : null; }
// path (Windows style, may contain ..) from a folder given as a stack of handles from the root
async function aitmResolve(stack, rel) {
  var st = stack.slice();
  var parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '.') continue;
    if (parts[i] === '..') { if (st.length <= 1) return null; st.pop(); continue; }
    var c = await aitmChild(st[st.length - 1], parts[i], 'directory'); if (!c) return null; st.push(c);
  }
  return st;
}
function aitmHalf(h) {
  var s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}
var AITM_NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }, AITM_CSIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
function aitmAccessor(g, bufs, ai, o) {
  var a = g.accessors[ai], bv = g.bufferViews[a.bufferView], buf = bufs[bv.buffer];
  var n = AITM_NCOMP[a.type], cs = AITM_CSIZE[a.componentType], stride = bv.byteStride || n * cs;
  var base = (bv.byteOffset || 0) + (a.byteOffset || 0), dv = new DataView(buf), k = o.want || n;
  var out = o.asIndex ? new Uint32Array(a.count) : new Float32Array(a.count * k);
  for (var i = 0; i < a.count; i++) {
    var q = base + i * stride;
    for (var c = 0; c < Math.min(k, n); c++) {
      var p = q + c * cs, v;
      switch (a.componentType) {
        case 5126: v = dv.getFloat32(p, true); break;
        case 5120: v = dv.getInt8(p); if (!o.asIndex) v = Math.max(-1, v / 127); break;
        case 5121: v = dv.getUint8(p); if (!o.asIndex && a.normalized) v /= 255; break;
        case 5122: v = o.half ? aitmHalf(dv.getUint16(p, true)) : dv.getInt16(p, true) / (a.normalized ? 32767 : 1); break;
        case 5123: v = dv.getUint16(p, true); if (!o.asIndex && a.normalized) v /= 65535; break;
        case 5125: v = dv.getUint32(p, true); break;
        default: v = 0;
      }
      if (o.asIndex) out[i] = v; else out[i * k + c] = v;
    }
  }
  return out;
}
// DDS -> three.js texture (BC1/BC2/BC3/BC7 stay compressed on the graphics card; RGBA as data)
function aitmDdsTexture(T, buf, caps) {
  var dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (buf.byteLength < 128 || dv.getUint32(0, true) !== 0x20534444) return null;
  var h = dv.getUint32(12, true), w = dv.getUint32(16, true), mips = Math.max(1, dv.getUint32(28, true));
  var pf = dv.getUint32(80, true), four = String.fromCharCode(u8[84], u8[85], u8[86], u8[87]), bits = dv.getUint32(88, true);
  var off = 128, fmt = null, bs = 0, raw = null;
  if (four === 'DXT1') { fmt = T.RGBA_S3TC_DXT1_Format; bs = 8; }
  else if (four === 'DXT2' || four === 'DXT3') { fmt = T.RGBA_S3TC_DXT3_Format; bs = 16; }
  else if (four === 'DXT4' || four === 'DXT5') { fmt = T.RGBA_S3TC_DXT5_Format; bs = 16; }
  else if (four === 'DX10') {
    off = 148; var f = dv.getUint32(128, true);
    if (f >= 70 && f <= 72) { fmt = T.RGBA_S3TC_DXT1_Format; bs = 8; }
    else if (f >= 73 && f <= 75) { fmt = T.RGBA_S3TC_DXT3_Format; bs = 16; }
    else if (f >= 76 && f <= 78) { fmt = T.RGBA_S3TC_DXT5_Format; bs = 16; }
    else if (f >= 97 && f <= 99) { fmt = T.RGBA_BPTC_Format; bs = 16; }
    else if (f >= 27 && f <= 29) raw = 'rgba'; else if (f === 87 || f === 90 || f === 91) raw = 'bgra';
    else return null;
  } else if ((pf & 0x40) && bits === 32) raw = dv.getUint32(92, true) === 0x00ff0000 ? 'bgra' : 'rgba';
  else return null;
  var t, srgb = true;
  if (fmt != null) {
    var bptc = fmt === T.RGBA_BPTC_Format;
    if (bptc ? !caps.bptc : !caps.s3tc) return null;
    if (!bptc && !caps.s3tcSrgb) srgb = false;
    var levels = [], cw = w, ch = h, p = off;
    for (var i = 0; i < mips; i++) {
      var size = Math.max(1, Math.ceil(cw / 4)) * Math.max(1, Math.ceil(ch / 4)) * bs;
      if (p + size > buf.byteLength) break;
      levels.push({ data: new Uint8Array(buf, p, size), width: cw, height: ch });
      p += size; cw = Math.max(1, cw >> 1); ch = Math.max(1, ch >> 1);
    }
    if (!levels.length) return null;
    var last = levels[levels.length - 1], full = levels.length > 1 && last.width === 1 && last.height === 1;
    while (full && levels.length > 1 && Math.max(levels[0].width, levels[0].height) > 2048) levels.shift();
    if (!full) levels = [levels[0]];
    t = new T.CompressedTexture(levels, levels[0].width, levels[0].height, fmt);
    t.minFilter = levels.length > 1 ? T.LinearMipmapLinearFilter : T.LinearFilter;
    t.generateMipmaps = false;
  } else {
    var px = new Uint8Array(w * h * 4);
    px.set(new Uint8Array(buf, off, Math.min(w * h * 4, buf.byteLength - off)));
    if (raw === 'bgra') for (var j = 0; j < px.length; j += 4) { var b = px[j]; px[j] = px[j + 2]; px[j + 2] = b; }
    t = new T.DataTexture(px, w, h, T.RGBAFormat);
    t.minFilter = T.LinearFilter;
  }
  t.magFilter = T.LinearFilter; t.flipY = false; t.wrapS = t.wrapT = T.RepeatWrapping;
  if (srgb) t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = 8; t.needsUpdate = true;
  return t;
}
function aitm3dClose() {
  var box = document.getElementById('aitm-3d-box'); if (box) box.remove();
  if (aitm.v3d) { aitm.v3d.dispose(); aitm.v3d = null; }
}
async function aitmView3D(e, root, lod) {
  aitm3dClose();
  var box = document.createElement('div'); box.id = 'aitm-3d-box';
  box.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);';
  box.innerHTML = '<div style="background:var(--surf);border:1px solid var(--bdr2);border-radius:12px;width:min(1100px,92vw);height:min(760px,88vh);display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.6);overflow:hidden;">'
    + '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--bdr);">'
    + '<div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + aitmEsc(e.title) + '</div>'
    + '<div id="aitm-3d-sub" style="font-size:11px;color:var(--txt3);"></div></div>'
    + '<label style="font-size:11px;color:var(--txt2);">Detail <select id="aitm-3d-lod" class="aitm-in" style="padding:2px 4px;"></select></label>'
    + '<label style="font-size:11px;color:var(--txt2);"><input type="checkbox" id="aitm-3d-spin"> Turn</label>'
    + '<button class="aitm-btn" id="aitm-3d-reset" style="padding:3px 10px;">Reset view</button>'
    + '<button class="aitm-btn" id="aitm-3d-close" style="padding:3px 10px;">Close</button></div>'
    + '<div id="aitm-3d-canvas" style="flex:1;position:relative;min-height:0;"><div id="aitm-3d-msg" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--txt2);font-size:13px;padding:20px;text-align:center;">Loading the model …</div></div>'
    + '<div id="aitm-3d-foot" style="padding:6px 14px;font-size:11px;color:var(--txt3);border-top:1px solid var(--bdr);"></div></div>';
  document.body.appendChild(box);
  box.addEventListener('mousedown', function (ev) { if (ev.target === box) aitm3dClose(); });
  document.getElementById('aitm-3d-close').onclick = aitm3dClose;
  var msg = document.getElementById('aitm-3d-msg'), say = function (t) { msg.style.display = 'flex'; msg.textContent = t; };
  try {
    var T = await import('three');
    var OrbitControls = (await import(AITM_ORBIT_URL)).OrbitControls;
    // the aircraft folder
    var stack = await aitmResolve([root], e.rel);
    if (!stack) { say('Folder ' + e.rel + ' not found in “' + root.name + '”.'); return; }
    var acDir = stack[stack.length - 1];
    var meta = ((aitm.fleetMeta || {})[e.root] || {})[e.rel] || { m: {}, t: {} };
    var mName = 'model' + (e.model ? '.' + e.model : '');
    var mdl = await aitmChild(acDir, mName, 'directory');
    if (!mdl) { say('Model folder “' + mName + '” not found in ' + e.folder + '.'); return; }
    var mStack = stack.concat([mdl]);
    // LOD list: model.cfg [models] normal= (an XML with the LODs, or a glTF)
    var lods = [], normal = meta.m[mdl.name.toLowerCase()] || '';
    var readXml = async function (nameRel) {
      var parts = nameRel.split(/[\\/]+/), st = await aitmResolve(mStack, parts.slice(0, -1).join('/'));
      if (!st) return [];
      var fh = await aitmChild(st[st.length - 1], parts[parts.length - 1], 'file'); if (!fh) return [];
      var txt = await (await fh.getFile()).text(), out = [], re = /ModelFile\s*=\s*"([^"]+)"/gi, x;
      while ((x = re.exec(txt))) if (out.indexOf(x[1]) < 0) out.push(x[1]);
      return out;
    };
    if (/\.gltf$/i.test(normal)) lods = [normal];
    else if (normal) lods = await readXml(normal);
    if (!lods.length) {
      var mm = await aitmDirMap(mdl), xmls = Object.keys(mm).filter(function (k) { return /\.xml$/.test(k) && !/interior/.test(k); });
      for (var xi = 0; xi < xmls.length && !lods.length; xi++) lods = await readXml(mm[xmls[xi]].name);
      if (!lods.length) lods = Object.keys(mm).filter(function (k) { return /\.gltf$/.test(k) && !/interior/.test(k); }).sort().map(function (k) { return mm[k].name; });
    }
    lods = lods.filter(function (l) { return !/interior/i.test(l); });
    if (!lods.length) { say('No glTF model found in ' + e.folder + '\\' + mdl.name + '.'); return; }
    if (lod >= lods.length) lod = 0;
    var sel = document.getElementById('aitm-3d-lod');
    sel.innerHTML = lods.map(function (l, i) { return '<option value="' + i + '"' + (i === lod ? ' selected' : '') + '>' + (i === 0 ? 'Highest' : 'LOD ' + i) + '</option>'; }).join('');
    sel.onchange = function () { aitmView3D(e, root, parseInt(sel.value, 10)); };
    var lp = lods[lod].split(/[\\/]+/), gStack = await aitmResolve(mStack, lp.slice(0, -1).join('/'));
    var gDir = gStack && gStack[gStack.length - 1], gh = gDir && await aitmChild(gDir, lp[lp.length - 1], 'file');
    if (!gh) { say(lods[lod] + ' not found.'); return; }
    var g = JSON.parse((await (await gh.getFile()).text()).replace(/^﻿/, ''));
    var bufs = await Promise.all((g.buffers || []).map(async function (b) {
      var bh = await aitmChild(gDir, String(b.uri || '').split(/[\\/]/).pop(), 'file');
      if (!bh) throw new Error('model data ' + b.uri + ' missing');
      return (await bh.getFile()).arrayBuffer();
    }));
    // texture folders: the livery, its fallbacks (texture.cfg), the aircraft's "texture", the model folder
    var texStacks = [], seen = {};
    var addTex = async function (st, depth) {
      if (!st || depth > 5) return;
      var key = st.map(function (x) { return x.name; }).join('/').toLowerCase();
      if (seen[key]) return; seen[key] = 1; texStacks.push(st);
      var top = st[st.length - 1], fbs = st.length === stack.length + 1 ? meta.t[top.name.toLowerCase()] : null;
      if (!fbs && !Object.keys(meta.t).length && st.length === stack.length + 1) {
        // read before the 3D view existed: guess the usual fallbacks
        var am = await aitmDirMap(acDir);
        fbs = Object.keys(am).filter(function (k) { return /^oci\.texture/.test(k) || k === 'texture.base'; }).map(function (k) { return '..\\' + am[k].name; }).concat(['..\\..\\..\\..\\texture']);
      }
      for (var i = 0; fbs && i < fbs.length; i++) await addTex(await aitmResolve(st, fbs[i]), depth + 1);
    };
    var tName = 'texture' + (e.texture ? '.' + e.texture : '');
    var tdir = await aitmChild(acDir, tName, 'directory');
    if (tdir) await addTex(stack.concat([tdir]), 0);
    var plain = await aitmChild(acDir, 'texture', 'directory'); if (plain) await addTex(stack.concat([plain]), 0);
    await addTex(mStack, 0);
    var findTex = async function (uri) {
      var name = String(uri || '').split(/[\\/]/).pop(); if (!name) return null;
      var cands = [name, name + '.dds', name.replace(/\.dds$/i, '')];
      for (var i = 0; i < texStacks.length; i++) {
        var d = texStacks[i][texStacks[i].length - 1];
        for (var c = 0; c < cands.length; c++) { var f = await aitmChild(d, cands[c], 'file'); if (f) return f; }
      }
      return null;
    };
    document.getElementById('aitm-3d-sub').textContent = e.folder + ' \\ ' + mdl.name + ' · ' + (tdir ? tdir.name : '(default livery)') + ' · ' + lods[lod];
    // renderer
    var host = document.getElementById('aitm-3d-canvas');
    var W = host.clientWidth, H = host.clientHeight;
    var renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(W, H);
    renderer.outputColorSpace = T.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    var ex = renderer.extensions;
    var caps = { s3tc: ex.has('WEBGL_compressed_texture_s3tc'), s3tcSrgb: ex.has('WEBGL_compressed_texture_s3tc_srgb'), bptc: ex.has('EXT_texture_compression_bptc') };
    var scene = new T.Scene(); scene.background = new T.Color(0x1d232b);
    scene.add(new T.HemisphereLight(0xffffff, 0x8090a0, 2.2));
    var sun = new T.DirectionalLight(0xffffff, 2.2); sun.position.set(-30, 50, 40); scene.add(sun);
    var fill = new T.DirectionalLight(0xffffff, 0.8); fill.position.set(40, 20, -40); scene.add(fill);
    var camera = new T.PerspectiveCamera(35, W / H, 0.1, 5000);
    var controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.autoRotateSpeed = 1.2;
    var render = function () { renderer.render(scene, camera); };
    // materials (base colour only, as in Rotation Map)
    var texCache = {}, missing = [], pending = [];
    var texture = function (src) {
      var img = g.images && g.images[src]; if (!img || !img.uri) return Promise.resolve(null);
      if (!texCache[img.uri]) texCache[img.uri] = findTex(img.uri).then(async function (fh) {
        if (!fh) { missing.push(img.uri); return null; }
        var buf = await (await fh.getFile()).arrayBuffer();
        if (/\.dds$/i.test(fh.name)) { var t = aitmDdsTexture(T, buf, caps); if (!t) missing.push(img.uri + ' (format)'); return t; }
        var bmp = await createImageBitmap(new Blob([buf]));
        var t2 = new T.Texture(bmp); t2.flipY = false; t2.colorSpace = T.SRGBColorSpace; t2.wrapS = t2.wrapT = T.RepeatWrapping; t2.needsUpdate = true; return t2;
      }).catch(function () { missing.push(img.uri); return null; });
      return texCache[img.uri];
    };
    var matCache = {};
    var material = function (mi) {
      if (matCache[mi]) return matCache[mi];
      var m = (g.materials && g.materials[mi]) || {}, ext = m.extensions || {};
      var hidden = ext.ASOBO_material_invisible || ext.ASOBO_material_shadow_only || ext.ASOBO_material_environment_occluder || /collision|invisible|shadow_only/i.test(m.name || '');
      var pbr = m.pbrMetallicRoughness || {}, f = pbr.baseColorFactor || [1, 1, 1, 1];
      var mat = new T.MeshStandardMaterial({ color: new T.Color(f[0], f[1], f[2]), metalness: Math.min(0.4, pbr.metallicFactor == null ? 0.1 : pbr.metallicFactor),
        roughness: Math.max(0.35, pbr.roughnessFactor == null ? 0.6 : pbr.roughnessFactor), side: m.doubleSided ? T.DoubleSide : T.FrontSide, opacity: f[3] });
      if (m.alphaMode === 'BLEND') { mat.transparent = true; mat.depthWrite = false; }
      if (m.alphaMode === 'MASK') mat.alphaTest = m.alphaCutoff == null ? 0.5 : m.alphaCutoff;
      var ti = pbr.baseColorTexture ? pbr.baseColorTexture.index : -1;
      if (ti >= 0 && g.textures && g.textures[ti]) {
        var tx = g.textures[ti], src = tx.source != null ? tx.source : (tx.extensions && tx.extensions.MSFT_texture_dds ? tx.extensions.MSFT_texture_dds.source : undefined);
        if (src != null) {
          if (m.alphaMode === 'BLEND' || m.alphaMode === 'MASK') mat.visible = false; // see-through parts only with their picture
          pending.push(texture(src).then(function (t) { if (t) { mat.map = t; mat.visible = !hidden; mat.needsUpdate = true; render(); } }));
        }
      }
      if (hidden) mat.visible = false;
      return (matCache[mi] = mat);
    };
    // geometry (the simulator stores normals as bytes and texture coordinates as half floats)
    var model = new T.Group();
    var meshes = (g.meshes || []).map(function (mesh) {
      var grp = new T.Group();
      (mesh.primitives || []).forEach(function (pr) {
        if (pr.mode !== undefined && pr.mode !== 4) return;
        var at = pr.attributes || {}; if (at.POSITION === undefined) return;
        var asobo = pr.extras && pr.extras.ASOBO_primitive, geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(aitmAccessor(g, bufs, at.POSITION, { want: 3 }), 3));
        if (at.NORMAL !== undefined) geo.setAttribute('normal', new T.BufferAttribute(aitmAccessor(g, bufs, at.NORMAL, { want: 3 }), 3));
        if (at.TEXCOORD_0 !== undefined) {
          var acc = g.accessors[at.TEXCOORD_0];
          geo.setAttribute('uv', new T.BufferAttribute(aitmAccessor(g, bufs, at.TEXCOORD_0, { want: 2, half: acc.componentType === 5122 && !acc.normalized }), 2));
        }
        if (pr.indices !== undefined) {
          var idx = aitmAccessor(g, bufs, pr.indices, { asIndex: true });
          if (asobo && (asobo.BaseVertexIndex || asobo.StartIndex !== undefined)) {
            var start = asobo.StartIndex || 0, cnt = asobo.PrimitiveCount ? asobo.PrimitiveCount * 3 : idx.length - start, bvi = asobo.BaseVertexIndex || 0;
            idx = idx.slice(start, start + cnt).map(function (i) { return i + bvi; });
          }
          geo.setIndex(new T.BufferAttribute(idx, 1));
        }
        if (at.NORMAL === undefined) geo.computeVertexNormals();
        grp.add(new T.Mesh(geo, material(pr.material == null ? -1 : pr.material)));
      });
      return grp;
    });
    var nodes = (g.nodes || []).map(function (n) {
      var o = new T.Group();
      if (n.matrix) { o.matrix.fromArray(n.matrix); o.matrix.decompose(o.position, o.quaternion, o.scale); }
      if (n.translation) o.position.fromArray(n.translation);
      if (n.rotation) o.quaternion.fromArray(n.rotation);
      if (n.scale) o.scale.fromArray(n.scale);
      if (n.mesh !== undefined && meshes[n.mesh]) o.add(meshes[n.mesh].clone());
      return o;
    });
    (g.nodes || []).forEach(function (n, i) { (n.children || []).forEach(function (c) { if (nodes[c]) nodes[i].add(nodes[c]); }); });
    var sc0 = g.scenes && g.scenes[g.scene || 0];
    var tops = sc0 ? sc0.nodes : nodes.map(function (_, i) { return i; }).filter(function (i) { return !(g.nodes || []).some(function (n) { return (n.children || []).indexOf(i) >= 0; }); });
    tops.forEach(function (i) { if (nodes[i]) model.add(nodes[i]); });
    model.scale.x = -1; // the simulator's glTF is left-handed: mirror so registrations read the right way
    scene.add(model);
    var fit = function () {
      var bb = new T.Box3().setFromObject(model), size = bb.getSize(new T.Vector3()), c = bb.getCenter(new T.Vector3());
      var r = Math.max(size.x, size.y, size.z) || 10;
      camera.position.set(c.x - r * 1.05, c.y + r * 0.28, c.z + r * 0.75);
      camera.near = r / 200; camera.far = r * 50; camera.updateProjectionMatrix();
      controls.target.copy(c); controls.update(); render();
    };
    var raf = 0, alive = true;
    var loop = function () {
      cancelAnimationFrame(raf);
      var tick = function () { if (!alive) return; var moved = controls.update(); render(); if (moved || controls.autoRotate) raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
    };
    controls.addEventListener('change', render); controls.addEventListener('start', loop);
    var ro = new ResizeObserver(function () { var w2 = host.clientWidth, h2 = host.clientHeight; if (!w2 || !h2) return; renderer.setSize(w2, h2); camera.aspect = w2 / h2; camera.updateProjectionMatrix(); render(); });
    ro.observe(host);
    document.getElementById('aitm-3d-spin').onchange = function (ev) { controls.autoRotate = ev.target.checked; loop(); };
    document.getElementById('aitm-3d-reset').onclick = fit;
    aitm.v3d = { dispose: function () {
      alive = false; cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      renderer.dispose();
    } };
    msg.style.display = 'none';
    fit(); loop();
    var foot = document.getElementById('aitm-3d-foot');
    foot.textContent = 'Drag to turn · wheel to zoom · right button to move · loading textures …';
    await Promise.all(pending);
    foot.innerHTML = 'Drag to turn · wheel to zoom · right button to move'
      + (missing.length ? ' · <span title="' + aitmEsc(missing.join('\n')) + '" style="color:#f0b400;">' + missing.length + ' texture' + (missing.length === 1 ? '' : 's') + ' not found</span>' : '')
      + (!caps.bptc ? ' · this graphics card cannot show BC7 textures' : '');
    render();
  } catch (err) {
    console.warn('3D', err);
    say('3D view not possible: ' + (err && err.message || err) + (/import|module|fetch/i.test(String(err && err.message)) ? ' (three.js could not be loaded from cdn.jsdelivr.net)' : ''));
  }
}

// ═══ Installation Manager: every flight plan of the "CRE flightplans" folder (with sub folders)
// and whether its traffic BGL is in AI Traffic BGL\Scenery\World\Traffic.
async function aitmInstallManager(force) {
  var fpRoot = await aitmKvGet('fpRoot'), out = await aitmKvGet('outFolder');
  var need = [];
  if (!fpRoot) need.push('fp'); if (!out) need.push('bgl');
  var okFp = fpRoot && (await aitmPermOk(fpRoot)), okOut = out && (await aitmPermOk(out));
  if (!okFp || !okOut) {
    aitmModal('Installation Manager',
      '<div style="font-size:12px;color:var(--txt2);line-height:1.7;">The Installation Manager compares two folders — choose them once (Chrome then remembers them):<br>'
      + '1. <b>Flight plans:</b> ' + (fpRoot ? aitmEsc(fpRoot.name) + (okFp ? ' ✓' : ' (allow again)') : '<span style="font-family:monospace;">…\\Fligthplans - Fictional and vintage\\CRE flightplans</span>') + '<br>'
      + '2. <b>Traffic BGLs:</b> ' + (out ? aitmEsc(out.name) + (okOut ? ' ✓' : ' (allow again)') : 'the package folder <span style="font-family:monospace;">…\\AI Traffic by CRE\\AI Traffic BGL</span>') + '</div>',
      [[fpRoot ? (okFp ? 'Other flight plan folder…' : 'Allow flight plans') : 'Choose flight plan folder…', async function () {
        try {
          if (fpRoot && !okFp) { await aitmPermOk(fpRoot); }
          else { var h = await window.showDirectoryPicker({ id: 'aitm-fproot', mode: 'read' }); await aitmKvSet('fpRoot', h); }
          aitmInstallManager();
        } catch (e) {}
      }], [out ? (okOut ? 'Other BGL folder…' : 'Allow BGL folder') : 'Choose BGL folder…', async function () {
        try {
          if (out && !okOut) { await aitmPermOk(out, true); }
          else { var h = await window.showDirectoryPicker({ id: 'aitm-out', mode: 'readwrite' }); await aitmKvSet('outFolder', h); aitmRenderBottom(); }
          aitmInstallManager();
        } catch (e) {}
      }]], true);
    return;
  }
  aitmModal('Installation Manager', '<div id="aitm-im" style="font-size:12px;color:var(--txt2);">Reading the folders …</div>', [], 'xl');
  await aitmImScan();
}
var AITM_REMOVED = 'Removed BGLs';     // "Remove from BGL" keeps the file here as <name>.bgl.off — the simulator ignores it
// rows: every flight plan (with its Aircraft_/Airports_ files) + every BGL of the Traffic folder without a flight plan
// + every removed BGL without a flight plan
async function aitmImScan(msg) {
  var fpRoot = await aitmKvGet('fpRoot'), out = await aitmKvGet('outFolder');
  if (!fpRoot || !out) return;
  var plans = {};
  async function walk(d, path, depth) {
    for await (var e of d.values()) {
      if (e.kind === 'directory') { if (depth > 0 && !/^backups$/i.test(e.name)) await walk(e, path.concat([e.name]), depth - 1); continue; }
      var m = /^(flightplans|aircraft|airports)_(.+)\.txt$/i.exec(e.name); if (!m) continue;
      var key = path.join('/') + '|' + m[2].toLowerCase();
      var x = plans[key] = plans[key] || { name: m[2], path: path.slice(), fp: null, ac: null, ap: null };
      x[{ flightplans: 'fp', aircraft: 'ac', airports: 'ap' }[m[1].toLowerCase()]] = e;
    }
  }
  await walk(fpRoot, [], 4);
  var isPkg = false, tdir = out;
  try { await out.getFileHandle('layout.json'); isPkg = true; } catch (e) {}
  if (isPkg) { try { tdir = await (await (await out.getDirectoryHandle('Scenery')).getDirectoryHandle('World')).getDirectoryHandle('Traffic'); } catch (e) { tdir = null; } }
  var bgls = {}, removed = {}, rdir = null;
  if (tdir) for await (var b of tdir.values()) if (b.kind === 'file' && /\.bgl$/i.test(b.name)) bgls[b.name.toLowerCase()] = b;
  try { rdir = await out.getDirectoryHandle(AITM_REMOVED); } catch (e) {}
  if (rdir) for await (var b2 of rdir.values()) if (b2.kind === 'file' && /\.bgl\.off$/i.test(b2.name)) removed[b2.name.slice(0, -4).toLowerCase()] = b2;
  var norm = function (t) { return String(t).toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var bare = function (fname) { return String(fname).replace(/\.off$/i, '').replace(/\.bgl$/i, '').replace(/^traffic_/i, ''); };
  var finder = function (map) {
    var byNorm = {}; Object.keys(map).forEach(function (k) { byNorm[norm(bare(k))] = k; });
    return function (name) { var k = ('traffic_' + name + '.bgl').toLowerCase(); return map[k] ? k : (byNorm[norm(name)] || null); };
  };
  var findB = finder(bgls), findR = finder(removed), usedB = {}, usedR = {};
  var rows = Object.keys(plans).map(function (k) { return plans[k]; }).filter(function (x) { return x.fp; });
  rows.forEach(function (r) {
    var kb = findB(r.name), kr = findR(r.name);
    r.bgl = kb ? bgls[kb] : null; r.removed = kr ? removed[kr] : null;
    if (kb) usedB[kb] = 1; if (kr) usedR[kr] = 1;
  });
  Object.keys(bgls).forEach(function (k) {
    if (usedB[k]) return;
    rows.push({ name: bare(bgls[k].name), path: [], fp: null, ac: null, ap: null, bgl: bgls[k], removed: removed[k] || null });
    usedR[k] = 1;
  });
  Object.keys(removed).forEach(function (k) {
    if (!usedR[k]) rows.push({ name: bare(removed[k].name), path: [], fp: null, ac: null, ap: null, bgl: null, removed: removed[k] });
  });
  for (var i = 0; i < rows.length; i++) {
    rows[i].fpDate = rows[i].fp ? (await rows[i].fp.getFile()).lastModified : 0;
    rows[i].bglDate = rows[i].bgl ? (await rows[i].bgl.getFile()).lastModified : 0;
  }
  rows.sort(function (a, b) { var x = a.name.toLowerCase(), y = b.name.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  aitm.im = { rows: rows, fpRoot: fpRoot, out: out, tdir: tdir, isPkg: isPkg };
  aitmImRender(msg);
}
function aitmImCss() {
  if (document.getElementById('aitm-im-css')) return;
  var st = document.createElement('style'); st.id = 'aitm-im-css';
  st.textContent =
    '.aitm-pill{display:inline-block;padding:3px 9px;margin:0 2px;border-radius:5px;font-size:11px;font-weight:700;color:#fff;white-space:nowrap;cursor:default;}'
    + '.aitm-pill.on{background:#238636;}.aitm-pill.off{background:#a4262c;}'
    + '.aitm-imb{font-size:11px;font-weight:600;padding:4px 10px;margin-left:4px;border-radius:5px;cursor:pointer;white-space:nowrap;border:1px solid var(--bdr);background:transparent;color:var(--txt2);}'
    + '.aitm-imb.t{border-color:#2ea043;color:#3fb950;}.aitm-imb.r{border-color:#da3633;color:#ff7b72;}'
    + '.aitm-imb:hover:not(:disabled){background:rgba(255,255,255,.07);}'
    + '.aitm-imb:disabled{opacity:.22;cursor:default;}'
    + '.aitm-im-row:hover{background:rgba(255,255,255,.035);}'
    + '.aitm-im-row td{padding:6px 8px;vertical-align:middle;}';
  document.head.appendChild(st);
}
function aitmImRender(msg) {
  var im = aitm.im, el = document.getElementById('aitm-im'); if (!el || !im) return;
  aitmImCss();
  var sc = document.getElementById('aitm-im-scroll'), top = sc ? sc.scrollTop : 0;
  var rows = im.rows, fmtD = function (t) { return t ? new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : ''; };
  var pill = function (on, label, tip) { return '<span class="aitm-pill ' + (on ? 'on' : 'off') + '" title="' + aitmEsc(tip) + '">' + label + '</span>'; };
  var nFp = rows.filter(function (r) { return r.fp; }).length, nB = rows.filter(function (r) { return r.bgl; }).length;
  var nLone = rows.filter(function (r) { return r.bgl && !r.fp; }).length, nRem = rows.filter(function (r) { return r.removed && !r.bgl; }).length;
  var tPath = im.isPkg ? im.out.name + '\\Scenery\\World\\Traffic' : im.out.name;
  var f = aitm.imF || 'all', opt = function (v, t) { return '<option value="' + v + '"' + (f === v ? ' selected' : '') + '>' + t + '</option>'; };
  el.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">'
    + '<span><b style="color:#fff;">' + nFp + '</b> flight plans in <b style="color:#fff;">' + aitmEsc(im.fpRoot.name) + '</b> · <b style="color:#3fb950;">' + nB + '</b> BGLs in the Traffic folder'
    + (nLone ? ' (' + nLone + ' without txt)' : '') + (nRem ? ' · ' + nRem + ' removed' : '') + '</span>'
    + '<select class="aitm-in" style="margin-left:auto;padding:3px 6px;" onchange="aitm.imF=this.value;aitmImFilter()">'
    + opt('all', 'All') + opt('in', 'BGL in the Traffic folder') + opt('out', 'BGL not in the Traffic folder') + opt('notxt', 'BGL without txt') + '</select>'
    + '<input class="aitm-in" placeholder="🔍 filter" style="width:190px;padding:3px 8px;" value="' + aitmEsc(aitm.imQ || '') + '" oninput="aitm.imQ=this.value;aitmImFilter()">'
    + '<button class="aitm-btn" style="padding:3px 10px;" onclick="aitmKvSet(\'fpRoot\', null).then(function(){aitmInstallManager();})">Other folders…</button></div>'
    + '<div id="aitm-im-msg" style="min-height:18px;margin-bottom:6px;line-height:1.5;">' + (msg ? (msg.warn ? '<span style="color:#f0b400;">' : '<span style="color:#3fb950;">') + msg.html + '</span>' : '<span style="color:var(--txt3);">Green = there, red = missing. Transfer to BGL compiles the txt into the Traffic folder; Remove from BGL takes the BGL out (a copy stays in ' + aitmEsc(im.out.name) + '\\' + AITM_REMOVED + '). Restart the simulator afterwards.</span>') + '</div>'
    + '<div id="aitm-im-scroll" style="max-height:62vh;overflow:auto;border:1px solid var(--bdr);border-radius:8px;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
    + '<thead><tr style="position:sticky;top:0;z-index:1;background:var(--surf2);color:var(--txt3);text-align:left;">'
    + '<th style="padding:7px 10px;">Flight plan</th><th style="padding:7px 8px;">Folder</th><th style="padding:7px 8px;text-align:center;">Files</th><th style="padding:7px 10px;text-align:right;">Actions</th></tr></thead><tbody>'
    + rows.map(function (r, i) {
        var stale = r.bgl && r.fp && r.fpDate > r.bglDate + 60000;
        var canT = r.fp ? !!r.ac : (!r.bgl && !!r.removed);
        var note = '';
        if (r.fp && !r.ac) note = '<span style="color:#ff7b72;">Aircraft_' + aitmEsc(r.name) + '.txt is missing — cannot compile</span>';
        else if (stale) note = '<span style="color:#f0b400;">⚠ txt changed after the BGL was made (' + fmtD(r.fpDate) + ' / ' + fmtD(r.bglDate) + ') — Transfer to BGL updates it</span>';
        else if (!r.bgl && r.removed && !r.fp) note = '<span style="color:var(--txt3);">removed — Transfer to BGL puts it back</span>';
        else if (r.bgl && r.fp && r.bgl.name.toLowerCase() !== ('traffic_' + r.name + '.bgl').toLowerCase()) note = '<span style="color:var(--txt3);">' + aitmEsc(r.bgl.name) + '</span>';
        var tTip = r.fp ? (!r.ac ? 'Aircraft_' + r.name + '.txt is missing' : r.bgl ? 'Compile the txt again and replace ' + r.bgl.name + ' (the old one goes to Backups)' : 'Compile the txt and put the BGL into ' + tPath)
                        : r.bgl ? 'Already in the Traffic folder (no txt to compile)' : r.removed ? 'Put ' + r.removed.name.replace(/\.off$/i, '') + ' back into ' + tPath : '';
        var rTip = r.bgl ? 'Take ' + r.bgl.name + ' out of ' + tPath + ' — a copy stays in ' + im.out.name + '\\' + AITM_REMOVED : 'Not in the Traffic folder';
        return '<tr class="aitm-im-row" data-i="' + i + '" data-q="' + aitmEsc((r.name + ' ' + r.path.join(' ')).toLowerCase()) + '" style="border-top:1px solid var(--bdr);">'
          + '<td style="padding-left:10px;"><div style="color:#fff;font-weight:600;">' + aitmEsc(r.name) + '</div>' + (note ? '<div style="font-size:11px;margin-top:2px;">' + note + '</div>' : '') + '</td>'
          + '<td style="color:var(--txt3);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + aitmEsc(r.path.join(' \\ ')) + '">' + (r.path.length ? aitmEsc(r.path.join(' \\ ')) : (r.fp ? aitmEsc(im.fpRoot.name) : '—')) + '</td>'
          + '<td style="text-align:center;white-space:nowrap;">'
          + pill(!!r.fp, 'Flightplans.txt', r.fp ? r.fp.name + ' · ' + fmtD(r.fpDate) : 'No Flightplans_' + r.name + '.txt in ' + im.fpRoot.name)
          + pill(!!r.ac, 'Aircraft.txt', r.ac ? r.ac.name : 'No Aircraft_' + r.name + '.txt')
          + pill(!!r.bgl, 'BGL', r.bgl ? r.bgl.name + ' · ' + fmtD(r.bglDate) : 'Not in ' + tPath + (r.removed ? ' (a removed copy exists)' : ''))
          + '</td><td style="text-align:right;white-space:nowrap;padding-right:10px;">'
          + '<button class="aitm-imb" onclick="aitmImAct(\'o\',' + i + ')" title="Open in the AI Traffic Manager">Open</button>'
          + '<button class="aitm-imb t" onclick="aitmImAct(\'t\',' + i + ')" title="' + aitmEsc(tTip) + '"' + (canT ? '' : ' disabled') + '>Transfer to BGL</button>'
          + '<button class="aitm-imb r" onclick="aitmImAct(\'r\',' + i + ')" title="' + aitmEsc(rTip) + '"' + (r.bgl ? '' : ' disabled') + '>Remove from BGL</button>'
          + '</td></tr>';
      }).join('')
    + '</tbody></table></div>';
  aitmImFilter();
  sc = document.getElementById('aitm-im-scroll'); if (sc) sc.scrollTop = top;
}
function aitmImFilter() {
  var im = aitm.im; if (!im) return;
  var toks = String(aitm.imQ || '').toLowerCase().split(/\s+/).filter(Boolean), f = aitm.imF || 'all';
  document.querySelectorAll('.aitm-im-row').forEach(function (tr) {
    var r = im.rows[+tr.dataset.i]; if (!r) return;
    var okF = f === 'all' || (f === 'in' && r.bgl) || (f === 'out' && !r.bgl) || (f === 'notxt' && r.bgl && !r.fp);
    tr.style.display = okF && toks.every(function (t) { return tr.dataset.q.indexOf(t) >= 0; }) ? '' : 'none';
  });
}
function aitmImMsg(html, warn) {
  var el = document.getElementById('aitm-im-msg'); if (el) el.innerHTML = '<span style="color:' + (warn ? '#f0b400' : 'var(--txt2)') + ';">' + html + '</span>';
}
async function aitmImAct(act, i) {
  var im = aitm.im, r = im && im.rows[i]; if (!r) return;
  if (act === 'o') { aitmImOpen(i); return; }
  if (aitm.imBusy) return;
  if (!(await aitmPermOk(im.out, true))) { aitmImMsg('Chrome did not allow changes in “' + aitmEsc(im.out.name) + '”. Click again and allow it (“Save changes” / “Edit files”).', true); return; }
  aitm.imBusy = true;
  document.querySelectorAll('.aitm-imb').forEach(function (b) { b.disabled = true; });
  aitmImMsg(act === 't' ? (r.fp ? 'Compiling ' : 'Putting back ') + aitmEsc(r.name) + ' …' : 'Removing ' + aitmEsc(r.name) + ' …');
  await new Promise(function (res) { setTimeout(res, 20); });
  var res;
  try { res = act === 't' ? await aitmImTransfer(r, i) : await aitmImRemove(r); }
  catch (e) {
    var busy = e && /NoModificationAllowed|InvalidModification|InvalidState/.test(e.name);
    res = { warn: true, keep: true, html: aitmEsc(r.name) + ': ' + aitmEsc(e && e.message || e) + (busy ? ' — the file is probably in use: close the simulator and try again.' : '') };
  }
  aitm.imBusy = false;
  if (res.keep) aitmImRender(res); else await aitmImScan(res);
}
async function aitmImTransfer(r, i) {
  var im = aitm.im;
  if (r.fp) {
    if (!r.ac) throw new Error('Aircraft_' + r.name + '.txt is missing — without it the BGL would have no aircraft.');
    var fp = AITM_CODEC.parseFlightplansTxt(await aitmReadText(await r.fp.getFile()));
    var list = aitmAcList(AITM_CODEC.parseAircraftTxt(await aitmReadText(await r.ac.getFile())), fp.plans);
    var ap = aitmApWith(r.ap ? AITM_CODEC.parseAirportsTxt(await aitmReadText(await r.ap.getFile())) : {});
    var c = aitmCheckData({ ac: list, plans: fp.plans, ap: ap });
    if (fp.errors.length) c.errs.unshift(fp.errors.length + ' line(s) of the Flightplans file could not be read: ' + fp.errors.slice(0, 2).join('; '));
    if (c.errs.length) return { warn: true, keep: true, html: '<b>' + aitmEsc(r.name) + ' was not compiled</b> — ' + c.errs.length + ' error' + (c.errs.length > 1 ? 's' : '') + ': '
      + c.errs.slice(0, 3).map(aitmEsc).join(' · ') + (c.errs.length > 3 ? ' · …' : '') + ' — <a href="#" style="color:#58a6ff;" onclick="aitmImAct(\'o\',' + i + ');return false;">open it</a> to fix.' };
    var res = AITM_CODEC.writeBGL(aitmModelOf(list, fp.plans), ap, { halve: true, order: aitmOrderFor(list) });
    if (res.errors) throw new Error(res.errors.join('; '));
    var name = r.bgl ? r.bgl.name : r.removed ? r.removed.name.replace(/\.off$/i, '') : 'Traffic_' + r.name + '.bgl';
    await aitmWriteBgl(im.out, name, res.bytes, { ask: false });
    var notInst = c.warns.filter(function (w) { return /not among your installed/.test(w); }).length;
    return { html: '✓ <b>' + aitmEsc(name) + '</b> ' + (r.bgl ? 'compiled again and replaced (old one in Backups)' : 'compiled and put into the Traffic folder') + ' — ' + res.plans + ' flight plans, ' + res.aircraft + ' aircraft, ' + res.airports + ' airports.'
      + (notInst ? ' <span style="color:#f0b400;">⚠ ' + notInst + ' aircraft not installed — the simulator will not show them.</span>' : '') + ' Restart the simulator to see it.' };
  }
  if (r.removed && !r.bgl) {
    var nm = r.removed.name.replace(/\.off$/i, '');
    var bytes = await (await r.removed.getFile()).arrayBuffer();
    await aitmWriteBgl(im.out, nm, bytes, { ask: false });
    await (await im.out.getDirectoryHandle(AITM_REMOVED)).removeEntry(r.removed.name);
    return { html: '✓ <b>' + aitmEsc(nm) + '</b> is back in the Traffic folder. Restart the simulator to see it.' };
  }
  throw new Error('nothing to transfer.');
}
async function aitmImRemove(r) {
  var im = aitm.im; if (!r.bgl || !im.tdir) throw new Error('not in the Traffic folder.');
  var name = r.bgl.name, bytes = await (await r.bgl.getFile()).arrayBuffer();
  var rdir = await im.out.getDirectoryHandle(AITM_REMOVED, { create: true });
  var w = await (await rdir.getFileHandle(name + '.off', { create: true })).createWritable(); await w.write(bytes); await w.close();
  if ((await (await rdir.getFileHandle(name + '.off')).getFile()).size !== bytes.byteLength) throw new Error('the copy could not be written — nothing was removed.');
  await im.tdir.removeEntry(name);
  if (im.isPkg) await aitmLayoutSet(await im.out.getFileHandle('layout.json'), 'Scenery/World/Traffic/' + name, null);
  return { html: '✓ <b>' + aitmEsc(name) + '</b> taken out of the Traffic folder' + (im.isPkg ? ' and layout.json' : '') + ' — kept in ' + aitmEsc(im.out.name) + '\\' + AITM_REMOVED + ', Transfer to BGL puts it back. Restart the simulator.' };
}
async function aitmImOpen(i) {
  var r = aitm.im && aitm.im.rows[i]; if (!r) return;
  aitmCloseModal();
  if (r.fp) {
    await aitmLoadTxtHandles(r.fp, r.ac, r.ap);
    try { var sd = aitm.im.fpRoot; for (var k = 0; k < r.path.length; k++) sd = await sd.getDirectoryHandle(r.path[k]); aitm._srcDir = { h: sd, label: [aitm.im.fpRoot.name].concat(r.path).join(' \\ ') }; } catch (e) {}
    return;
  }
  var h = r.bgl || r.removed; if (!h) return;
  try { aitmLoadBgl(await (await h.getFile()).arrayBuffer(), h.name.replace(/\.off$/i, '')); } catch (e) { aitmToast(h.name + ': ' + e.message, true); }
}

if (typeof module !== 'undefined') module.exports.ui = { aitmTypeSig: aitmTypeSig, aitmSplitBase: aitmSplitBase, aitmCfgEntries: aitmCfgEntries };
