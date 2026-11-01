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
  'B38M':'Boeing 737 MAX 8','B39M':'Boeing 737 MAX 9','B3XM':'Boeing 737 MAX 10','B741':'Boeing 747-100','B742':'Boeing 747-200',
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
  'L410':'Let L-410','SH36':'Shorts 360','J328':'Dornier 328JET','D328':'Dornier 328','IL18':'Ilyushin Il-18','CVLT':'Convair 990'
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

// recognise an aircraft type in a title, ui_type or schedule code -> ICAO designator ('' = unknown)
function aitmTypeSig(text) {
  var s = String(text || '').toUpperCase();
  if (!s) return '';
  if (AITM_TYPES[s]) return s;
  if (AITM_IATA_EQP[s]) return AITM_IATA_EQP[s];
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
// AC list from the Aircraft file entries, plus empty ones for numbers the flight plans use but the file lacks
function aitmAcList(acs, plans, extra) {
  var by = {};
  acs.forEach(function (a) { by[a.n] = { n: a.n, title: a.title, speed: a.speed }; });
  plans.forEach(function (p) { if (!by[p.ac]) by[p.ac] = { n: p.ac, title: 'AC#' + p.ac, speed: 0 }; });
  return Object.keys(by).map(Number).sort(function (x, y) { return x - y; }).map(function (k) { return extra ? extra(by[k]) : by[k]; });
}
function aitmEsc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function aitmSave() {
  clearTimeout(aitm._saveT);
  aitm._saveT = setTimeout(function () {
    try {
      localStorage.setItem(AITM_KEY, JSON.stringify({ kind: aitm.kind || 'airline', apIcao: aitm.apIcao || '', name: aitm.name, code: aitm.code, period: aitm.period, fileBase: aitm.fileBase,
        source: aitm.source, ac: aitm.ac, plans: aitm.plans, apx: aitm.apx, tmode: aitm.tmode, outName: aitm.outName || '' }));
    } catch (e) {}
  }, 300);
}
function aitmRestore() {
  try {
    var s = JSON.parse(localStorage.getItem(AITM_KEY) || 'null');
    if (!s) return;
    ['kind', 'apIcao', 'name', 'code', 'period', 'fileBase', 'source', 'ac', 'plans', 'apx', 'tmode', 'outName'].forEach(function (k) { if (s[k] != null) aitm[k] = s[k]; });
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
function aitmAp(icao) {
  var r = (typeof lookupAirport === 'function') ? lookupAirport(String(icao || '')) : null;
  if (r && r[0] !== String(icao).toUpperCase()) r = null;
  var x = aitm.apx[String(icao || '').toUpperCase()];
  if (r) return { lat: r[3], lon: r[4], altFt: x ? x.altFt : 0, city: r[7] || r[2] || '', name: r[2] || '', row: r };
  if (x) return { lat: x.lat, lon: x.lon, altFt: x.altFt || 0, city: '', name: '', row: null };
  return null;
}
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
  if (/^[A-Z]{3}/.test(pc)) return pc.slice(0, 3);
  var t = String(title || '').trim().split(/\s+/);
  for (var i = t.length - 1; i >= 0; i--) if (/^[A-Z]{3}$/.test(t[i]) && !AITM_TYPES[t[i]]) return t[i];
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
    aitmToast(root + ': ' + ncfg + ' aircraft.cfg, ' + entries.length + ' liveries read' + (errs.length ? ' · ' + errs.length + ' could not be read' : '') + '.', !ncfg || errs.length > 0);
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
  var m = /^AIGAIM_([A-Z0-9]{2,3})\s+\S+\s+NCv2$/.exec(t);           // planner placeholder
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
  aitm.ac = d.aircraft; aitm.plans = d.plans; aitm.apx = d.apx || {};
  aitmNormAc();
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
  var known = null, path = null;
  for (var i = 0; i < dirs.length && !known; i++) { try { path = await dirs[i].resolve(anyH); if (path) known = dirs[i]; } catch (e) {} }
  var go = async function (dir) {
    var sib = await aitmSiblings(dir, path || (await dir.resolve(anyH)) || [anyH.name], ['flightplans' + suffix.toLowerCase(), 'aircraft' + suffix.toLowerCase(), 'airports' + suffix.toLowerCase()]);
    var f = fpH || sib[0];
    if (!f) { aitmToast('Flightplans' + suffix + ' not found next to ' + anyH.name + '.', true); return; }
    aitmLoadTxtHandles(f, acH || sib[1], apH || sib[2]);
  };
  if (known && (await known.queryPermission({ mode: 'read' })) === 'granted') { await go(known); return; }
  aitmModal('Find the Aircraft and Airports files',
    '<div style="font-size:12px;color:var(--txt2);line-height:1.6;">The page takes <b>Flightplans' + aitmEsc(suffix) + '</b>, <b>Aircraft' + aitmEsc(suffix) + '</b> and <b>Airports' + aitmEsc(suffix) + '</b> from the folder of <b>' + aitmEsc(anyH.name) + '</b>.<br>'
    + (known ? 'Chrome needs your OK to look into “' + aitmEsc(known.name) + '” again.' : 'Allow it once for this folder: click the button and confirm the folder Chrome shows (it is already selected).') + '</div>',
    [[known ? 'Allow' : 'Choose folder…', async function () {
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
    try {
      var d = AITM_CODEC.readBGL(await f.arrayBuffer());
      var sb = aitmSplitBase(f.name);
      aitmLoad({ aircraft: d.aircraft.map(function (a, i) { return { n: i + 1, title: a.title, speed: a.speed }; }), plans: d.plans, apx: d.airports,
                 base: sb.base, name: sb.name, period: sb.period, source: f.name });
      aitm.outName = f.name; aitmSave(); aitmRenderBottom();
    } catch (e) { aitmToast(f.name + ': ' + e.message, true); }
  };
  inp.click();
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
    });
    aitmKvSet('acFolders', []);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') aitmCloseModal(); });
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
    + '<div style="display:flex;border:1px solid var(--bdr2);border-radius:6px;overflow:hidden;">'
    + [['utc', 'UTC'], ['today', 'Local today'], ['eusummer', 'Local EU summer']].map(function (m) {
        var on = aitm.tmode === m[0];
        return '<button onclick="aitmSetTmode(\'' + m[0] + '\')" style="font-size:12px;font-weight:600;padding:6px 12px;border:none;border-right:1px solid var(--bdr2);background:' + (on ? 'var(--acc)' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--txt2)') + ';cursor:pointer;">' + m[1] + '</button>';
      }).join('') + '</div>';
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
function aitmRenderAirports() {
  var el = document.getElementById('aitm-aps'); if (!el) return;
  var list = aitmUsedAirports();
  var c = document.getElementById('aitm-aps-count'); if (c) c.textContent = list.length ? list.length : '';
  el.innerHTML = list.map(function (icao) {
    var a = aitmAp(icao), o = aitmOffset(icao);
    var bad = !a;
    return '<div class="aitm-ap" title="' + aitmEsc(a ? (a.name || '') : 'Unknown airport — no coordinates, cannot be compiled') + '">'
      + '<span style="font-family:monospace;font-weight:700;color:' + (bad ? '#f85149' : '#fff') + ';width:44px;">' + aitmEsc(icao) + '</span>'
      + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--txt2);">' + aitmEsc(a ? (a.city || a.name) : 'unknown') + '</span>'
      + '<span style="font-family:monospace;color:var(--txt2);">' + (a ? aitmFmtOff(o) : '') + '</span></div>';
  }).join('');
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
      + '<span style="display:block;font-size:10px;color:var(--txt3);">' + aitmEsc(aitmAcTypeName(a) || a.hint || '') + (a.speed ? ' · ' + a.speed + ' kts' : '') + ' · ' + (use[a.n] || 0) + ' FP</span></span></div>';
  }).join('') || '<div style="padding:12px;color:var(--txt3);font-size:12px;">—</div>';
}
function aitmFleetMatches(q) {
  var toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return aitm.fleet.filter(function (e) {
    if (!toks.length) return true;
    var hay = (e.title + ' ' + e.uiType + ' ' + e.uiVar + ' ' + e.airline + ' ' + e.sig + ' ' + e.icaoType + ' ' + e.codes + ' ' + e.folder + ' ' + e.atcAirline + ' ' + aitmTypeName(e.sig)).toLowerCase();
    return toks.every(function (t) { return hay.indexOf(t) >= 0; });
  });
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
  var hits = aitmFleetMatches(q);
  // the best fitting livery for each AC# first, in AC# order — select them all and drag them over at once
  var best = aitmBestMatches(), top = [], seen = {};
  best.forEach(function (e, i) { if (e && !seen[e.i]) { seen[e.i] = 1; top.push({ e: e, ac: aitm.ac[i].n }); } });
  var rest = hits.filter(function (e) { return !seen[e.i]; }).sort(function (a, b) { return (a.sig || 'ZZZ').localeCompare(b.sig || 'ZZZ') || a.title.localeCompare(b.title); });
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
  }).join('') || '<div style="padding:12px;color:var(--txt3);font-size:12px;">Nothing matches “' + aitmEsc(q) + '”.</div>';
  if (st) st.textContent = hits.length + ' of ' + aitm.fleet.length + (hits.length > shown.length ? ' (first ' + shown.length + ' shown)' : '') + (aitm.fleetSel.length ? ' · ' + aitm.fleetSel.length + ' selected' : '');
}
function aitmRenderBottom() {
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
  aitmSave(); aitmRenderAircraft(); aitmRenderLegs(); aitmRenderFleet();
  aitmToast(done.length === 1 ? 'AC#' + done[0] + ' replaced.' : done.length + ' aircraft replaced: AC#' + done.sort(function (a, b) { return a - b; }).join(', #') + '.');
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

// ── modal ──
function aitmModal(title, body, buttons, wide) {
  aitmCloseModal();
  var pop = document.createElement('div'); pop.id = 'aitm-modal';
  pop.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
  pop.addEventListener('mousedown', function (e) { if (e.target === pop) aitmCloseModal(); });
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--surf);border:1px solid var(--bdr2);border-radius:12px;padding:18px 22px;min-width:340px;max-width:' + (wide ? '900px' : '520px') + ';width:' + (wide ? '90vw' : 'auto') + ';box-shadow:0 8px 32px rgba(0,0,0,.6);';
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
function aitmCloseModal() { var p = document.getElementById('aitm-modal'); if (p) p.remove(); }
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

// ── move airports ──
function aitmMoveAirports() {
  if (!aitm.plans.length) return;
  var opts = aitm.ac.map(function (a) { return '<option value="' + a.n + '">AC#' + a.n + ' · ' + aitmEsc(a.title) + '</option>'; }).join('');
  var nSel = aitm.sel.length;
  aitmModal('Move airports',
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:12px;color:var(--txt2);">'
    + '<span>Replace</span><input id="aitm-mv-from" class="aitm-in" style="width:90px;text-transform:uppercase;" placeholder="KJFK">'
    + '<span>by</span><input id="aitm-mv-to" class="aitm-in" style="width:90px;text-transform:uppercase;" placeholder="KLGA">'
    + '<span>in</span><div style="display:flex;flex-direction:column;gap:5px;">'
    + '<label><input type="radio" name="aitm-mv-scope" value="all" checked> all flight plans</label>'
    + '<label><input type="radio" name="aitm-mv-scope" value="ac"> all flight plans of <select id="aitm-mv-ac" class="aitm-in" style="max-width:300px;">' + opts + '</select></label>'
    + '<label' + (nSel ? '' : ' style="opacity:.45;"') + '><input type="radio" name="aitm-mv-scope" value="sel"' + (nSel ? '' : ' disabled') + '> the ' + nSel + ' selected flight plan' + (nSel === 1 ? '' : 's') + ' (click lines in Legs to select)</label>'
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
      aitmToast(n ? from + ' → ' + to + ': ' + n + ' leg' + (n === 1 ? '' : 's') + ' in ' + np + ' flight plan' + (np === 1 ? '' : 's') + ' changed.' : from + ' was not found.', !n);
    }]]);
  document.getElementById('aitm-mv-from').focus();
}

// ── checks + compile ──
function aitmCheck() {
  var errs = [], warns = [];
  if (!aitm.plans.length) errs.push('No flight plan loaded.');
  var missingAp = aitmUsedAirports().filter(function (c) { return !aitmAp(c); });
  if (missingAp.length) errs.push('Unknown airport' + (missingAp.length > 1 ? 's' : '') + ' (no coordinates): ' + missingAp.join(', ') + ' — use Move airports, or load the Airports_….txt with the flight plans.');
  aitm.plans.forEach(function (p) {
    if (!aitmAcByN(p.ac)) errs.push(p.reg + ': AC#' + p.ac + ' does not exist.');
    if (String(p.reg).length > 7) warns.push(p.reg + ': registration longer than 7 characters is cut to ' + String(p.reg).slice(0, 7) + '.');
    var P = AITM_CODEC.periodOf(p.period)[1];
    p.legs.forEach(function (l, j) {
      if (l.dep == null) errs.push(p.reg + ' leg ' + (j + 1) + ': no departure time.');
      if (l.arr == null) errs.push(p.reg + ' leg ' + (j + 1) + ': no arrival time.');
      if (parseInt(l.fnum, 10) > 16383) errs.push(p.reg + ' leg ' + (j + 1) + ': flight number ' + l.fnum + ' is too high (max. 16383).');
      if (l.alt > 1023) errs.push(p.reg + ' leg ' + (j + 1) + ': altitude ' + l.alt + ' is too high.');
      var nx = p.legs[(j + 1) % p.legs.length];
      if (p.legs.length > 1 && l.arr != null && nx.dep != null) {
        var gap = ((nx.dep - l.arr) % P + P) % P;
        if (gap < 10) warns.push(p.reg + ': only ' + gap + ' min on the ground at ' + l.to + ' (leg ' + (j + 1) + ' → ' + ((j + 1) % p.legs.length + 1) + ').');
      }
    });
  });
  var use = {}; aitm.plans.forEach(function (p) { use[p.ac] = 1; });
  aitm.ac.forEach(function (a, i) {
    if (!use[a.n]) return;
    if (aitm.fleet.length && !aitmInstalled(a.title)) warns.push('AC#' + a.n + ' “' + a.title + '” is not among your installed aircraft — the simulator will not show it.');
    if (!a.speed) warns.push('AC#' + a.n + ': no cruise speed — 450 kts is used.');
  });
  return { errs: errs, warns: warns };
}
function aitmShowCheck() {
  var c = aitmCheck();
  var li = function (arr, col) { return arr.slice(0, 60).map(function (x) { return '<div style="padding:3px 0;border-bottom:1px solid var(--bdr);color:' + col + ';">' + aitmEsc(x) + '</div>'; }).join('') + (arr.length > 60 ? '<div style="color:var(--txt3);">… ' + (arr.length - 60) + ' more</div>' : ''); };
  aitmModal('Check',
    '<div style="max-height:60vh;overflow:auto;font-size:12px;">'
    + (c.errs.length ? '<div style="font-weight:700;color:#f85149;margin:4px 0;">' + c.errs.length + ' error' + (c.errs.length > 1 ? 's' : '') + ' — cannot compile</div>' + li(c.errs, '#ffb4ab') : '<div style="color:#3fb950;font-weight:700;margin:4px 0;">No errors — ready to compile.</div>')
    + (c.warns.length ? '<div style="font-weight:700;color:#f0b400;margin:10px 0 4px;">' + c.warns.length + ' warning' + (c.warns.length > 1 ? 's' : '') + '</div>' + li(c.warns, 'var(--txt2)') : '')
    + '</div>', [], true);
}
function aitmModel() {
  var arr = []; aitm.ac.forEach(function (a) { arr[a.n - 1] = { title: a.title, speed: a.speed || 450 }; });
  return { aircraft: arr, plans: aitm.plans };
}
// bigger aircraft first — the simulator hands out parking first come, first served
function aitmOrder(plans) {
  var wing = function (p) { var a = aitmAcByN(p.ac); if (!a) return 0; var e = aitmInstalled(a.title); return (e && e.wing) || a.wing || 0; };
  return plans.map(function (p, i) { return { p: p, i: i, w: wing(p) }; }).sort(function (x, y) { return (y.w - x.w) || (x.i - y.i); }).map(function (x) { return x.p; });
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
  var c = aitmCheck();
  if (c.errs.length) { aitmShowCheck(); return; }
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
      return;
    } catch (e) { aitmToast('Could not write into ' + dir.name + ': ' + e.message + ' — downloading instead.', true); }
  }
  aitmDownload(res.bytes, name, 'application/octet-stream');
  aitmToast('✓ ' + name + ' downloaded (' + info + ').');
}
// package root (has layout.json): write Scenery/World/Traffic/<name> and update layout.json; else write into the folder
async function aitmWriteBgl(dir, name, bytes) {
  var hasLayout = false, layoutH = null;
  try { layoutH = await dir.getFileHandle('layout.json'); hasLayout = true; } catch (e) {}
  var target = dir, rel = name;
  if (hasLayout) {
    target = await (await (await dir.getDirectoryHandle('Scenery', { create: true })).getDirectoryHandle('World', { create: true })).getDirectoryHandle('Traffic', { create: true });
    rel = 'Scenery/World/Traffic/' + name;
  }
  var exists = null; try { exists = await target.getFileHandle(name); } catch (e) {}
  if (exists) {
    if (!confirm(name + ' already exists in ' + (hasLayout ? dir.name + '\\Scenery\\World\\Traffic' : dir.name) + '.\n\nReplace it? (A copy of the old file is kept in the Backups folder.)')) throw new Error('cancelled');
    var bdir = await dir.getDirectoryHandle('Backups', { create: true });
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    var old = await (await exists.getFile()).arrayBuffer();
    var bw = await (await bdir.getFileHandle(name.replace(/\.bgl$/i, '') + '_' + stamp + '.bgl', { create: true })).createWritable();
    await bw.write(old); await bw.close();
  }
  var fh = await target.getFileHandle(name, { create: true });
  var w = await fh.createWritable(); await w.write(bytes); await w.close();
  if (hasLayout) {
    var raw = (await (await layoutH.getFile()).text()).replace(/^\uFEFF/, '');
    var lay = JSON.parse(raw.replace(/("date"\s*:\s*)(\d+)/g, '$1"$2"'));
    var f = await fh.getFile();
    var ticks = ((BigInt(f.lastModified) + BigInt(11644473600000)) * BigInt(10000)).toString();
    var content = lay.content || [], hit = false;
    content.forEach(function (x) { if (x.path === rel) { x.size = f.size; x.date = ticks; hit = true; } });
    if (!hit) content.push({ path: rel, size: f.size, date: ticks });
    lay.content = content;
    var txt = JSON.stringify(lay, null, 2).replace(/("date": )"(\d+)"/g, '$1$2');
    var lw = await layoutH.createWritable(); await lw.write(txt); await lw.close();
    return dir.name + '\\Scenery\\World\\Traffic (layout.json updated)';
  }
  return dir.name;
}
function aitmDownload(data, name, type) {
  var url = URL.createObjectURL(new Blob([data], { type: type || 'text/plain' }));
  var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
}
async function aitmSaveTxt() {
  if (!aitm.plans.length) return;
  var base = (aitm.outName || 'Traffic_CRE_Airline.bgl').replace(/\.bgl$/i, '').replace(/^Traffic_/i, '');
  var files = [
    ['Aircraft_' + base + '.txt', AITM_CODEC.aircraftToTxt(aitm.ac) + '\n'],
    ['Flightplans_' + base + '.txt', '//FSXDAYS=False\n' + aitm.plans.map(AITM_CODEC.planToTxt).join('\n') + '\n'],
    ['Airports_' + base + '.txt', AITM_CODEC.airportsToTxt(aitmUsedAirports(), function (c) { return aitmAp(c); }) + '\n']
  ];
  var dir = await aitmKvGet('txtFolder');
  if (!dir && window.showDirectoryPicker) {
    try { dir = await window.showDirectoryPicker({ id: 'aitm-txt', mode: 'readwrite' }); await aitmKvSet('txtFolder', dir); } catch (e) { dir = null; }
  }
  if (dir && (await aitmPermOk(dir, true))) {
    for (var i = 0; i < files.length; i++) {
      var w = await (await dir.getFileHandle(files[i][0], { create: true })).createWritable();
      await w.write(new Blob([files[i][1]], { type: 'text/plain' })); await w.close();
    }
    aitmToast('✓ ' + files.map(function (f) { return f[0]; }).join(', ') + ' saved in ' + dir.name + '.');
    return;
  }
  files.forEach(function (f, k) { setTimeout(function () { aitmDownload(f[1], f[0]); }, k * 400); });
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
    + 'Chrome hides *.cfg files from folder access, so these folders are read with the browser’s folder upload (Chrome calls it “upload”, but nothing leaves your PC). Read a folder again after installing new aircraft.</div>'
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
  aitmModal('Installation Manager', '<div id="aitm-im" style="font-size:12px;color:var(--txt2);">Reading the folders …</div>', [], true);
  // flight plans (with their Aircraft_ and Airports_ files), grouped by folder + name
  var plans = {};
  async function walk(d, path, depth) {
    for await (var e of d.values()) {
      if (e.kind === 'directory') { if (depth > 0) await walk(e, path.concat([e.name]), depth - 1); continue; }
      var m = /^(flightplans|aircraft|airports)_(.+)\.txt$/i.exec(e.name); if (!m) continue;
      var key = path.join('/') + '|' + m[2].toLowerCase();
      var x = plans[key] = plans[key] || { name: m[2], path: path.slice(), fp: null, ac: null, ap: null };
      x[{ flightplans: 'fp', aircraft: 'ac', airports: 'ap' }[m[1].toLowerCase()]] = e;
    }
  }
  await walk(fpRoot, [], 4);
  // traffic BGLs
  var tdir = out, bgls = {};
  try { await out.getFileHandle('layout.json'); tdir = await (await (await out.getDirectoryHandle('Scenery')).getDirectoryHandle('World')).getDirectoryHandle('Traffic'); } catch (e) {}
  for await (var b of tdir.values()) if (b.kind === 'file' && /\.bgl$/i.test(b.name)) bgls[b.name.toLowerCase()] = b;
  var norm = function (t) { return String(t).toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var bglNorm = {}; Object.keys(bgls).forEach(function (k) { bglNorm[norm(k.replace(/^traffic_/, '').replace(/\.bgl$/, ''))] = bgls[k]; });
  var rows = Object.keys(plans).map(function (k) { return plans[k]; }).filter(function (x) { return x.fp; });
  var used = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    r.bgl = bgls[('traffic_' + r.name + '.bgl').toLowerCase()] || bglNorm[norm(r.name)] || null;
    if (r.bgl) used[r.bgl.name.toLowerCase()] = 1;
    r.fpDate = (await r.fp.getFile()).lastModified;
    r.bglDate = r.bgl ? (await r.bgl.getFile()).lastModified : 0;
  }
  rows.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
  var lone = Object.keys(bgls).filter(function (k) { return !used[k]; }).map(function (k) { return bgls[k].name; }).sort();
  aitm.imRows = rows;
  var fmtD = function (t) { return t ? new Date(t).toLocaleDateString() : ''; };
  var tick = function (on, tip) { return on ? '<span style="color:#3fb950;font-weight:700;font-size:14px;" title="' + aitmEsc(tip || '') + '">✓</span>' : '<span style="color:var(--txt3);">—</span>'; };
  var nInst = rows.filter(function (r) { return r.bgl; }).length;
  var el = document.getElementById('aitm-im'); if (!el) return;
  el.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">'
    + '<span>Flight plans in <b style="color:#fff;">' + aitmEsc(fpRoot.name) + '</b>: ' + rows.length + ' · installed in <b style="color:#fff;">' + aitmEsc(out.name) + '</b>: <b style="color:#3fb950;">' + nInst + '</b></span>'
    + '<input id="aitm-im-q" class="aitm-in" placeholder="🔍 filter" style="margin-left:auto;width:200px;padding:3px 8px;" oninput="aitmImFilter(this.value)">'
    + '<button class="aitm-btn" style="padding:3px 10px;" onclick="aitmKvSet(\'fpRoot\', null).then(function(){aitmInstallManager();})">Other folders…</button></div>'
    + '<div style="max-height:62vh;overflow:auto;border:1px solid var(--bdr);border-radius:8px;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
    + '<thead><tr style="position:sticky;top:0;background:var(--surf2);color:var(--txt3);text-align:left;">'
    + '<th style="padding:6px 10px;">Flight plan</th><th style="padding:6px;">Folder</th><th style="padding:6px;text-align:center;">Aircraft</th><th style="padding:6px;text-align:center;">Airports</th>'
    + '<th style="padding:6px;text-align:center;">BGL installed</th><th style="padding:6px;">Note</th><th></th></tr></thead><tbody>'
    + rows.map(function (r, i) {
        var stale = r.bgl && r.fpDate > r.bglDate + 60000;
        return '<tr class="aitm-im-row" data-q="' + aitmEsc((r.name + ' ' + r.path.join(' ')).toLowerCase()) + '" style="border-top:1px solid var(--bdr);">'
          + '<td style="padding:5px 10px;color:#fff;font-weight:600;">' + aitmEsc(r.name) + '</td>'
          + '<td style="padding:5px 6px;color:var(--txt3);">' + aitmEsc(r.path.join(' \\ ')) + '</td>'
          + '<td style="text-align:center;">' + tick(!!r.ac, r.ac && r.ac.name) + '</td><td style="text-align:center;">' + tick(!!r.ap, r.ap && r.ap.name) + '</td>'
          + '<td style="text-align:center;">' + tick(!!r.bgl, r.bgl ? r.bgl.name + ' · ' + fmtD(r.bglDate) : '') + '</td>'
          + '<td style="padding:5px 6px;color:#f0b400;">' + (stale ? 'flight plan newer than the BGL (' + fmtD(r.fpDate) + ' / ' + fmtD(r.bglDate) + ')' : (r.bgl && r.bgl.name.toLowerCase() !== ('traffic_' + r.name + '.bgl').toLowerCase() ? '<span style="color:var(--txt3);">' + aitmEsc(r.bgl.name) + '</span>' : '')) + '</td>'
          + '<td style="padding:4px 8px;text-align:right;"><button class="aitm-btn" style="padding:2px 10px;font-size:11px;" onclick="aitmImOpen(' + i + ')">Open</button></td></tr>';
      }).join('')
    + '</tbody></table></div>'
    + (lone.length ? '<details style="margin-top:8px;"><summary style="cursor:pointer;color:var(--txt3);">' + lone.length + ' BGL file' + (lone.length === 1 ? '' : 's') + ' in the Traffic folder without a flight plan in ' + aitmEsc(fpRoot.name) + '</summary>'
      + '<div style="columns:2;margin-top:6px;color:var(--txt2);font-family:monospace;font-size:11px;">' + lone.map(aitmEsc).join('<br>') + '</div></details>' : '');
}
function aitmImFilter(q) {
  var toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  document.querySelectorAll('.aitm-im-row').forEach(function (tr) { var h = tr.dataset.q; tr.style.display = toks.every(function (t) { return h.indexOf(t) >= 0; }) ? '' : 'none'; });
}
function aitmImOpen(i) {
  var r = aitm.imRows && aitm.imRows[i]; if (!r) return;
  aitmCloseModal(); aitmLoadTxtHandles(r.fp, r.ac, r.ap);
}

if (typeof module !== 'undefined') module.exports.ui = { aitmTypeSig: aitmTypeSig, aitmSplitBase: aitmSplitBase, aitmCfgEntries: aitmCfgEntries };
