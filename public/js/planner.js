/**
 * 规划引擎
 *
 * 流程：
 *   1. 分天：锁定日优先 → 最远点采样选每天的"区域锚" → 其余点就近归组
 *   2. 均衡：某天超时就往最空闲的一天搬点，直到不超时或无可搬
 *   3. 排序：最近邻 + 2-opt（含住处往返）
 *   4. 排程：逐段累加时间，处理等景点、午餐、时间窗、超时
 *   5. 真实代价替换后重排（由 app 层驱动）
 */
(function (global) {
  'use strict';

  /* ---------------- 单段耗时估算（无 Key 时的兜底模型） ---------------- */
  const DETOUR = 1.28;          // 路网绕行系数
  const WALK_KMH = 4.3;         // 步行速度
  const TRANSIT_KMH = 26;       // 地铁/公交平均旅行速度（含停站）
  const TAXI_KMH = 24;          // 市内驾车平均速度

  function toLeg(mode, minutes, meters, extra) {
    return Object.assign({
      mode, minutes: Math.max(1, Math.round(minutes)),
      meters: Math.round(meters), est: true,
      transfers: 0, fare: null, walkMeters: mode === 'walking' ? Math.round(meters) : 0,
      walkMinutes: mode === 'walking' ? Math.max(1, Math.round(minutes)) : 0,
      steps: null,
    }, extra || {});
  }

  function estimateLeg(a, b, pref) {
    const straight = U.haversine(a, b);
    const road = straight * DETOUR;

    if (pref === 'WALK_ONLY') {
      return toLeg('walking', 1 + road / 1000 / WALK_KMH * 60, road);
    }
    if (pref === 'TAXI') {
      return toLeg('taxi', 5 + road / 1000 / TAXI_KMH * 60, road);
    }
    // 近到不值得坐车就走路
    if (road <= 900) {
      return toLeg('walking', 1 + road / 1000 / WALK_KMH * 60, road);
    }
    // 公共交通：进站 + 候车 + 乘车 + 出站
    const inVehicle = Math.max(0, road - 800) / 1000;
    const minutes = 7 + 4.5 + inVehicle / TRANSIT_KMH * 60 + 5;
    return toLeg('transit', minutes, road, {
      walkMeters: 800,
      walkMinutes: 11,
      note: '估算：站点与班次需配置 Key 后获取',
    });
  }

  /* ---------------- 节奏与兴趣 ---------------- */
  const INTEREST_MAP = {
    美食: ['餐饮'],
    自然: ['景点'],
    人文: ['博物馆', '景点'],
    购物: ['购物'],
    亲子: ['景点', '博物馆'],
    夜生活: ['餐饮', '购物'],
    摄影: ['景点', '博物馆'],
  };

  function interestScore(place, interests) {
    if (!interests || !interests.length) return 0.5;
    let best = 0;
    for (const it of interests) {
      const cats = INTEREST_MAP[it] || [];
      if (cats.indexOf(place.category) >= 0) best = 1;
    }
    return best;
  }

  /* 节奏只改每天结束时间，不改停留时长——藏时间是最容易让人踩坑的做法 */
  function paceShift(pace) {
    if (pace === 'relaxed') return -60;
    if (pace === 'packed') return 45;
    return 0;
  }

  function normalizeTrip(trip) {
    const t = Object.assign({}, trip);
    const shift = t.paceShift != null ? t.paceShift : paceShift(t.pace);
    t.dayEnd = t.dayEnd + shift;
    t.days = Math.max(1, Math.min(14, t.days || 1));
    // 未显式关闭就当作开启，避免调用方漏传导致整天没有饭点
    t.lunchOn = t.lunchOn !== false;
    t.dinnerOn = t.dinnerOn !== false;
    return t;
  }

  /* ---------------- 排序与代价 ---------------- */
  function routeCost(seq, trip, legOf) {
    let c = 0;
    let cur = trip.origin || null;
    for (const p of seq) {
      if (cur) c += legOf(cur, p).minutes;
      cur = p;
    }
    if (trip.returnHome && trip.origin && seq.length) {
      c += legOf(cur, trip.origin).minutes;
    }
    return c;
  }

  function nearestNeighbour(points, trip, legOf, startAt) {
    const remaining = points.slice();
    const seq = [];
    let cur = startAt || trip.origin || null;
    while (remaining.length) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = cur ? legOf(cur, remaining[i]).minutes : 0;
        if (d < bd) { bd = d; bi = i; }
      }
      const nxt = remaining.splice(bi, 1)[0];
      seq.push(nxt);
      cur = nxt;
    }
    return seq;
  }

  function twoOpt(seq, trip, legOf) {
    let best = seq.slice();
    let bestCost = routeCost(best, trip, legOf);
    for (let round = 0; round < 8; round++) {
      let improved = false;
      for (let i = 0; i < best.length - 1; i++) {
        for (let k = i + 1; k < best.length; k++) {
          const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
          const c = routeCost(cand, trip, legOf);
          if (c < bestCost - 0.01) {
            best = cand;
            bestCost = c;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    return best;
  }

  /* 用户手动定过顺序（seq）的地点，按 seq 插回目标位置 */
  function applySeq(order) {
    const pinned = order.filter((p) => p.seq != null).sort((a, b) => a.seq - b.seq);
    if (!pinned.length) return order;
    const out = order.slice();
    for (const p of pinned) {
      const cur = out.indexOf(p);
      if (cur < 0) continue;
      const target = Math.min(Math.max(0, p.seq), out.length - 1);
      if (cur !== target) { out.splice(cur, 1); out.splice(target, 0, p); }
    }
    return out;
  }

  function orderDay(points, trip, legOf, seed) {
    if (points.length <= 1) return points.slice();
    const startAt = trip.origin || seed || null;
    return applySeq(twoOpt(nearestNeighbour(points, trip, legOf, startAt), trip, legOf));
  }

  /* ---------------- 每天的起止（闭环用） ---------------- */
  const HOTEL_MINUTES = 20;   // 到店放行李 / 退房取行李

  /* 两点是否跨城：有城市名比城市名，没有就按直线距离兜底 */
  function farApart(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return false;
    const norm = (v) => String(v || '').replace(/[市\s]/g, '');
    const ca = norm(a.city);
    const cb = norm(b.city);
    if (ca && cb) return ca !== cb;
    try { return U.haversine(a, b) > 120000; } catch (e) { return false; }
  }

  function dayTiming(trip, dayIndex, totalDays) {
    const t = {
      start: trip.dayStart,
      end: trip.dayEnd,
      startPlace: trip.origin || null,
      endPlace: null,
      viaHotel: false,
    };

    // 第一天：从到达站出发，先去酒店放行李
    if (dayIndex === 0 && trip.arrive && trip.arrive.lat != null) {
      t.startPlace = trip.arrive;
      if (trip.arriveTime != null) t.start = Math.max(t.start, trip.arriveTime);
      t.viaHotel = !!(trip.origin && trip.origin.lat != null);
      t.startPlaceFar = farApart(trip.arrive, trip.origin);
    }

    // 最后一天：要在发车前赶到返程站
    if (dayIndex === totalDays - 1) {
      if (trip.depart && trip.depart.lat != null && trip.departTime != null) {
        const far = farApart(trip.origin || t.startPlace, trip.depart);
        // 提前 30 分钟到站；跨城时这段「住处 → 车站」排不了，再预留 30 分钟
        t.end = trip.departTime - 30 - (far ? 30 : 0);
        t.endPlace = trip.depart;
        t.endPlaceFar = far;
      } else if (trip.returnBuffer) {
        t.end = t.end - trip.returnBuffer;
      }
    }

    if (t.end <= t.start + 60) t.end = t.start + 60;  // 兜底，别把一天压成负数
    return t;
  }

  /* 当天的时间跨度。注意 scheduleDay 返回的 end-start 已包含午餐，
     所以必须用跨度比较，不能拿扣掉午餐的 dayBudget 比，否则会差一小时。 */
  function spanOf(timing) {
    return (timing ? timing.end - timing.start : 0);
  }

  function dayTimings(trip, totalDays) {
    return Array.from({ length: totalDays }, (_, i) => dayTiming(trip, i, totalDays));
  }

  /* ---------------- 就餐锚点 ---------------- */
  /* 饭点窗口跟着设置走：午餐/晚餐时间改了，餐厅的锚点也要跟着改 */
  const DEFAULT_MEAL = {
    lunch: { from: 11 * 60 + 30, to: 13 * 60 + 30 },
    dinner: { from: 17 * 60 + 30, to: 19 * 60 + 30 },
  };
  const MEAL_SPAN = 120;   // 饭点最多容忍两小时

  function mealWindow(kind, trip) {
    const base = kind === 'dinner'
      ? (Number(trip && trip.dinnerStart) || DEFAULT_MEAL.dinner.from)
      : (Number(trip && trip.lunchStart) || DEFAULT_MEAL.lunch.from);
    return { from: base, to: base + MEAL_SPAN };
  }
  /* 最多允许提前这么久到店（到了就坐下吃）；再早就算"不合理的饭点" */
  const MEAL_GRACE = 60;

  /* 餐饮类地点 → 午餐 / 晚餐 / 小吃；其它返回 null
     小吃（snack）不锁饭点：顺路就买，不占正餐位、不参与饭点偏离计算 */
  function mealKind(place) {
    if (!place || place.category !== '餐饮') return null;
    if (place.meal === 'snack') return 'snack';
    return place.meal === 'dinner' ? 'dinner' : 'lunch';
  }

  /* 解析「周一至周日 10:00-22:00」这类营业时间，取 [最早开门, 最晚关门] */
  function openWindowOf(p) {
    const raw = String(p && p.hours ? p.hours : '').trim();
    if (!raw) return null;
    if (/全天|24\s*小时|通宵/.test(raw)) return { open: 0, close: 24 * 60, allDay: true };

    const ranges = [];
    const re = /(\d{1,2}):(\d{2})\s*[-–—~至到]\s*(\d{1,2}):(\d{2})/g;
    let m;
    while ((m = re.exec(raw))) {
      const a = Number(m[1]) * 60 + Number(m[2]);
      let b = Number(m[3]) * 60 + Number(m[4]);
      if (b <= a) b = 24 * 60;            // 跨夜营业，当成开到当天结束
      ranges.push([a, b]);
    }
    if (!ranges.length) return null;
    return {
      open: Math.min.apply(null, ranges.map((r) => r[0])),
      close: Math.max.apply(null, ranges.map((r) => r[1])),
      allDay: false,
    };
  }

  /* 时间窗：用户手填的优先；餐饮点自动带就餐窗口（太早太晚都要罚） */
  function windowOf(p, trip) {
    if (p.winFrom || p.winTo) {
      return {
        from: p.winFrom ? U.fromHM(p.winFrom, null) : null,
        to: p.winTo ? U.fromHM(p.winTo, null) : null,
        auto: false,
      };
    }
    const k = mealKind(p);
    if (k === 'lunch' || k === 'dinner') {
      const w = mealWindow(k, trip);
      return { from: w.from, to: w.to, auto: true, kind: k };
    }
    return { from: null, to: null, auto: false };
  }

  /* 排程打分：偏离饭点重罚（提前和推后都算），其次看当天几点收工 */
  function scoreOrder(order, trip, legOf, timing) {
    const s = scheduleDay(order, { trip, legOf, timing });
    return s.windowViol * 30 + (s.mealDev || 0) * 8 + (s.hoursDev || 0) * 6 + s.end;
  }

  /* 把餐饮点挪到「到达时间正好落在就餐窗口」的位置 */
  function fixMealAnchors(order, trip, legOf, timing) {
    // 候选：就餐点（挪到饭点）+ 营业时间对不上的点 + 时间窗对不上的点（最晚到达没满足）
    let probe = scheduleDay(order, { trip, legOf, timing });
    const bad = probe.items
      .filter((it) => it.kind === 'visit' && (it.hoursDev > 0 || it.winLate > 0))
      .map((it) => it.place);
    const meals = order.filter((p) => mealKind(p))
      .concat(bad.filter((p, i, a) => a.indexOf(p) === i));
    if (!meals.length) return order;

    let best = order.slice();
    let bestScore = scoreOrder(best, trip, legOf, timing);

    for (const p of meals) {
      const rest = best.filter((x) => x !== p);
      let localBest = best;
      let localScore = bestScore;
      for (let i = 0; i <= rest.length; i++) {
        const cand = rest.slice(0, i).concat([p], rest.slice(i));
        const sc = scoreOrder(cand, trip, legOf, timing);
        if (sc < localScore - 0.5) { localScore = sc; localBest = cand; }
      }
      best = localBest;
      bestScore = localScore;
    }
    return best;
  }

  /* ---------------- 排程 ---------------- */
  function scheduleDay(order, ctx) {
    const { trip, legOf } = ctx;
    const timing = ctx.timing || { start: trip.dayStart, end: trip.dayEnd, startPlace: trip.origin || null, endPlace: null, viaHotel: false };
    const items = [];
    const legs = [];
    const totals = { visit: 0, travel: 0, walk: 0, ride: 0, meters: 0, fare: 0, transfers: 0 };
    let t = timing.start;
    let cur = timing.startPlace || null;
    // 当天有餐厅就由餐厅当那一餐，不再另插通用餐块
    const hasMealLunch = order.some((p) => mealKind(p) === 'lunch');
    const hasMealDinner = order.some((p) => mealKind(p) === 'dinner');
    let lunchDone = !trip.lunchOn || hasMealLunch;
    let dinnerDone = !trip.dinnerOn || hasMealDinner;
    let overflow = 0;
    let windowViol = 0;
    let mealDev = 0;
    let hoursDev = 0;
    let waiting = 0;

    if (cur) items.push({ kind: 'origin', place: cur, arrive: t, depart: t });

    // 第一天到站后先去酒店放行李，行程才闭环
    if (timing.viaHotel && cur && trip.origin && (cur.id !== trip.origin.id) && !timing.startPlaceFar) {
      const leg = legOf(cur, trip.origin);
      const depart = t;
      const arrive = t + Math.max(1, leg.minutes);
      legs.push({ from: cur, to: trip.origin, leg, depart, arrive, seq: legs.length, isArrival: true });
      items.push({ kind: 'travel', leg, from: cur, to: trip.origin, depart, arrive, seq: legs.length, isArrival: true });
      totals.travel += leg.minutes;
      totals.walk += leg.walkMeters || 0;
      totals.meters += leg.meters || 0;
      totals.fare += leg.fare || 0;
      totals.transfers += leg.transfers || 0;
      items.push({ kind: 'checkin', place: trip.origin, arrive, depart: arrive + HOTEL_MINUTES });
      totals.visit += HOTEL_MINUTES;
      t = arrive + HOTEL_MINUTES;
      cur = trip.origin;
    }

    for (let i = 0; i < order.length; i++) {
      const p = order[i];

      // 午餐：只要「这一站会让你跨过饭点」就先吃——通勤跨过也算，停留跨过也算。
      // 原来只看通勤时长，遇到 90 分钟的长停留就会拖到下午两点才吃午饭。
      if (!lunchDone && order.length > 1 && i > 0 && cur) {
        const legM = legOf(cur, p).minutes;
        const arriveAt = t + legM;
        const endAt = arriveAt + Math.max(0, p.minutes || 0);
        const crosses = arriveAt > trip.lunchStart
          || (arriveAt <= trip.lunchStart && endAt > trip.lunchStart + 15);
        if (crosses && t < trip.lunchStart + 120) {
          const at = Math.max(t, trip.lunchStart - 30);   // 最多提前半小时，不早起太多
          items.push({ kind: 'meal', place: cur, start: at, end: at + trip.lunchDur });
          totals.visit += trip.lunchDur;
          t = at + trip.lunchDur;
          lunchDone = true;
        }
      }

      if (cur) {
        const leg = legOf(cur, p);
        const depart = t;
        const arrive = t + Math.max(1, leg.minutes);
        legs.push({ from: cur, to: p, leg, depart, arrive, seq: legs.length });
        items.push({ kind: 'travel', leg, from: cur, to: p, depart, arrive, seq: legs.length });
        totals.travel += leg.minutes;
        totals.walk += leg.walkMeters || 0;
        totals.meters += leg.meters || 0;
        totals.fare += leg.fare || 0;
        totals.transfers += leg.transfers || 0;
        t = arrive;
      }

      let arrive = t;
      let waited = 0;
      const win = windowOf(p, trip);

      let itemMealDev = 0;
      let itemWinLate = 0;
      if (win.auto) {
        // 就餐点：离饭点太远（早或晚）都记偏离，交给排序去修
        if (arrive < win.from - MEAL_GRACE) {
          itemMealDev = (win.from - MEAL_GRACE) - arrive;      // 太早：15:20 吃晚饭
        } else if (arrive < win.from) {
          waited = win.from - arrive;                          // 提前不足一小时，等一等再吃
          waiting += waited;
          arrive = win.from;
        }
        if (arrive > win.to) itemMealDev += (arrive - win.to); // 太晚
        mealDev += itemMealDev;
      } else {
        // 用户手动设的时间窗：严格按设置来
        if (win.from != null && arrive < win.from) {
          waited = win.from - arrive;
          waiting += waited;
          arrive = win.from;
        }
        if (win.to != null && arrive > win.to) {
          const late = arrive - win.to;
          windowViol += late;
          itemWinLate = late;
        }
      }

      const stay = Math.max(0, p.minutes || 0);

      // 营业时间：太早到就等（最多等 120 分钟），关门前来不及就记违规
      let itemHoursDev = 0;
      const oh = openWindowOf(p);
      if (oh && !oh.allDay) {
        if (arrive < oh.open) {
          const gap = oh.open - arrive;
          // 早到就等开门；两小时内都值得等——不等的话这一站根本进不去
          if (gap <= 120) { waited += gap; waiting += gap; arrive = oh.open; }
          else itemHoursDev += gap;
        }
        if (arrive >= oh.close) {
          itemHoursDev += 180;                       // 到的时候已经关门
        } else if (arrive + stay > oh.close) {
          itemHoursDev += (arrive + stay) - oh.close; // 没逛完就关门
        }
        if (itemHoursDev > 0) hoursDev += itemHoursDev;
      }

      items.push({
        kind: 'visit', place: p, arrive, depart: arrive + stay, waited,
        mealDev: win.auto ? itemMealDev : 0,
        hoursDev: itemHoursDev,
        winLate: itemWinLate,
      });
      totals.visit += stay;
      t = arrive + stay;
      cur = p;
    }

    // 晚餐：当天没有餐厅时补一个餐块，且必须给后续回酒店/去车站留足时间
    if (!dinnerDone && order.length && cur) {
      const start = Math.max(t, trip.dinnerStart);
      const end = start + (trip.dinnerDur || 60);
      let tail = 0;
      if (trip.returnHome && trip.origin && cur.id !== trip.origin.id) tail += legOf(cur, trip.origin).minutes;
      if (timing.endPlace) {
        const from = (trip.returnHome && trip.origin) ? trip.origin : cur;
        if (from.id !== timing.endPlace.id) tail += legOf(from, timing.endPlace).minutes;
      }
      if (end + tail <= timing.end - 5) {
        items.push({ kind: 'meal', type: 'dinner', place: cur, start, end });
        totals.visit += end - start;
        t = end;
        dinnerDone = true;
      }
    }

    // 回酒店：如果酒店跟最后一个点隔着城市，同样不规划（排出来是几小时的假路线）
    if (trip.returnHome && trip.origin && cur && cur.id !== trip.origin.id && order.length
        && !farApart(cur, trip.origin)) {
      const leg = legOf(cur, trip.origin);
      const depart = t;
      const arrive = t + Math.max(1, leg.minutes);
      legs.push({ from: cur, to: trip.origin, leg, depart, arrive, seq: legs.length, isReturn: true });
      items.push({ kind: 'travel', leg, from: cur, to: trip.origin, depart, arrive, seq: legs.length, isReturn: true });
      totals.travel += leg.minutes;
      totals.walk += leg.walkMeters || 0;
      totals.fare += leg.fare || 0;
      t = arrive;
      cur = trip.origin;
      items.push({ kind: 'returnhome', place: trip.origin, arrive: t, depart: t });
    }

    // 最后一天：去返程站。跨城的话不规划路线，只标一个「返程」
    if (timing.endPlace && timing.endPlaceFar) {
      // 不能把时钟往回拨：已经过点就是超时，下面按 overflow 裁掉玩不下的点
      const at = Math.max(t, timing.end);
      items.push({ kind: 'depart', place: timing.endPlace, arrive: at, depart: at, noRoute: true });
      t = at;
      cur = timing.endPlace;
    } else if (timing.endPlace && cur && (cur.id !== timing.endPlace.id)) {
      const leg = legOf(cur, timing.endPlace);
      const depart = t;
      const arrive = t + Math.max(1, leg.minutes);
      legs.push({ from: cur, to: timing.endPlace, leg, depart, arrive, seq: legs.length, isDepart: true });
      items.push({ kind: 'travel', leg, from: cur, to: timing.endPlace, depart, arrive, seq: legs.length, isDepart: true });
      totals.travel += leg.minutes;
      totals.walk += leg.walkMeters || 0;
      totals.fare += leg.fare || 0;
      t = arrive;
      items.push({ kind: 'depart', place: timing.endPlace, arrive: t, depart: t });
    }

    overflow = Math.max(0, t - timing.end);
    return {
      items, legs, totals, start: timing.start, end: t,
      plannedEnd: timing.end, overflow, windowViol, mealDev, hoursDev, waiting,
    };
  }

  /* ---------------- 分天 ---------------- */
  function centroid(points) {
    if (!points.length) return null;
    let lat = 0, lng = 0;
    for (const p of points) { lat += p.lat; lng += p.lng; }
    return { lat: lat / points.length, lng: lng / points.length };
  }

  function dayBudget(trip) {
    return (trip.dayEnd - trip.dayStart) - (trip.lunchOn ? trip.lunchDur : 0);
  }

  /* 双向平均通勤分钟，作为聚类距离 */
  function dist(a, b, legOf) {
    if (!a || !b || a === b) return 0;
    return (legOf(a, b).minutes + legOf(b, a).minutes) / 2;
  }

  /* k-medoids 聚类分天：种子用最远点采样，再用 medoid 迭代收敛 */
  function clusterDays(points, D, trip, legOf) {
    const n = points.length;
    if (n <= D) {
      const g = Array.from({ length: D }, () => []);
      points.forEach((p, i) => g[i].push(p));
      return g;
    }

    // 第一个种子：离住处最远
    let first = points[0], fd = -1;
    for (const p of points) {
      const d = trip.origin ? U.haversine(trip.origin, p) : 0;
      if (d > fd) { fd = d; first = p; }
    }
    const seeds = [first];

    while (seeds.length < D) {
      let best = null, bd = -1;
      for (const p of points) {
        if (seeds.indexOf(p) >= 0) continue;
        let m = Infinity;
        for (const s of seeds) m = Math.min(m, dist(p, s, legOf));
        if (m > bd) { bd = m; best = p; }
      }
      if (!best) break;
      seeds.push(best);
    }

    const assign = new Array(n).fill(0);
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 0; i < n; i++) {
        let bi = 0, bd = Infinity;
        for (let k = 0; k < seeds.length; k++) {
          const d = dist(points[i], seeds[k], legOf);
          if (d < bd) { bd = d; bi = k; }
        }
        assign[i] = bi;
      }
      // 更新每个簇的 medoid
      for (let k = 0; k < seeds.length; k++) {
        const members = points.filter((_, i) => assign[i] === k);
        if (!members.length) continue;
        let bestP = seeds[k], bestSum = Infinity;
        for (const c of members) {
          let sum = 0;
          for (const m of members) sum += dist(c, m, legOf);
          if (sum < bestSum) { bestSum = sum; bestP = c; }
        }
        seeds[k] = bestP;
      }
    }

    const groups = Array.from({ length: D }, () => []);
    points.forEach((p, i) => groups[assign[i]].push(p));
    return groups;
  }

  /* 有手动指定日期时：锁定日优先，其余就近归组 */
  function assignDays(places, trip, legOf) {
    const D = trip.days;
    const groups = Array.from({ length: D }, () => []);
    const locked = places.filter((p) => p.day != null && p.day >= 0 && p.day < D);
    const free = places.filter((p) => !(p.day != null && p.day >= 0 && p.day < D));
    locked.forEach((p) => groups[p.day].push(p));

    if (!free.length) return groups;

    const anchors = groups.map((g, i) => ({ idx: i, pt: g.length ? centroid(g) : null }));
    const pool = free.slice();

    // 最远点采样为空日选锚
    for (const a of anchors) {
      if (a.pt || !pool.length) continue;
      let best = null, bestD = -1;
      for (const p of pool) {
        let nearest = Infinity;
        for (const o of anchors) if (o.pt) nearest = Math.min(nearest, U.haversine(o.pt, p));
        if (nearest === Infinity) nearest = trip.origin ? U.haversine(trip.origin, p) : 0;
        if (nearest > bestD) { bestD = nearest; best = p; }
      }
      if (!best) break;
      a.pt = best;
      groups[a.idx].push(best);
      pool.splice(pool.indexOf(best), 1);
    }

    for (const p of pool) {
      let bi = 0, bd = Infinity;
      anchors.forEach((a, i) => {
        if (!a.pt) return;
        const d = U.haversine(a.pt, p);
        if (d < bd) { bd = d; bi = i; }
      });
      groups[bi].push(p);
    }
    return groups;
  }

  function groupLoad(points, trip, legOf, seed, timing) {
    if (!points.length) return 0;
    const seq = orderDay(points, trip, legOf, seed);
    const s = scheduleDay(seq, { trip, legOf, timing });
    return s.end - s.start;
  }

  function balance(groups, trip, legOf) {
    const seeds = groups.map((g) => centroid(g));
    const timings = dayTimings(trip, groups.length);
    let moved = 0;

    for (let iter = 0; iter < 40; iter++) {
      const loads = groups.map((g, i) => groupLoad(g, trip, legOf, seeds[i], timings[i]));
      const overIdx = loads.map((l, i) => ({ l, i })).filter((x) => x.l > spanOf(timings[x.i]) + 1)
        .sort((a, b) => b.l - a.l)[0];
      if (!overIdx) break;

      const slack = loads.map((l, i) => ({ s: spanOf(timings[i]) - l, i }))
        .filter((x) => x.i !== overIdx.i)
        .sort((a, b) => b.s - a.s)[0];
      if (!slack || slack.s <= 14) break;

      const fromGroup = groups[overIdx.i];
      const toGroup = groups[slack.i];
      const toCenter = centroid(toGroup) || seeds[slack.i];
      const fromCenter = centroid(fromGroup) || seeds[overIdx.i];

      // 候选：搬到目标日之后在途增加最少的点；优先级低的更容易被搬
      const candidates = fromGroup
        .filter((p) => p.day == null)
        .map((p) => ({
          p,
          cost: (dist(p, toCenter, legOf) - dist(p, fromCenter, legOf)) + (2 - p.must) * 2,
        }))
        .sort((a, b) => a.cost - b.cost);
      if (!candidates.length) break;

      const pick = candidates[0].p;
      fromGroup.splice(fromGroup.indexOf(pick), 1);
      toGroup.push(pick);
      moved++;
    }
    return moved;
  }

  function maxLegOf(order, trip, legOf) {
    let mx = 0;
    let cur = trip.origin || null;
    for (const p of order) {
      if (cur) mx = Math.max(mx, legOf(cur, p).minutes);
      cur = p;
    }
    if (trip.returnHome && trip.origin && order.length) {
      mx = Math.max(mx, legOf(order[order.length - 1], trip.origin).minutes);
    }
    return mx;
  }

  /* 轻松模式：每天最多 4 个点，别赶场 */
  function enforceMaxPerDay(groups, trip, legOf) {
    const cap = trip.pace === 'relaxed' ? 4 : 0;
    if (!cap) return 0;
    let moved = 0;
    for (let iter = 0; iter < 10; iter++) {
      const over = groups.findIndex((g) => g.length > cap);
      if (over < 0) break;
      // 接收方必须还有余量
      let to = -1;
      groups.forEach((g, i) => {
        if (i === over || g.length >= cap) return;
        if (to < 0 || g.length < groups[to].length) to = i;
      });
      if (to < 0) break;

      const center = centroid(groups[to]);
      const cands = groups[over]
        .filter((p) => p.day == null)
        .map((p) => ({ p, d: center ? U.haversine(center, p) : 0 }))
        .sort((a, b) => a.d - b.d);

      const timings = dayTimings(trip, groups.length);
      let pick = null;
      for (const c of cands) {
        const dst = groups[to].concat([c.p]);
        if (groupLoad(dst, trip, legOf, center, timings[to]) <= spanOf(timings[to])) { pick = c.p; break; }
      }
      if (!pick) break;   // 挪过去就超时，宁可不挪

      groups[over] = groups[over].filter((x) => x !== pick);
      groups[to] = groups[to].concat([pick]);
      moved++;
    }
    return moved;
  }

  /* 把最满那天的点挪给最空那天：只要「最忙一天」能变短就搬，不超时也要搬 */
  function balanceMakespan(groups, trip, legOf) {
    const seeds = groups.map((g) => centroid(g));
    const timings = dayTimings(trip, groups.length);
    let moved = 0;

    for (let iter = 0; iter < 12; iter++) {
      const loads = groups.map((g, i) => groupLoad(g, trip, legOf, seeds[i], timings[i]));
      let maxI = 0, minI = 0;
      loads.forEach((l, i) => {
        if (l > loads[maxI]) maxI = i;
        if (l < loads[minI]) minI = i;
      });
      if (maxI === minI) break;
      const oldMax = loads[maxI];
      if (oldMax - loads[minI] < 90) break;

      // 按「离目标日近」排序，优先搬地理上顺路的
      const center = centroid(groups[minI]) || seeds[minI];
      const cands = groups[maxI]
        .filter((p) => p.day == null)
        .map((p) => ({ p, d: center ? U.haversine(center, p) : 0 }))
        .sort((a, b) => a.d - b.d);

      let pick = null;
      for (const c of cands) {
        const src = groups[maxI].filter((x) => x !== c.p);
        const dst = groups[minI].concat([c.p]);
        const srcLoad = groupLoad(src, trip, legOf, seeds[maxI], timings[maxI]);
        const dstLoad = groupLoad(dst, trip, legOf, seeds[minI], timings[minI]);
        const nmax = Math.max(srcLoad, dstLoad, ...loads.filter((_, i) => i !== maxI && i !== minI));
        if (nmax < oldMax - 5 && dstLoad <= spanOf(timings[minI])) { pick = { p: c.p, srcLoad, dstLoad }; break; }
      }
      if (!pick) break;

      groups[maxI] = groups[maxI].filter((x) => x !== pick.p);
      groups[minI] = groups[minI].concat([pick.p]);
      moved++;
    }
    return moved;
  }

  /* 跨天交换微调：只有在总在途明显下降、且不会让任何一天出现更长单段时才接受 */
  function improveSwaps(groups, trip, legOf) {
    const seeds = groups.map((g) => centroid(g));
    const timings = dayTimings(trip, groups.length);
    const orders = groups.map((g, i) => orderDay(g, trip, legOf, seeds[i]));
    const costs = orders.map((o) => routeCost(o, trip, legOf));
    const maxLegs = orders.map((o) => maxLegOf(o, trip, legOf));
    const loads = orders.map((o, i) => groupLoad(groups[i], trip, legOf, seeds[i], timings[i]));
    let gain = 0;

    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        for (let i = 0; i < groups[a].length; i++) {
          for (let j = 0; j < groups[b].length; j++) {
            const pa = groups[a][i], pb = groups[b][j];
            if (pa.day != null || pb.day != null) continue;

            const na = groups[a].slice(); na[i] = pb;
            const nb = groups[b].slice(); nb[j] = pa;
            const oa = orderDay(na, trip, legOf, seeds[a]);
            const ob = orderDay(nb, trip, legOf, seeds[b]);

            const newCost = routeCost(oa, trip, legOf) + routeCost(ob, trip, legOf);
            const oldCost = costs[a] + costs[b];
            if (newCost > oldCost - 8) continue;

            if (maxLegOf(oa, trip, legOf) > maxLegs[a] + 1) continue;
            if (maxLegOf(ob, trip, legOf) > maxLegs[b] + 1) continue;

            // 不能把均衡结果换回去：既不能超时，也不能让这两天更满
            const sa = scheduleDay(oa, { trip, legOf, timing: timings[a] });
            const sb = scheduleDay(ob, { trip, legOf, timing: timings[b] });
            if (sa.overflow > 0 || sb.overflow > 0) continue;
            const newMax = Math.max(sa.end - sa.start, sb.end - sb.start);
            if (newMax > Math.max(loads[a], loads[b]) + 5) continue;

            groups[a] = na; groups[b] = nb;
            orders[a] = oa; orders[b] = ob;
            costs[a] = routeCost(oa, trip, legOf);
            costs[b] = routeCost(ob, trip, legOf);
            maxLegs[a] = maxLegOf(oa, trip, legOf);
            maxLegs[b] = maxLegOf(ob, trip, legOf);
            loads[a] = sa.end - sa.start;
            loads[b] = sb.end - sb.start;
            gain += oldCost - newCost;
          }
        }
      }
    }
    return { groups, gain };
  }

  /* ---------------- 总装 ---------------- */
  function buildPlan(places, trip, legOf) {
    const clean = places.filter((p) => p && !p.skip && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!clean.length) return { days: [], warnings: [{ level: 'info', text: '还没有可规划的地点（可能都被标记为跳过了）。' }], skipped: [] };

    const effectiveTrip = normalizeTrip(trip);

    const hasLock = clean.some((p) => p.day != null && p.day >= 0 && p.day < effectiveTrip.days);
    let groups;
    if (hasLock) {
      groups = assignDays(clean, effectiveTrip, legOf);
    } else {
      groups = clusterDays(clean, effectiveTrip.days, effectiveTrip, legOf);
    }
    balanceMakespan(groups, effectiveTrip, legOf);
    balance(groups, effectiveTrip, legOf);
    // 跨天交换收益小、容易破坏地理分组，默认不启用（保留函数以备手动调参）
    enforceMaxPerDay(groups, effectiveTrip, legOf);

    const seeds = groups.map((g) => centroid(g));
    const timings = dayTimings(effectiveTrip, groups.length);
    const days = groups.map((g, i) => {
      const order = fixMealAnchors(orderDay(g, effectiveTrip, legOf, seeds[i]), effectiveTrip, legOf, timings[i]);
      const sched = scheduleDay(order, { trip: effectiveTrip, legOf, timing: timings[i] });
      return Object.assign({ index: i, order }, sched);
    });

    // 时间不够时舍弃优先级最低、最不感兴趣的点，保证方案真的可行
    let skipped = [];
    if (effectiveTrip.autoTrim !== false) {
      skipped = trimOverflow(days, effectiveTrip, legOf, timings);
      dropBadMeals(days, effectiveTrip, legOf, timings, skipped);
      refillTrimmed(days, effectiveTrip, legOf, timings, skipped);
      balanceMeals(days, effectiveTrip, legOf, timings, skipped);
      spreadOverflow(days, effectiveTrip, legOf, timings);
    }

    return {
      days,
      warnings: makeWarnings(days, effectiveTrip, skipped),
      budget: dayBudget(effectiveTrip),
      skipped,
    };
  }

  /* 从超时的那天里挑最不重要的点移出，直到不超时 */
  function trimOverflow(days, trip, legOf, timings) {
    const skipped = [];
    for (const d of days) {
      // 必须带上当天的起止（含到站/返程段），否则裁剪后行程会丢掉闭环
      const timing = timings ? timings[d.index] : undefined;
      let guard = 0;
      while (d.overflow > 0 && guard++ < 10) {
        const cands = d.order.filter((p) => (p.must || 0) < 2);
        if (!cands.length) break;
        cands.sort((a, b) => {
          // 餐厅最后才舍弃：少看一个景点还能接受，不吃饭不行
          const ma = mealKind(a) ? 1 : 0;
          const mb = mealKind(b) ? 1 : 0;
          if (ma !== mb) return ma - mb;
          const ia = interestScore(a, trip.interests);
          const ib = interestScore(b, trip.interests);
          if (ia !== ib) return ia - ib;                 // 不感兴趣的先出局
          return (b.minutes || 0) - (a.minutes || 0);    // 停留长的先出局
        });
        const drop = cands[0];
        d.order = d.order.filter((p) => p !== drop);
        Object.assign(d, scheduleDay(d.order, { trip, legOf, timing }));
        skipped.push({ place: drop, day: d.index });
      }
    }
    return skipped;
  }

  /* 裁剪只保证「不超时」，常常丢过头。这里把丢掉的点再试着塞回去：
     必去优先、停留短的优先，哪个位置塞得进且当天仍不超时就用哪个。 */
  function refillTrimmed(days, trip, legOf, timings, skipped) {
    for (const d of days) {
      const timing = timings ? timings[d.index] : undefined;
      const mine = skipped
        .filter((s) => s.day === d.index && s.reason !== 'meal')
        .map((s) => s.place);
      if (!mine.length) continue;
      mine.sort((a, b) => (b.must || 0) - (a.must || 0) || (a.minutes || 0) - (b.minutes || 0));

      for (const p of mine) {
        let best = null;
        for (let i = 0; i <= d.order.length; i++) {
          const cand = d.order.slice(0, i).concat([p], d.order.slice(i));
          const sc = scheduleDay(cand, { trip, legOf, timing });
          if (sc.overflow > 0) continue;
          if (!best || sc.end < best.s.end) best = { order: cand, s: sc };
        }
        if (!best) continue;
        d.order = best.order;
        Object.assign(d, best.s);
        const idx = skipped.findIndex((s) => s.place === p && s.day === d.index);
        if (idx >= 0) skipped.splice(idx, 1);
      }
    }
    return skipped;
  }

  /* 一天塞太多餐厅，就搬到餐厅少的那天去——一天四顿没有意义 */
  function balanceMeals(days, trip, legOf, timings, skipped) {
    const MAX = 2;
    const isMeal = (p) => {
      const k = mealKind(p);
      return k === 'lunch' || k === 'dinner';
    };
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const d of days) {
        const meals = d.order.filter(isMeal);
        if (meals.length <= MAX) continue;
        const extras = meals.slice(MAX).sort((a, b) => (a.must || 0) - (b.must || 0));
        for (const p of extras) {
          const targets = days
            .filter((x) => x !== d)
            .map((x) => ({ x, n: x.order.filter(isMeal).length }))
            .filter((o) => o.n < MAX)
            .sort((a, b) => a.n - b.n);
          let moved = false;
          for (const t of targets) {
            const cand = t.x.order.concat([p]);
            const sc = scheduleDay(cand, { trip, legOf, timing: timings ? timings[t.x.index] : undefined });
            if (sc.overflow > 0) continue;
            d.order = d.order.filter((k) => k !== p);
            Object.assign(d, scheduleDay(d.order, { trip, legOf, timing: timings ? timings[d.index] : undefined }));
            t.x.order = cand;
            Object.assign(t.x, sc);
            moved = true;
            changed = true;
            break;
          }
          if (!moved && (p.must || 0) < 2) {
            d.order = d.order.filter((k) => k !== p);
            Object.assign(d, scheduleDay(d.order, { trip, legOf, timing: timings ? timings[d.index] : undefined }));
            skipped.push({ place: p, day: d.index, reason: 'meal' });
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  }

  /* 某天怎么裁都装不下（多半全是必去），就把末尾的点挪到别的天 */
  function spreadOverflow(days, trip, legOf, timings) {
    for (const d of days) {
      let guard = 0;
      while (d.overflow > 0 && guard++ < 10) {
        if (d.order.length <= 1) break;
        const cand = d.order.slice().reverse().find((p) => (p.must || 0) < 2)
          || d.order[d.order.length - 1];
        let best = null;
        for (const other of days) {
          if (other === d) continue;
          const test = other.order.concat([cand]);
          const sc = scheduleDay(test, { trip, legOf, timing: timings ? timings[other.index] : undefined });
          if (sc.overflow > 0) continue;
          if (!best || sc.end < best.sc.end) best = { other, sc, test };
        }
        if (!best) break;
        d.order = d.order.filter((p) => p !== cand);
        Object.assign(d, scheduleDay(d.order, { trip, legOf, timing: timings ? timings[d.index] : undefined }));
        best.other.order = best.test;
        Object.assign(best.other, best.sc);
      }
    }
  }

  /* 饭点实在排不进去的餐厅，宁可不排，也别让人下午三点吃晚饭 */
  function dropBadMeals(days, trip, legOf, timings, skipped) {
    const LIMIT = 150;
    for (const d of days) {
      const timing = timings ? timings[d.index] : undefined;
      let guard = 0;
      while (guard++ < 4) {
        const bad = d.items
          .filter((it) => it.kind === 'visit' && it.mealDev > LIMIT)
          .sort((a, b) => b.mealDev - a.mealDev)[0];
        if (!bad) break;
        if ((bad.place.must || 0) >= 2) break;   // 必去的不动
        d.order = d.order.filter((p) => p !== bad.place);
        Object.assign(d, scheduleDay(d.order, { trip, legOf, timing }));
        skipped.push({ place: bad.place, day: d.index, reason: 'meal' });
      }
    }
    return skipped;
  }

  /* ---------------- 多方案 ---------------- */
  function planStats(plan, trip) {
    const days = plan.days || [];
    const travel = days.reduce((a, d) => a + d.totals.travel, 0);
    const walk = days.reduce((a, d) => a + d.totals.walk, 0);
    const fare = days.reduce((a, d) => a + d.totals.fare, 0);
    const overflow = days.reduce((a, d) => a + d.overflow, 0);
    let maxHop = 0;
    days.forEach((d) => d.legs.forEach((l) => { maxHop = Math.max(maxHop, l.leg.minutes); }));
    return {
      days: days.length,
      covered: days.reduce((a, d) => a + d.order.length, 0),
      travel, walk, fare, overflow, maxHop,
      maxEnd: days.reduce((a, d) => Math.max(a, d.end), 0),
      skipped: (plan.skipped || []).length,
    };
  }

  function buildVariants(places, trip, legOf) {
    const baseDays = Math.max(1, trip.days || 3);
    const defs = [
      { key: 'balanced', name: '均衡', desc: '按地理分区，时长优先', patch: { pace: 'normal' } },
      { key: 'packed', name: '紧凑', desc: `压到 ${Math.max(1, baseDays - 1)} 天，每天多排 45 分钟`, patch: { days: baseDays - 1, pace: 'packed' } },
      { key: 'relaxed', name: '轻松', desc: `放宽到 ${baseDays + 1} 天，每天提前 1 小时收工`, patch: { days: baseDays + 1, pace: 'relaxed' } },
    ];
    return defs.map((d) => {
      // 这里不做 normalize：buildPlan 内部会做，否则节奏偏移会被叠加两次
      const t = Object.assign({}, trip, d.patch);
      t.days = Math.max(1, Math.min(14, t.days || 1));
      const plan = buildPlan(places, t, legOf);
      return { key: d.key, name: d.name, desc: d.desc, trip: t, plan, stats: planStats(plan, t) };
    });
  }

  /* 保持分天不变，只重排每天的游览顺序并重算时间 */
  function refine(plan, trip, legOf, opts) {
    if (!plan || !plan.days) return plan;
    const t = normalizeTrip(trip);
    let groups = plan.days.map((d) => d.order.slice());
    if (opts && opts.rebalance) balance(groups, t, legOf);
    const timings = dayTimings(t, groups.length);
    const days = groups.map((g, i) => {
      const order = fixMealAnchors(orderDay(g, t, legOf, centroid(g)), t, legOf, timings[i]);
      return Object.assign({ index: i, order }, scheduleDay(order, { trip: t, legOf, timing: timings[i] }));
    });
    let skipped = (plan.skipped || []).slice();
    if (t.autoTrim !== false) {
      skipped = skipped.concat(trimOverflow(days, t, legOf, timings));
      dropBadMeals(days, t, legOf, timings, skipped);
      refillTrimmed(days, t, legOf, timings, skipped);
      balanceMeals(days, t, legOf, timings, skipped);
      spreadOverflow(days, t, legOf, timings);
    }
    return { days, warnings: makeWarnings(days, t, skipped), budget: dayBudget(t), skipped };
  }

  /* 固定顺序、只重算时间：真实耗时回填用，避免反复重排导致请求暴涨 */
  function reschedule(plan, trip, legOf) {
    if (!plan || !plan.days) return plan;
    const t = normalizeTrip(trip);
    const timings = dayTimings(t, plan.days.length);
    const days = plan.days.map((d, i) => Object.assign(
      { index: i, order: d.order },
      scheduleDay(d.order, { trip: t, legOf, timing: timings[i] })
    ));
    let skipped = (plan.skipped || []).slice();
    if (t.autoTrim !== false) {
      skipped = skipped.concat(trimOverflow(days, t, legOf, timings));
      dropBadMeals(days, t, legOf, timings, skipped);
      refillTrimmed(days, t, legOf, timings, skipped);
      balanceMeals(days, t, legOf, timings, skipped);
      spreadOverflow(days, t, legOf, timings);
    }
    return { days, warnings: makeWarnings(days, t, skipped), budget: dayBudget(t), skipped };
  }

  function makeWarnings(days, trip, skipped) {
    const warnings = [];

    if (skipped && skipped.length) {
      warnings.push({
        level: 'danger',
        text: (() => {
          const meal = skipped.filter((x) => x.reason === 'meal').map((x) => x.place.name);
          const other = skipped.filter((x) => x.reason !== 'meal').map((x) => x.place.name);
          const parts = [];
          if (other.length) parts.push(`${other.join('、')} 因时间不足未安排`);
          if (meal.length) parts.push(`${meal.join('、')} 排不进饭点（太早或太晚）已跳过`);
          return `有 ${skipped.length} 个地点没排上：${parts.join('；')}。可增加天数或缩短停留。`;
        })(),
      });
    }

    days.forEach((d, i) => {
      if (d.overflow > 0) {
        warnings.push({
          level: 'danger',
          text: `第 ${i + 1} 天超出 ${U.dur(d.overflow)}（结束时间 ${U.toHM(d.end)}，计划 ${U.toHM(d.plannedEnd || trip.dayEnd)}）。可减少地点、缩短停留时间，或增加天数。`,
          day: i,
        });
      }
      if (d.windowViol > 0) {
        warnings.push({
          level: 'danger',
          text: `第 ${i + 1} 天有地点的到达时间晚于限定时间 ${U.dur(d.windowViol)}，请调整顺序或提前出发。`,
          day: i,
        });
      }
      const empty = (d.end - d.start) - (d.totals.visit + d.totals.travel);
      if (d.order.length && empty > 180 && days.length > 1) {
        warnings.push({
          level: 'info',
          text: `第 ${i + 1} 天还有约 ${U.dur(empty)} 空档，可以再加一个地点。`,
          day: i,
        });
      }
      if (trip.pace === 'relaxed' && d.order.length > 4) {
        warnings.push({
          level: 'info',
          text: `第 ${i + 1} 天塞了 ${d.order.length} 个点，比「轻松」建议的 4 个多。想真正轻松，把天数加到 ${days.length + 1} 天。`,
          day: i,
        });
      }
      // 单段过长：多半是跨区，提醒用户
      const normalLegs = d.legs.filter((l) => !l.isReturn && !l.isDepart && !l.isArrival);
      const longest = normalLegs.reduce((a, l) => (l.leg.minutes > (a ? a.leg.minutes : 0) ? l : a), null);
      if (longest && longest.leg.minutes >= 45) {
        warnings.push({
          level: 'info',
          text: `第 ${i + 1} 天有一处跨区长距离移动：${longest.from.name} → ${longest.to.name}，约 ${U.dur(longest.leg.minutes)}。若不想跑这么远，可把「${longest.to.name}」改到离它更近的那一天。`,
          day: i,
        });
      }
    });

    if (trip.returnHome !== false && !trip.origin) {
      warnings.push({
        level: 'info',
        text: '没填「酒店 / 住处」，行程无法闭环：每天会直接结束在最后一个景点，也没有返程段。',
      });
    }

    const anyEst = days.some((d) => d.legs.some((l) => l.leg.est));
    if (anyEst && days.some((d) => d.legs.length)) {
      warnings.push({
        level: 'info',
        text: '当前部分路段为几何估算（无线路名与站点）。配置腾讯位置服务 Key 后可获取真实地铁/公交方案。',
      });
    }

    return warnings;
  }

  /* ---------------- 天数建议 ---------------- */
  function suggestDays(places, trip, legOf) {
    if (!places.length) return 1;
    const budget = Math.max(120, dayBudget(trip));
    let total = 0;
    for (const p of places) total += Math.max(15, p.minutes || 60);
    // 地点的在途时间用一个粗略的巡回估计
    if (places.length > 1) {
      const seq = nearestNeighbour(places, trip, legOf, trip.origin || null);
      total += routeCost(seq, trip, legOf);
    }
    return U.clamp(Math.ceil(total / (budget * 0.88)), 1, 14);
  }

  /* ---------------- 导出 ---------------- */
  /* 按类别归组（顺序固定，方便阅读） */
  const CAT_ORDER = ['餐饮', '景点', '博物馆', '购物', '住宿', '交通枢纽', '其他'];

  function groupByCategory(places) {
    const map = new Map();
    (places || []).forEach((p) => {
      const k = p.category || '其他';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    });
    const known = CAT_ORDER.filter((k) => map.has(k));
    const extra = [...map.keys()].filter((k) => CAT_ORDER.indexOf(k) < 0);
    return known.concat(extra).map((k) => ({ name: k, list: map.get(k) }));
  }

  function planToText(plan, trip, places) {
    if (!plan || !plan.days.length) return '';
    const L = [];
    L.push('# 行程方案');
    L.push('');
    if (trip.city) L.push(`- 城市：${trip.city}`);
    L.push(`- 天数：${plan.days.length} 天`);
    L.push(`- 每日时段：${U.toHM(trip.dayStart)} — ${U.toHM(trip.dayEnd)}`);
    if (trip.origin) L.push(`- 住处：${trip.origin.name}`);
    L.push('');

    plan.days.forEach((d, i) => {
      const date = trip.startDate ? U.fmtDate(U.addDays(trip.startDate, i)) : '';
      L.push(`## 第 ${i + 1} 天${date ? '　' + date : ''}`);
      const stat = `游览 ${U.dur(d.totals.visit)} · 在途 ${U.dur(d.totals.travel)} · 步行 ${U.dist(d.totals.walk)}`;
      L.push(`> ${stat}`);
      L.push('');
      for (const it of d.items) {
        if (it.kind === 'origin') {
          L.push(`**${U.toHM(it.depart)}　出发**　${it.place.name}`);
        } else if (it.kind === 'checkin') {
          L.push(`**${U.toHM(it.arrive)}–${U.toHM(it.depart)}**　到店放行李　${it.place.name}`);
        } else if (it.kind === 'returnhome') {
          L.push(`**${U.toHM(it.arrive)}　回到住处**　${it.place.name}（当天结束）`);
          L.push('');
        } else if (it.kind === 'depart') {
          L.push('');
          L.push(`**${U.toHM(it.arrive)}　到站候车**　${it.place.name}${trip.fromCity ? '　（返程回 ' + trip.fromCity + '）' : ''}`);
        } else if (it.kind === 'meal') {
          const mname = it.type === 'dinner' ? '晚餐' : '午餐';
          L.push(`*${U.toHM(it.start)}–${U.toHM(it.end)}　${mname}（${it.place.name}附近）*`);
        } else if (it.kind === 'visit') {
          const tag = it.place.must === 2 ? '`必去` ' : '';
          L.push(`**${U.toHM(it.arrive)}–${U.toHM(it.depart)}**　${tag}${it.place.name}　（停留 ${U.dur(it.place.minutes)}）`);
          if (it.place.address) L.push(`　　地址：${it.place.address}`);
          const meta = [];
          if (it.place.hours) meta.push(`营业时间 ${it.place.hours}`);
          if (it.place.rating) meta.push(`评分 ${it.place.rating}`);
          if (it.place.cost) meta.push(`人均 ¥${it.place.cost}`);
          if (it.place.ticket) meta.push(`门票 ¥${it.place.ticket}`);
          if (it.place.tel) meta.push(`电话 ${it.place.tel}`);
          if (meta.length) L.push(`　　${meta.join(' · ')}`);
          if (it.place.tips) L.push(`　　建议：${it.place.tips}`);
        } else if (it.kind === 'travel') {
          L.push('');
          L.push(`　▸ ${it.depart ? U.toHM(it.depart) + ' 出发　' : ''}${legToText(it.leg, it.from, it.to)}`);
          L.push('');
        }
      }
      L.push('');
    });

    // 附：全部地点清单，按类别分
    const groups = groupByCategory(places);
    if (groups.length) {
      L.push('');
      L.push('---');
      L.push('');
      L.push(`## 全部地点（共 ${(places || []).length} 处，按类别）`);
      groups.forEach((g) => {
        L.push('');
        L.push(`### ${g.name}（${g.list.length}）`);
        g.list.forEach((p) => {
          L.push(`- **${p.name}**${p.address ? '　' + p.address : ''}`);
          const bits = [];
          if (p.district) bits.push(p.district);
          if (p.minutes) bits.push(`停留 ${U.dur(p.minutes)}`);
          if (p.ticket) bits.push(`门票 ¥${p.ticket}`);
          if (p.hours) bits.push(`营业 ${p.hours}`);
          if (p.rating) bits.push(`评分 ${p.rating}`);
          if (p.cost) bits.push(`人均 ¥${p.cost}`);
          if (p.tel) bits.push(p.tel);
          if (bits.length) L.push(`  - ${bits.join(' · ')}`);
          if (p.tips) L.push(`  - 建议：${p.tips}`);
        });
      });
    }

    return L.join('\n');
  }

  function legToText(leg, from, to) {
    if (!leg) return '';
    if (leg.est || !leg.steps) {
      const verb = leg.mode === 'walking' ? '步行' : leg.mode === 'taxi' ? '打车' : '公共交通';
      return `${verb} ${U.dur(leg.minutes)}（${U.dist(leg.meters)}）→ ${to ? to.name : ''}`;
    }
    const parts = [];
    for (const s of leg.steps) {
      if (s.type === 'walk') {
        parts.push(`步行 ${U.dist(s.meters)}（${U.dur(s.minutes)}）`);
      } else if (s.type === 'ride') {
        const dir = s.direction ? `往${s.direction}` : '';
        const enter = s.fromExit ? `${s.from}（${s.fromExit}进站）` : s.from;
        parts.push(`${s.line}${dir ? ' ' + dir : ''}，${enter} → ${s.to} 下车，${s.stops != null ? s.stops + ' 站，' : ''}${U.dur(s.minutes)}`);
      } else if (s.type === 'drive') {
        parts.push(`驾车 ${U.dist(s.meters)}（${U.dur(s.minutes)}）`);
      }
    }
    const head = `${leg.mode === 'walking' ? '步行' : leg.mode === 'taxi' ? '打车' : '公共交通'} ${U.dur(leg.minutes)} · ${U.dist(leg.meters)}`;
    const fare = leg.fare ? ` · ¥${leg.fare}` : '';
    const tf = leg.transfers ? ` · 换乘 ${leg.transfers} 次` : '';
    return `${head}${fare}${tf}\n　　${parts.join(' → ')}`;
  }

  global.Planner = {
    estimateLeg,
    buildPlan,
    buildVariants,
    planStats,
    interestScore,
    mealKind,
    groupByCategory,
    scoreOrder,
    fixMealAnchors,
    scheduleDay,
    dayTimings,
    refine,
    reschedule,
    scheduleDay,
    orderDay,
    suggestDays,
    dayBudget,
    routeCost,
    planToText,
    legToText,
    centroid,
  };
})(window);
