/**
 * 腾讯地图响应的解析与归一化 —— 服务端与浏览器共用
 *
 * 这些字段是实测出来的，改之前先看 README 里的说明：
 *   duration 单位是分钟、price 单位是分、线路名在 lines[].title、
 *   上下车站是 geton/getoff、polyline 是数字数组（首对绝对坐标 + /1e6 增量）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TmapNorm = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v, dflt = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  /**
   * duration → 分钟。
   * 腾讯 direction 接口返回的是分钟；这里加一层兜底：
   * 如果数值大到不可能是分钟（比 30m/s 还快），视为秒。
   */
  function toMinutes(raw, meters) {
    const n = num(raw);
    if (n <= 0) return 1;
    const m = num(meters);
    if (m > 0 && n > m / 30) return Math.max(1, Math.round(n / 60));
    return Math.max(1, Math.round(n));
  }

  /* ------------------------------------------------------------------ */
  /* 坐标串解压                                                          */
  /*   输入可能是数组 [lat,lng,dLat,dLng,...]，也可能是同格式字符串          */
  /*   前两个值是绝对坐标，之后每项都是相对往前第 2 个值的增量 / 1e6           */
  /* ------------------------------------------------------------------ */
  function inRange(p) {
    return p[0] > -90 && p[0] < 90 && p[1] > -180 && p[1] < 180;
  }

  function decodePolyline(val) {
    if (val == null) return null;

    let raw = null;
    if (Array.isArray(val)) {
      raw = val.map(Number);
    } else if (typeof val === 'string' && val.length > 3) {
      if (/^[-\d.;,\s]+$/.test(val.trim())) {
        raw = val.trim().split(/[;,\s]+/).map(Number);
      } else {
        return decodeBase64Polyline(val);
      }
    }
    if (!raw || raw.length < 4 || !raw.every(Number.isFinite)) return null;

    const nums = raw.slice();
    // 后项是整数 → 视为增量；否则视为已经是绝对坐标的平铺序列
    if (nums.slice(2).every((n) => Number.isInteger(n))) {
      for (let i = 2; i < nums.length; i++) nums[i] = nums[i - 2] + nums[i] / 1e6;
    }

    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    if (!pts.length || !pts.every(inRange)) return null;
    return pts;
  }

  function decodeBase64Polyline(str) {
    try {
      const out = [];
      let i = 0, lat = 0, lng = 0;
      while (i < str.length) {
        const readDelta = () => {
          let result = 0, shift = 0, b;
          do {
            if (i >= str.length) throw new Error('eof');
            b = str.charCodeAt(i++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
          } while (b >= 0x20);
          return result & 1 ? ~(result >> 1) : result >> 1;
        };
        lat += readDelta();
        lng += readDelta();
        out.push([lat / 1e6, lng / 1e6]);
      }
      return out.length && out.every(inRange) ? out : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* WMO 天气码 → 中文 + 是否适合户外                                     */
  /* ------------------------------------------------------------------ */
  function wmoText(code) {
    const map = [
      [[0], '晴', '☀️', 1],
      [[1, 2], '多云', '⛅', 1],
      [[3], '阴', '☁️', 1],
      [[45, 48], '有雾', '🌫', 0],
      [[51, 53, 55, 56, 57], '毛毛雨', '🌦', 0],
      [[61, 63, 65, 66, 67], '下雨', '🌧', 0],
      [[71, 73, 75, 77], '下雪', '🌨', 0],
      [[80, 81, 82], '阵雨', '🌦', 0],
      [[85, 86], '阵雪', '🌨', 0],
      [[95, 96, 99], '雷阵雨', '⛈', 0],
    ];
    for (const [codes, text, icon, indoor] of map) {
      if (codes.includes(code)) return { text, icon, indoor };
    }
    return { text: '未知', icon: '🌡', indoor: 1 };
  }

  /* ------------------------------------------------------------------ */
  /* 车辆类型                                                            */
  /* ------------------------------------------------------------------ */
  function vehicleFromRaw(raw, title) {
    const r = String(raw || '').toUpperCase();
    if (r.includes('SUBWAY') || r.includes('METRO')) return 'subway';
    if (r.includes('RAIL') || r.includes('TRAIN')) return 'rail';
    if (r.includes('FERRY')) return 'ferry';
    if (r.includes('BUS')) return 'bus';
    const n = String(title || '');
    if (/磁浮|磁悬浮/.test(n)) return 'maglev';
    if (/地铁|号线|轻轨|轨交/.test(n)) return 'subway';
    if (/城际|高铁|动车/.test(n)) return 'rail';
    if (/轮渡/.test(n)) return 'ferry';
    return 'bus';
  }

  function buildSummary(steps) {
    const rides = steps.filter((s) => s.type === 'ride');
    if (!rides.length) {
      const wm = steps.reduce((a, s) => a + (s.meters || 0), 0);
      return `全程步行 ${wm} 米`;
    }
    return rides.map((r) => r.line).join(' → ');
  }

  /* ------------------------------------------------------------------ */
  /* 公交方案 → 统一 Leg                                                 */
  /* ------------------------------------------------------------------ */
  function normalizeTransitRoute(route) {
    const steps = [];
    const polylines = [];
    let walkMeters = 0;
    let walkMinutes = 0;
    let rideMinutes = 0;
    let rides = 0;

    for (const s of route.steps || []) {
      const mode = String(s.mode || '').toUpperCase();
      const dist = num(s.distance);

      if (mode === 'WALKING' || mode === 'WALK') {
        const mins = toMinutes(s.duration, dist);
        walkMeters += dist;
        walkMinutes += mins;
        const pl = decodePolyline(s.polyline);
        if (pl) polylines.push(pl);
        steps.push({
          type: 'walk',
          minutes: mins,
          meters: Math.round(dist),
          direction: s.direction || '',
          polyline: pl,
        });
        continue;
      }

      if (mode !== 'TRANSIT') continue;

      const line = (s.lines || [])[0] || {};
      const geton = line.geton || line.start_station || {};
      const getoff = line.getoff || line.end_station || {};
      const segMinutes = toMinutes(line.duration, line.distance);
      const lineTitle = line.title || line.line_name || '公交线路';
      rideMinutes += segMinutes;
      rides += 1;

      const pl = decodePolyline(line.polyline) || decodePolyline(s.polyline);
      if (pl) polylines.push(pl);

      steps.push({
        type: 'ride',
        line: lineTitle,
        vehicle: vehicleFromRaw(line.vehicle, lineTitle),
        direction: line.destination?.title || line.direction || '',
        stops: line.station_count != null ? num(line.station_count) : null,
        minutes: segMinutes,
        meters: Math.round(num(line.distance)),
        from: geton.title || '',
        fromExit: geton.exit?.title || '',
        fromLat: geton.location?.lat,
        fromLng: geton.location?.lng,
        to: getoff.title || '',
        toExit: getoff.exit?.title || '',
        toLat: getoff.location?.lat,
        toLng: getoff.location?.lng,
        firstTrain: line.start_time || '',
        lastTrain: line.end_time || '',
        polyline: pl,
        alternatives: (s.lines || []).slice(1, 4).map((l) => ({
          line: l.title || '',
          minutes: toMinutes(l.duration, l.distance),
        })),
      });
    }

    // 整条方案的 polyline 由各段拼起来
    let polyline = null;
    if (polylines.length) {
      polyline = [];
      for (const seg of polylines) {
        if (polyline.length && seg.length) {
          const last = polyline[polyline.length - 1];
          // 段间接缝差太远就断开，避免画出穿墙直线
          const gap = Math.abs(seg[0][0] - last[0]) + Math.abs(seg[0][1] - last[1]);
          if (gap > 0.02) polyline.push(null);
        }
        for (const p of seg) polyline.push(p);
      }
      polyline = polyline.filter(Boolean);
    }

    const priceRaw = num(route.price, -1);
    const fare = priceRaw >= 0 ? Math.round(priceRaw) / 100 : null;

    const totalMinutes = toMinutes(route.duration, route.distance);

    return {
      mode: 'transit',
      minutes: totalMinutes,
      meters: Math.round(num(route.distance)),
      fare,
      transfers: Math.max(0, rides - 1),
      walkMeters: Math.round(walkMeters),
      walkMinutes,
      rideMinutes,
      rides,
      steps,
      polyline,
      summary: buildSummary(steps),
      real: true,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 步行 / 驾车 → 统一 Leg                                              */
  /* ------------------------------------------------------------------ */
  function normalizeSimpleRoute(route, mode) {
    const type = mode === 'walking' ? 'walk' : 'drive';
    const totalDist = num(route.distance) || 1;
    const totalMin = toMinutes(route.duration, totalDist);
    const steps = [];

    for (const s of route.steps || []) {
      const d = num(s.distance);
      steps.push({
        type,
        minutes: Math.max(1, Math.round(totalMin * (d / totalDist))),
        meters: Math.round(d),
        instruction: s.instruction || '',
        road: s.road_name || '',
        turn: s.act_desc || s.dir_desc || '',
      });
    }
    if (!steps.length) {
      steps.push({
        type,
        minutes: totalMin,
        meters: Math.round(totalDist),
        instruction: '',
        road: '',
        turn: '',
      });
    }

    const polyline = decodePolyline(route.polyline) || null;

    return {
      mode,
      minutes: totalMin,
      meters: Math.round(totalDist),
      fare: null,
      transfers: 0,
      walkMeters: mode === 'walking' ? Math.round(totalDist) : 0,
      walkMinutes: mode === 'walking' ? totalMin : 0,
      rideMinutes: mode === 'walking' ? 0 : totalMin,
      rides: 0,
      steps,
      polyline,
      summary: mode === 'walking'
        ? `步行 ${Math.round(totalDist)} 米`
        : `驾车 ${(totalDist / 1000).toFixed(1)} 公里`,
      real: true,
    };
  }


  return {
    num, toMinutes, inRange, decodePolyline, decodeBase64Polyline,
    wmoText, vehicleFromRaw, buildSummary,
    normalizeTransitRoute, normalizeSimpleRoute,
  };
});
