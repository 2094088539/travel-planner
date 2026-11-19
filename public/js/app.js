/**
 * 应用主逻辑：地图、地点、规划、渲染
 */
(function () {
  'use strict';

  const S = {
    trip: null,
    places: [],
    plan: null,
    key: '',
    cache: new Map(),
    activeDay: 0,
    selected: null,
    weather: null,
    weatherMsg: '',
    entries: [],
    sheetData: null,
    groupMode: 'district',
    collapsed: new Set(),
    busy: false,
    serverKey: false,
    relocateId: null,
    filterText: '',
    showRoutes: true,
    trips: [],
    dirty: false,
    resolveCandidates: {},
    resolveIndex: {},
    resolveState: {},
    map: null,
    markers: null,
    routes: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  /* ================= 基础 ================= */
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function defaultTrip() {
    return {
      city: '', days: 3, startDate: todayISO(),
      dayStart: '08:30', dayEnd: '21:00', pref: 'RECOMMEND',
      lunchOn: true, lunchStart: '12:00', lunchDur: 60,
      dinnerOn: true, dinnerStart: '18:00', dinnerDur: 60,
      returnHome: true, origin: null,
      fromCity: '', arrive: null, arriveTime: '', depart: null, departTime: '', returnBuffer: 0,
      adults: 2, children: 0, budgetTotal: 0, interests: [], pace: 'normal', autoTrim: true,
      lodgingPerNight: 350, mealPerPerson: 70, mealsPerDay: 2, miscPerDay: 60, longHaul: 0,
    };
  }

  function toast(msg, ms, action) {
    const el = $('#toast');
    if (action && action.label && action.onClick) {
      el.innerHTML = `<span class="toast-msg">${U.esc(msg)}</span>`
        + `<button class="toast-act" type="button">${U.esc(action.label)}</button>`;
      el.querySelector('.toast-act').onclick = () => { action.onClick(); };
    } else {
      el.textContent = msg;
    }
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), ms || 2600);
  }

  function tripModel() {
    const t = S.trip;
    return {
      city: t.city,
      days: t.days || 1,
      dayStart: U.fromHM(t.dayStart, 510),
      dayEnd: U.fromHM(t.dayEnd, 1260),
      lunchOn: !!t.lunchOn,
      lunchStart: U.fromHM(t.lunchStart, 720),
      lunchDur: t.lunchDur || 60,
      dinnerOn: t.dinnerOn !== false,
      dinnerStart: U.fromHM(t.dinnerStart, 1080),
      dinnerDur: t.dinnerDur || 60,
      returnHome: !!t.returnHome,
      origin: t.origin,
      pref: t.pref,
      startDate: t.startDate,
      adults: Math.max(1, Number(t.adults) || 1),
      children: Math.max(0, Number(t.children) || 0),
      travelers: Math.max(1, Number(t.adults) || 1) + Math.max(0, Number(t.children) || 0),
      fromCity: t.fromCity || '',
      arrive: t.arrive || null,
      arriveTime: t.arriveTime ? U.fromHM(t.arriveTime, null) : null,
      depart: t.depart || null,
      departTime: t.departTime ? U.fromHM(t.departTime, null) : null,
      returnBuffer: Math.max(0, Number(t.returnBuffer) || 0),
      interests: t.interests || [],
      pace: t.pace || 'normal',
      autoTrim: t.autoTrim !== false,
      budgetTotal: t.budgetTotal || 0,
      lodgingPerNight: t.lodgingPerNight || 0,
      mealPerPerson: t.mealPerPerson || 0,
      mealsPerDay: t.mealsPerDay != null ? t.mealsPerDay : 2,
      miscPerDay: t.miscPerDay || 0,
      longHaul: Math.max(0, Number(t.longHaul) || 0),
    };
  }

  /* 天气：用行程地理中心取预报 */
  function tripCenter() {
    const pts = S.places.filter((p) => !p.skip);
    if (S.trip.origin) return { lat: S.trip.origin.lat, lng: S.trip.origin.lng };
    if (!pts.length) return { lat: 39.9087, lng: 116.3975 };
    const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
    const lng = pts.reduce((a, p) => a + p.lng, 0) / pts.length;
    return { lat, lng };
  }

  /* ================= 存储 ================= */
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      U.store.set('state', {
        version: 3, trip: S.trip, places: S.places.map(stripRuntime),
        activeDay: S.activeDay, entries: S.entries, showRoutes: S.showRoutes !== false,
        trips: S.trips || [],
      });
    }, 400);
  }
  /* ---------------- 行程存档 ---------------- */
  function snapCurrent() {
    return {
      id: 'trip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      savedAt: Date.now(),
      trip: JSON.parse(JSON.stringify(S.trip)),
      places: S.places.map(stripRuntime),
    };
  }

  function restoreSnap(snap) {
    S.trip = Object.assign(defaultTrip(), snap.trip || {});
    S.places = (snap.places || []).map((p) => Object.assign({}, p));
    S.plan = null;
    S.cache.clear();
    S.selected = null;
    S.activeDay = 0;
    S.entries = [];
  }

  /* 有地点才值得存档，空行程不占列表 */
  function archiveCurrent() {
    if (!S.places.length) return false;
    S.trips.unshift(snapCurrent());
    return true;
  }

  function stripRuntime(p) {
    const o = {};
    for (const k of ['id', 'name', 'address', 'lat', 'lng', 'district', 'city', 'adcode',
      'category', 'categoryRaw', 'subCat', 'minutes', 'must', 'day', 'seq', 'soft',
      'winFrom', 'winTo', 'note', 'ticket', 'skip', 'meal', 'fav', 'image', 'dayAuto',
      'hours', 'hoursAi', 'rating', 'cost', 'costAi', 'amapId', 'amapAt',
      'aiNote', 'minutesAi', 'minutesUser', 'tips']) {
      if (p[k] !== undefined) o[k] = p[k];
    }
    return o;
  }
  function load() {
    const saved = U.store.get('state', null);
    if (saved && saved.trip && Array.isArray(saved.places)) {
      S.trip = Object.assign(defaultTrip(), saved.trip);
      // 老存档的「每晚回到住处」默认是关的，等于没有返程段，迁移成开
      if (!saved.version) {
        S.trip.returnHome = true;
        if (S.trip.dinnerOn == null) S.trip.dinnerOn = true;
      }
      S.places = saved.places;
      S.activeDay = saved.activeDay || 0;
      S.entries = Array.isArray(saved.entries) ? saved.entries : [];
      S.showRoutes = saved.showRoutes !== false;
      S.trips = Array.isArray(saved.trips) ? saved.trips : [];
      // 旧数据没有地区字段：从地址前缀里补一个
      S.places.forEach((p) => {
        if (!p.district && p.address) p.district = U.extractDistrict(p.address);
      });
      return true;
    }
    return false;
  }

  /* ================= API ================= */
  async function api(path, params) {
    // 单文件版：没有 Node，直接 JSONP 调腾讯接口
    if (window.TMAP_DIRECT && window.DirectApi) {
      return DirectApi.get(path, params || {}, S.key);
    }
    const url = new URL(path, location.origin);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const res = await fetch(url.toString(), {
      headers: S.key ? { 'X-Tmap-Key': S.key } : {},
    });
    let json;
    try { json = await res.json(); } catch { throw new Error('服务无响应，请确认 node server.js 正在运行'); }
    if (!json.ok) {
      const err = new Error(json.error?.message || '请求失败');
      err.hint = json.error?.hint;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  const hasDataSource = () => !!(S.key || S.serverKey);

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, S.key ? { 'X-Tmap-Key': S.key } : {}),
      body: JSON.stringify(body || {}),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error?.message || '请求失败');
    return json.data;
  }

  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  function legKey(a, b) {
    return `${S.trip.pref}|${r5(a.lat)},${r5(a.lng)}>${r5(b.lat)},${r5(b.lng)}`;
  }

  function makeLegOf(tm) {
    return function (a, b) {
      if (!a || !b) return { mode: 'walking', minutes: 1, meters: 0, est: true };
      if ((a.id && a.id === b.id) || (a.lat === b.lat && a.lng === b.lng)) {
        return { mode: 'walking', minutes: 0, meters: 0, est: true };
      }
      const hit = S.cache.get(legKey(a, b));
      return hit || Planner.estimateLeg(a, b, tm.pref);
    };
  }

  async function fetchLeg(a, b) {
    const tm = tripModel();
    const straight = U.haversine(a, b);
    const est = Planner.estimateLeg(a, b, tm.pref);
    const primaryMode = est.mode === 'walking' ? 'walking' : est.mode === 'taxi' ? 'driving' : 'transit';
    const policy = tm.pref === 'WALK_ONLY' ? 'LEAST_TIME' : tm.pref;

    const call = async (mode) => {
      const res = await api('/api/leg', {
        from: `${a.lat},${a.lng}`, to: `${b.lat},${b.lng}`, mode, policy,
      });
      const leg = res.data;
      if (mode === 'driving') leg.mode = 'taxi';
      return leg;
    };

    try {
      const leg = await call(primaryMode);
      // 短距离可能"走路比坐车快"（地铁口离得远），补一次步行比较
      if (primaryMode === 'transit' && straight < 2600 && leg.minutes >= 20) {
        try {
          const w = await call('walking');
          if (w.minutes < leg.minutes - 3) return w;
        } catch (e) { /* 步行失败就保留公交结果 */ }
      }
      return leg;
    } catch (e) {
      return Object.assign({}, est, { failed: true, failReason: e.message });
    }
  }

  /* ================= 规划 ================= */
  function setBusy(on, label) {
    S.busy = on;
    const btn = $('#btnPlan');
    btn.disabled = on;
    if (on) btn.textContent = label || '规划中…'; else updatePlanBtn();
  }

  async function plan(opts) {
    const reset = !!(opts && opts.reset);

    // 「有没有改动」必须在清 dirty 之前判断，否则这个条件永远成立
    const wasDirty = !!S.dirty;
    if (!S.places.length) { S.dirty = false; updatePlanBtn(); toast('先添加至少一个地点'); return; }
    if (S.busy) return;
    if (!reset && S.plan && !wasDirty && !collectMissing().length) {
      toast('没有改动，方案已经是最新的');
      return;
    }

    S.dirty = false;
    updatePlanBtn();

    if (reset) {
      // 自动规划：清掉手动冻结，重新分天
      S.places.forEach((p) => { p.day = null; p.seq = null; p.soft = false; });
    }

    // 严格模式：只排用户亲手挑进某天的地点，其余不参与
    const strict = S.trip.strictDays === true && S.places.some((p) => p.day != null);
    const active = strict ? S.places.filter((p) => p.day != null) : S.places;

    const tm = tripModel();
    let legOf = makeLegOf(tm);
    if (!S.trip.days) {
      tm.days = Planner.suggestDays(active, tm, legOf);
      legOf = makeLegOf(tm);
    }

    // AI 只做「哪天去哪几个点」；手动指定过分天的话，按用户的来，不覆盖
    // 只有「用户手动指定」的天才算锁；AI 自己分的天允许下次重新优化
    const hasLock = S.places.some((p) => p.day != null && !p.dayAuto);
    if (S.trip.useAI !== false && !hasLock && window.Ai && Ai.available() && S.places.length > 1) {
      setBusy(true, 'AI 分天中…');
      try {
        const assign = await Ai.planDays(active, tm);
        let stayN = 0;
        active.forEach((p) => {
          const v = assign.get(p.id);
          if (!v) return;
          p.day = v.day;
          p.seq = v.seq;          // 天内顺序也交给 AI，本地排程按 seq 落位
          p.dayAuto = true;
          if (v.why) p.aiNote = v.why;
          if (v.stay && !p.minutesUser) { p.minutes = v.stay; p.minutesAi = true; stayN++; }
        });
        toast(`AI 排好了 ${assign.size} 个点的顺序${stayN ? '，调整了 ' + stayN + ' 处停留' : ''}`, 3000);
      } catch (e) {
        toast('AI 没排成，改用内置算法：' + e.message, 4200);
      } finally {
        setBusy(false);
      }
    }

    S.plan = Planner.buildPlan(active, tm, legOf);
    S.activeDay = Math.min(S.activeDay, Math.max(0, S.plan.days.length - 1));
    renderAll();

    if (!hasDataSource()) { loadWeather(); enrichIfNeeded(); return; }

    setBusy(true, '获取路线…');
    try {
      // 轮 1：按几何分天抓真实路线
      const jobs = collectMissing();
      if (jobs.length) await runLegJobs(jobs);

      // 分天保持不变（地理分组用几何估算更稳），只按真实耗时重排，必要时跨天挪点
      const tm2 = tripModel();
      if (!S.trip.days) tm2.days = Planner.suggestDays(S.places, tm2, makeLegOf(tm2));
      S.plan = Planner.refine(S.plan, tm2, makeLegOf(tm2), { rebalance: true });
      renderAll();

      // 轮 2：补齐调整后新出现的路段，然后定稿（不再改顺序）
      const rest = collectMissing();
      if (rest.length) await runLegJobs(rest);
      const tm3 = tripModel();
      S.plan = Planner.reschedule(S.plan, tm3, makeLegOf(tm3));
      renderAll();
    } finally {
      setBusy(false);
    }
    loadWeather();
    enrichIfNeeded();
  }

  /* ---------------- AI 规划：热门路线方案（只给参考，不覆盖现有规划） ---------------- */
  function renderAiRoutes(state) {
    const body = $('#sheetBody');
    if (!body) return;
    if (state === 'loading') {
      body.innerHTML = `<div class="air-load">
        <span class="air-spin"></span>
        <div>正在生成路线方案…<br /><span class="air-dim">拿你的城市和天数去问 DeepSeek，通常 2–6 秒</span></div>
      </div>`;
      return;
    }
    if (state === 'error') {
      body.innerHTML = `<div class="air-state">
        <div class="air-title">生成失败</div>
        <div class="air-dim">${U.esc(S.aiRoutesErr || '接口没有返回')}</div>
        <button class="btn btn--primary btn--tiny" data-air-retry="1">重试</button>
      </div>`;
      return;
    }
    if (state === 'empty') {
      body.innerHTML = `<div class="air-state">
        <div class="air-title">没有拿到方案</div>
        <div class="air-dim">模型这次没给出可用路线，换一次试试，或先把城市和天数设好。</div>
        <button class="btn btn--primary btn--tiny" data-air-retry="1">重试</button>
      </div>`;
      return;
    }

    const list = S.aiRoutes || [];
    body.innerHTML = list.map((r, i) => {
      const byDay = {};
      r.spots.forEach((sp) => { (byDay[sp.d] = byDay[sp.d] || []).push(sp.n); });
      const dayLines = Object.keys(byDay).sort((a, b) => a - b)
        .map((d) => `<div class="air-day"><b>D${d}</b>${byDay[d].map((n) => `<span>${U.esc(n)}</span>`).join('')}</div>`)
        .join('');
      return `<div class="air-card">
        <div class="air-hd">
          <div>
            <div class="air-name">${U.esc(r.name)}</div>
            <div class="air-meta">${r.days} 天 · ${r.spots.length} 个地点</div>
          </div>
          <button class="btn btn--primary btn--tiny" data-route-add="${i}">加到我的规划</button>
        </div>
        ${r.desc ? `<div class="air-desc">${U.esc(r.desc)}</div>` : ''}
        <div class="air-days">${dayLines}</div>
      </div>`;
    }).join('') + `<p class="sheet-hint">
      方案由 DeepSeek 按其掌握的公开资料生成，<b>不是实时联网检索</b>；加进规划时会按名称重新定位，
      个别地点可能搜不到，会提示你。加进去之后可以照常改顺序、改停留、改分天。
    </p>`;
  }

  async function loadAiRoutes() {
    renderAiRoutes('loading');
    try {
      const routes = await Ai.proposeRoutes(
        { city: S.trip.city, days: S.trip.days },
        S.aiAsk || ''
      );
      S.aiRoutes = routes;
      renderAiRoutes(routes.length ? 'ok' : 'empty');
    } catch (e) {
      S.aiRoutesErr = e.message || String(e);
      renderAiRoutes('error');
    }
  }

  function openAiRoutes() {
    if (!window.Ai || !Ai.available()) { toast('没有可用的 DeepSeek Key'); return; }
    if (S.trip.useAI === false) { toast('设置里关掉了 AI，先打开再试'); return; }
    S.aiRoutes = null;
    S.aiRoutesErr = '';
    openSheet('AI 规划 · 热门路线', '');
    loadAiRoutes();
  }

  /* 把方案里的地点加进当前规划：按名字重新搜一遍拿到坐标，再落位到对应天 */
  async function applyRoute(idx) {
    const r = (S.aiRoutes || [])[idx];
    if (!r) return;
    if (S.places.length && !confirm(`把「${r.name}」加进当前规划？\n已有的地点保留，同名的会跳过。`)) return;

    closeSheet();
    setBusy(true, '加入中…');
    let added = 0;
    let dupN = 0;
    const fail = [];
    const perDay = {};
    for (const sp of r.spots) {
      const dup = S.places.some((p) => p.name.indexOf(sp.n) >= 0 || sp.n.indexOf(p.name) >= 0);
      if (dup) { dupN++; continue; }
      let hit = null;
      try {
        const res = await api('/api/suggest', { keyword: sp.n, region: S.trip.city });
        hit = (res.data || []).find((d) => d.lat != null && d.lng != null);
      } catch (e) { hit = null; }
      if (!hit) { fail.push(sp.n); continue; }
      const p = addPlace(Object.assign({}, hit, {
        name: hit.name || sp.n,
        minutes: sp.stay || undefined,
      }));
      const d = Math.max(0, sp.d - 1);
      perDay[d] = (perDay[d] || 0);
      p.day = d;
      p.seq = perDay[d]++;
      p.dayAuto = false;
      added++;
    }
    setBusy(false);
    save();
    renderAll();
    const bits = [];
    if (dupN) bits.push(`${dupN} 个已在规划里`);
    if (fail.length) bits.push(`${fail.length} 个没搜到（${fail.slice(0, 3).join('、')}）`);
    const tail = bits.length ? `；${bits.join('，')}` : '';
    if (added) {
      plan();
      toast(`已加入 ${added} 个地点${tail}`, 6000);
    } else {
      toast(`没有新增地点${tail || '，可能这条线和现有规划重复了'}`, 6000);
    }
  }

  /* 导出前把没写过的游玩建议补齐（攻略） */
  async function ensureTips(list) {
    const need = (list || []).filter((p) => p && !p.tips);
    if (!need.length) return 0;
    if (S.trip.useAI === false || !window.Ai || !Ai.available()) return 0;
    toast(`AI 正在写 ${need.length} 个地点的游玩建议…`, 5000);
    let map = null;
    try { map = await Ai.fillTips(need); } catch (e) { map = null; }
    if (!map || !map.size) return 0;
    S.places.forEach((p) => { if (map.has(p.id) && !p.tips) p.tips = map.get(p.id); });
    save();
    renderAll();
    return map.size;
  }

  /* 规划时补地点资料：高德优先（营业时间/评分/人均/电话/图片），高德没有的再让 AI 估 */
  function enrichIfNeeded() {
    if (!window.Amap) { fillInfoIfNeeded(); return; }
    const todo = S.places.filter((p) => !p.amapAt && p.lat != null);
    if (!todo.length) { fillInfoIfNeeded(); return; }

    toast(`正在用高德补 ${todo.length} 个地点的资料…`, 3000);
    Amap.enrichMany(todo).then((map) => {
      let n = 0;
      S.places.forEach((p) => {
        const info = map.get(p.id);
        p.amapAt = Date.now();
        if (!info) return;
        if (info.rating) p.rating = info.rating;
        if (info.cost) p.cost = info.cost;
        if (info.hours) { p.hours = info.hours; p.hoursAi = false; }
        if (info.tel) p.tel = info.tel;
        if (info.image && !p.image) p.image = info.image;
        if (info.amapId) p.amapId = info.amapId;
        n++;
      });
      save();
      renderAll();
      if (S.detailId) renderDetail();
      if (n) toast(`高德补齐 ${n} 个地点的资料`, 2600);
      fillInfoIfNeeded();
    }).catch(() => fillInfoIfNeeded());
  }

  /* 高德也没有的字段（小馆子的人均、冷门点的营业时间），让 AI 估一个参考值 */
  function fillInfoIfNeeded() {
    if (S.trip.useAI === false || !window.Ai || !Ai.available()) return;
    const items = S.places
      .filter((p) => !p.hours || (p.category === '餐饮' && !p.cost))
      .map((p) => ({
        id: p.id, name: p.name, address: p.address, city: p.city,
        district: p.district, category: p.category,
        needHours: !p.hours,
        needCost: p.category === '餐饮' && !p.cost,
      }));
    if (!items.length) return;

    Ai.fillInfo(items).then((map) => {
      if (!map.size) return;
      S.places.forEach((p) => {
        const v = map.get(p.id);
        if (!v) return;
        if (!p.hours && v.hours) { p.hours = v.hours; p.hoursAi = true; }
        if (!p.cost && v.cost) { p.cost = v.cost; p.costAi = true; }
      });
      save();
      renderAll();
      if (S.detailId) renderDetail();
      toast(`AI 补了 ${map.size} 个地点的参考信息`, 2800);
    }).catch(() => { /* 查不到就算了 */ });
  }


  function collectMissing() {
    if (!S.plan) return [];
    const seen = new Set();
    const out = [];
    for (const d of S.plan.days) {
      for (const l of d.legs) {
        const k = legKey(l.from, l.to);
        if (S.cache.has(k) || seen.has(k)) continue;
        seen.add(k);
        out.push({ key: k, a: l.from, b: l.to });
      }
    }
    return out;
  }

  /* 批量取真实路段 */
  async function runLegJobs(jobs) {
    let done = 0;
    await U.pMap(jobs, 3, async (job) => {
      const leg = await fetchLeg(job.a, job.b);
      S.cache.set(job.key, leg);
      done++;
      setBusy(true, `获取路线 ${done}/${jobs.length}`);
    });
  }

  /* 手动改完行程后，自动把缺口补成真实路线（防抖，避免连点刷配额） */
  let hydrateTimer = null;
  function scheduleHydrate(delay) {
    if (!hasDataSource()) return;
    clearTimeout(hydrateTimer);
    hydrateTimer = setTimeout(() => { hydrateMissing(); }, delay == null ? 800 : delay);
  }

  async function hydrateMissing() {
    if (S.busy || !S.plan || !S.plan.days.length) return;
    const jobs = collectMissing();
    if (!jobs.length) return;
    setBusy(true, '获取路线…');
    try {
      await runLegJobs(jobs);
      const tm = tripModel();
      S.plan = Planner.reschedule(S.plan, tm, makeLegOf(tm));
      renderAll();
    } catch (e) {
      /* 失败就保留估算，不打扰用户 */
    } finally {
      setBusy(false);
    }
  }

  /* ================= 地点操作 ================= */
  function addPlace(data) {
    const guess = U.guessCategory(data.name, data.address, data.category);
    const place = {
      id: U.uid('p'),
      name: data.name || '未命名地点',
      address: data.address || '',
      lat: data.lat,
      lng: data.lng,
      district: data.district || '',
      city: data.city || S.trip.city || '',
      adcode: data.adcode || '',
      categoryRaw: data.category || '',
      subCat: U.subCategory(data.category || ''),
      category: guess.name,
      minutes: data.minutes != null ? data.minutes : guess.minutes,
      must: data.must != null ? data.must : 1,
      day: null,
      soft: false,
      winFrom: '',
      winTo: '',
      note: '',
      ticket: data.ticket != null ? Number(data.ticket) : 0,
      meal: guess.name === '餐饮' ? (data.meal || 'lunch') : '',
      skip: false,
    };
    // 城市输入框已移除：第一个添加的地点决定目的地城市
    if (!S.places.length && place.city) {
      S.trip.city = String(place.city).replace(/市$/, '');
      if (window.Home) Home.refresh();
    }
    S.places.push(place);
    save();
    return place;
  }

  /* 按一段文字地址添加（只有门牌号、说不清 POI 名称时用） */
  async function addByAddress(text) {
    const addr = String(text || '').trim();
    if (!addr) return;
    $('#searchResults').classList.add('hidden');
    try {
      const res = await api('/api/geocode', { address: addr, region: S.trip.city });
      const d = res.data;
      if (!d || d.lat == null || d.lng == null) { toast('这个地址没解析出来，换个写法试试'); return; }

      const p = addPlace({
        name: d.name || addr,
        address: d.address || addr,
        lat: d.lat, lng: d.lng,
        district: d.district, city: d.city, adcode: d.adcode,
        category: '',
      });
      S.selected = p.id;
      $('#searchInput').value = '';
      renderAll();
      replanLight();
      if (S.map) S.map.setView([d.lat, d.lng], Math.max(S.map.getZoom(), 14));
      const low = d.similarity != null && d.similarity < 0.85;
      toast(`已添加：${p.name}${p.district ? ' · ' + p.district : ''}${low ? '　匹配度 ' + Math.round(d.similarity * 100) + '%，请在地图核对落点' : ''}`, low ? 4200 : 2600);
    } catch (e) {
      toast(e.message + (e.hint ? '　' + e.hint : ''));
    }
  }

  function removePlace(id) {
    const i = S.places.findIndex((p) => p.id === id);
    if (i < 0) return;
    S.places.splice(i, 1);
    if (S.selected === id) S.selected = null;
    save();
    replanLight();
  }

  function updatePlace(id, patch) {
    const p = S.places.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, patch);
    save();
  }

  function invalidateLegsOf(place) {
    const token = `${r5(place.lat)},${r5(place.lng)}`;
    for (const k of Array.from(S.cache.keys())) {
      if (k.includes(token)) S.cache.delete(k);
    }
  }

  /* 轻量重算：不触发网络请求，用现有缓存 + 估算 */
  /* 任何改动都只是把方案标成「待重排」，真正计算等用户点「规划」 */
  function replanLight() {
    if (!S.places.length) S.plan = null;
    S.dirty = true;
    updatePlanBtn();
    renderAll();
  }

  function updatePlanBtn() {
    const btn = $('#btnPlan');
    if (!btn) return;
    btn.classList.toggle('is-dirty', !!S.dirty && !!S.places.length);
    btn.textContent = S.dirty && S.places.length ? '规划 •' : '规划';
  }

  /* ================= 地图 ================= */
  function initMap() {
    const map = L.map('map', { zoomControl: true, attributionControl: false }).setView([39.908, 116.397], 11);
    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'],
      maxZoom: 18,
      minZoom: 3,
    }).addTo(map);
    L.control.attribution({ prefix: false, position: 'bottomright' })
      .addAttribution('底图 © 高德地图').addTo(map);

    S.map = map;
    S.markers = L.layerGroup().addTo(map);
    S.routes = L.layerGroup().addTo(map);

    map.on('click', onMapClick);
    window.addEventListener('resize', U.throttle(() => map.invalidateSize(), 200));
  }

  async function onMapClick(e) {
    const { lat, lng } = e.latlng;

    // 「在地图上重新定位」模式：把指定地点挪过来，而不是新增
    if (S.relocateId) {
      const p = S.places.find((x) => x.id === S.relocateId);
      S.relocateId = null;
      $('#mapTip').textContent = '点击地图添加地点 · 拖动标记可修正位置';
      if (!p) return;
      invalidateLegsOf(p);
      updatePlace(p.id, { lat, lng });
      replanLight();
      toast(`已把「${p.name}」移到新位置`);
      return;
    }

    toast('已添加，可在左侧改名');
  }

  function renderMap() {
    if (!S.map) return;
    S.markers.clearLayers();
    S.routes.clearLayers();

    const meta = new Map();
    if (S.plan) {
      S.plan.days.forEach((d, di) => {
        d.order.forEach((p, pi) => meta.set(p.id, { day: di, ord: pi + 1 }));
      });
    }

    // 路线（可关闭，只看点位分布）
    if (S.plan && S.showRoutes !== false) {
      S.plan.days.forEach((d, di) => {
        const color = U.DAY_COLORS[di % U.DAY_COLORS.length];
        d.legs.forEach((l) => {
          const pts = l.leg.polyline && l.leg.polyline.length > 1
            ? l.leg.polyline
            : [[l.from.lat, l.from.lng], [l.to.lat, l.to.lng]];
          L.polyline(pts, {
            color, weight: 4, opacity: 0.75,
            dashArray: l.leg.est ? '6 6' : null,
            lineCap: 'round',
          }).addTo(S.routes);
        });
      });
    }

    // 可拖动的特殊点：酒店 / 到站 / 返程站
    const pinMarker = (pt, html, popupMeta, onMove) => {
      const mk = L.marker([pt.lat, pt.lng], {
        draggable: false,
        icon: L.divIcon({ className: '', html, iconSize: [24, 24], iconAnchor: [12, 12] }),
        zIndexOffset: 500,
      }).addTo(S.markers)
        .bindPopup(`<div class="popup-title">${U.esc(pt.name)}</div><div class="popup-meta">${popupMeta} · 可拖动</div>`);
      mk.on('dragend', () => {
        const ll = mk.getLatLng();
        onMove(ll.lat, ll.lng);
      });
      return mk;
    };

    // 住处
    if (S.trip.origin && S.trip.origin.lat != null) {
      pinMarker(S.trip.origin, '<div class="mk-origin">⌂</div>', '每日出发点', (lat, lng) => {
        S.trip.origin.lat = lat;
        S.trip.origin.lng = lng;
        save();
        replanLight();
      });
    }

    // 到站 / 返程站
    if (S.trip.arrive && S.trip.arrive.lat != null) {
      pinMarker(S.trip.arrive, '<div class="mk-origin" style="background:#0f766e">到</div>', '到达站', (lat, lng) => {
        S.trip.arrive.lat = lat;
        S.trip.arrive.lng = lng;
        save();
        replanLight();
      });
    }
    if (S.trip.depart && S.trip.depart.lat != null) {
      pinMarker(S.trip.depart, '<div class="mk-origin" style="background:#b91c1c">返</div>', '返程站', (lat, lng) => {
        S.trip.depart.lat = lat;
        S.trip.depart.lng = lng;
        save();
        replanLight();
      });
    }

    // 地点
    S.places.forEach((p, idx) => {
      const m = meta.get(p.id);
      const color = m ? U.DAY_COLORS[m.day % U.DAY_COLORS.length] : '#64748b';
      const label = m ? m.ord : idx + 1;
      const marker = L.marker([p.lat, p.lng], {
        draggable: false,
        icon: L.divIcon({
          className: '',
          html: p.image
            ? `<div class="mk-dot mk-dot--img" style="background-image:url('${U.esc(p.image)}');--ring:${color}"></div>`
            : `<div class="mk-dot" style="background:${color}">${label}</div>`,
          iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -15],
        }),
        zIndexOffset: S.selected === p.id ? 900 : 100,
      }).addTo(S.markers);


      marker.bindPopup(
        `<div class="popup-title">${U.esc(p.name)}</div>` +
        `<div class="popup-meta">${U.esc(p.address || p.category)}${m ? ` · 第${m.day + 1}天 第${m.ord}站` : ''}</div>`
      );

      marker.on('click', () => {
        S.selected = p.id;
        renderPlaceList();
        scrollToList(p.id);
        openDetail(p.id);   // 点地图上的点也直接看详情
      });

      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        invalidateLegsOf(p);
        updatePlace(p.id, { lat: ll.lat, lng: ll.lng });
        replanLight();
        if (hasDataSource()) plan();
      });

      if (S.selected === p.id) marker.openPopup();
    });

    renderLegend();
  }

  function renderLegend() {
    const box = $('#mapLegend');
    if (!S.plan || !S.plan.days.length) { box.innerHTML = ''; return; }
    box.innerHTML = S.plan.days.map((d, i) => {
      const color = U.DAY_COLORS[i % U.DAY_COLORS.length];
      const dists = Array.from(new Set(d.order.map((p) => p.district).filter(Boolean)));
      const tag = dists.length ? ' · ' + dists.slice(0, 2).join('/') + (dists.length > 2 ? '…' : '') : '';
      return `<div class="lg" data-day="${i}"><span class="dot" style="background:${color}"></span>第${i + 1}天${U.esc(tag)}</div>`;
    }).join('');
    box.onclick = (e) => {
      const el = e.target.closest('.lg');
      if (el) { S.activeDay = Number(el.dataset.day); renderTabs(); renderItinerary(); }
    };
  }

  function fitBounds() {
    if (!S.map || !S.places.length) return;
    const pts = S.places.map((p) => [p.lat, p.lng]);
    ['origin', 'arrive', 'depart'].forEach((k) => {
      const o = S.trip[k];
      if (o && o.lat != null) pts.push([o.lat, o.lng]);
    });
    S.map.fitBounds(L.latLngBounds(pts).pad(0.18), { maxZoom: 15, animate: true });
  }

  /* ================= 按天指定地点 ================= */
  function dayCount() {
    return Math.max(S.trip.days || 0, (S.plan && S.plan.days.length) || 0, 1);
  }

  function renderDayAssign() {
    const box = $('#dayAssign');
    if (!box) return;
    const n = dayCount();
    let html = '';
    for (let i = 0; i < n; i++) {
      const list = S.places.filter((p) => p.day === i);
      const chips = list.map((p) => `
        <span class="da-chip" title="${U.esc(p.address || '')}">
          ${U.esc(p.name)}
          <button data-dayfree="${p.id}" title="改成自动">×</button>
        </span>`).join('');
      html += `<div class="da-day">
        <div class="da-head">
          <b>第${i + 1}天</b>
          <span class="${list.length ? 'da-count' : 'da-auto'}">${list.length ? list.length + ' 个' : '自动'}</span>
          <button class="linkbtn" data-daypick-open="${i}">选地点</button>
        </div>
        ${chips ? `<div class="da-chips">${chips}</div>` : '<div class="da-empty">没指定，按位置自动安排</div>'}
      </div>`;
    }
    box.innerHTML = html;
  }

  function openDayPicker(dayIndex) {
    S.pickDay = dayIndex;
    S.pickFilter = '';
    renderDayPicker();
  }

  function renderDayPicker() {
    const di = S.pickDay;
    if (di == null) return;
    openSheet(`第${di + 1}天 · 选地点`, `
      <input id="dayPickFilter" class="dp-search" type="search" placeholder="搜索地点" value="${U.esc(S.pickFilter || '')}" autocomplete="off" />
      <div id="dpList" class="dp-list"></div>
      <p class="sheet-hint">勾上的会锁在第 ${di + 1} 天；取消勾选就交回自动分配。</p>`);
    renderDayPickList();
    const inp = $('#dayPickFilter');
    if (inp) {
      inp.focus();
      inp.addEventListener('input', (e) => { S.pickFilter = e.target.value; renderDayPickList(); });
    }
  }

  function renderDayPickList() {
    const box = $('#dpList');
    if (!box) return;
    const di = S.pickDay;
    const kw = (S.pickFilter || '').trim().toLowerCase();
    const list = S.places.filter((p) => {
      if (!kw) return true;
      return [p.name, p.address, p.district, p.category].filter(Boolean).join(' ').toLowerCase().indexOf(kw) >= 0;
    });
    if (!list.length) {
      box.innerHTML = '<div class="bud-sub">没有匹配的地点</div>';
      return;
    }
    box.innerHTML = list.map((p) => {
      const on = p.day === di;
      const other = p.day != null && p.day !== di ? `<span class="dp-tag">第${p.day + 1}天</span>` : '';
      return `<label class="dp-row${on ? ' on' : ''}">
        <input type="checkbox" data-daypick="${p.id}"${on ? ' checked' : ''} />
        <span class="dp-name">${U.esc(p.name)}</span>
        ${other}
        <span class="dp-cat">${U.esc(p.category)}</span>
      </label>`;
    }).join('');
  }

  /* ================= 餐饮安排 ================= */
  function renderMealAssign() {
    const box = $('#mealAssign');
    if (!box) return;
    const meals = S.places.filter((p) => p.category === '餐饮' && !p.skip);
    if (!meals.length) {
      box.innerHTML = '<div class="bud-sub">还没有餐饮店。在左上角搜索「全聚德」「海底捞」或直接输地址添加。</div>';
      return;
    }

    // 从当前方案里找每家店被排在哪天几点
    const when = new Map();
    ((S.plan && S.plan.days) || []).forEach((d) => {
      d.items.forEach((it) => {
        if (it.kind === 'visit' && it.place.category === '餐饮') {
          when.set(it.place.id, { day: d.index, arrive: it.arrive, me: it.mealDev || 0 });
        }
      });
    });
    const skipped = new Set(((S.plan && S.plan.skipped) || []).map((x) => x.place.id));

    box.innerHTML = meals.map((p) => {
      const w = when.get(p.id);
      let tag;
      if (w) tag = `第${w.day + 1}天 ${U.toHM(w.arrive)}`;
      else if (skipped.has(p.id)) tag = '未排上';
      else tag = '未排';
      const warn = w && w.me > 0 ? ' warn' : '';
      return `<div class="meal-row">
        <span class="meal-name" title="${U.esc(p.name)}">${U.esc(p.name)}</span>
        <select data-meal="${p.id}">
          <option value="lunch"${(p.meal || 'lunch') === 'lunch' ? ' selected' : ''}>午餐</option>
          <option value="dinner"${p.meal === 'dinner' ? ' selected' : ''}>晚餐</option>
          <option value="snack"${p.meal === 'snack' ? ' selected' : ''}>小吃</option>
        </select>
        <span class="meal-when${warn}">${tag}</span>
      </div>`;
    }).join('');
  }

  /* ================= 渲染：地点列表 ================= */
  function renderPlaceList() {
    const box = $('#placeList');
    $('#placeCount').textContent = S.places.length;

    if (!S.places.length) {
      box.innerHTML = '<div class="empty">还没有地点。<br />搜索添加，或在地图上点一下。</div>';
      return;
    }

    // 已添加地点的本地搜索
    const kw = (S.filterText || '').trim().toLowerCase();
    const visible = S.places.filter((p) => {
      if (!kw) return true;
      const hay = [p.name, p.address, p.district, p.category, p.note].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
    if (!visible.length) {
      box.innerHTML = `<div class="empty">没有匹配「${U.esc(S.filterText)}」的地点</div>`;
      return;
    }

    const meta = new Map();
    if (S.plan) {
      S.plan.days.forEach((d, di) => d.order.forEach((p, pi) => meta.set(p.id, { day: di, ord: pi + 1 })));
    }

    const byPlan = visible.slice().sort((a, b) => {
      const ma = meta.get(a.id), mb = meta.get(b.id);
      if (ma && mb) return ma.day - mb.day || ma.ord - mb.ord;
      if (ma) return -1;
      if (mb) return 1;
      return 0;
    });

    const dayOpts = (sel) => {
      let opt = `<option value=""${sel == null ? ' selected' : ''}>自动分天</option>`;
      const n = Math.max(S.trip.days || 0, S.plan ? S.plan.days.length : 0, 1);
      for (let i = 0; i < n; i++) {
        opt += `<option value="${i}"${sel === i ? ' selected' : ''}>第${i + 1}天</option>`;
      }
      return opt;
    };

    const skippedIds = new Set(((S.plan && S.plan.skipped) || []).map((x) => x.place.id));

    const cardHTML = (p, showDistrict) => {
      const m = meta.get(p.id);
      const color = m ? U.DAY_COLORS[m.day % U.DAY_COLORS.length] : '#64748b';
      const label = m ? m.ord : (byPlan.indexOf(p) + 1);
      const distChip = showDistrict && p.district ? `<span class="pc-dist">${U.esc(p.district)}</span>` : '';
      const subChip = (p.subCat && p.subCat !== p.category) ? `<span class="pc-sub">${U.esc(p.subCat)}</span>` : '';
      return `
      <div class="place-card${S.selected === p.id ? ' is-active' : ''}${p.skip ? ' is-skipped' : ''}" data-id="${p.id}" title="${U.esc(p.categoryRaw || p.category)}">
        <div class="pc-top">
          <span class="pc-index" style="background:${color}">${label}</span>
          <input class="pc-name" value="${U.esc(p.name)}" data-act="name" spellcheck="false" />
          <button class="pc-del" data-act="del" title="删除">×</button>
        </div>
        <div class="pc-addr">${p.skip ? '<span class="pc-skip">已跳过</span>' : ''}${skippedIds.has(p.id) ? '<span class="pc-unplaced">未安排</span>' : ''}${distChip}${subChip}<span class="pc-addr-text">${U.esc(p.address || '　')}</span></div>
        <div class="pc-meta">
          <select data-act="day" title="指定第几天">${dayOpts(p.day)}</select>
          <select data-act="must" title="优先级">
            <option value="2"${p.must === 2 ? ' selected' : ''}>必去</option>
            <option value="1"${p.must === 1 ? ' selected' : ''}>想去</option>
            <option value="0"${p.must === 0 ? ' selected' : ''}>可选</option>
          </select>
          <input class="dur" type="number" min="0" max="600" step="15" value="${p.minutes}" data-act="minutes" title="停留分钟" />
          <span style="font-size:10.5px;color:var(--muted)">分</span>
          ${p.category === '餐饮' ? `<select data-act="meal" title="排到哪一餐">
            <option value="lunch"${(p.meal || 'lunch') === 'lunch' ? ' selected' : ''}>午餐</option>
            <option value="dinner"${p.meal === 'dinner' ? ' selected' : ''}>晚餐</option>
          <option value="snack"${p.meal === 'snack' ? ' selected' : ''}>小吃</option>
          </select>` : ''}
          <button class="pc-tag${p.winTo ? ' on' : ''}" data-act="win" title="限定最晚到达时间">⏰</button>
          <button class="pc-tag${p.fav ? ' on' : ''}" data-act="fav" title="${p.fav ? '取消收藏' : '收藏'}">${p.fav ? '★' : '☆'}</button>
          <button class="pc-tag" data-act="info" title="详情 / 附近推荐">ⓘ</button>
        </div>
        ${p.winTo ? `<div class="pc-meta"><span style="font-size:10.5px;color:var(--muted)">最晚到达</span>
          <input type="time" value="${p.winTo}" data-act="winTo" style="width:88px" /></div>` : ''}
      </div>`;
    };

    // 按行程：平铺，跟随分天顺序
    if ((S.groupMode || 'district') === 'plan') {
      box.innerHTML = byPlan.map((p) => cardHTML(p, true)).join('');
      return;
    }

    // 按地区：同区分组，组内仍按行程顺序
    const groups = new Map();
    for (const p of byPlan) {
      const key = p.district || '未分区';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    let html = '';
    for (const [name, items] of groups) {
      const collapsed = S.collapsed.has(name);
      const mins = items.reduce((a, p) => a + (p.minutes || 0), 0);
      html += `<div class="dist-group">
        <button class="dist-head" data-dist="${U.esc(name)}">
          <span class="dist-caret">${collapsed ? '▸' : '▾'}</span>
          <span class="dist-name">${U.esc(name)}</span>
          <span class="dist-meta">${items.length} 个 · ${U.durShort(mins)}</span>
        </button>
        ${collapsed ? '' : `<div class="dist-body">${items.map((p) => cardHTML(p, false)).join('')}</div>`}
      </div>`;
    }
    box.innerHTML = html;
  }

  function scrollToList(id) {
    const el = document.querySelector(`.place-card[data-id="${id}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ================= 渲染：摘要 / 标签 / 警告 ================= */
  function renderSummary() {
    const box = $('#summaryBar');
    if (!S.plan || !S.plan.days.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const d = S.plan.days;
    const visits = d.reduce((a, x) => a + x.order.length, 0);
    const travel = d.reduce((a, x) => a + x.totals.travel, 0);
    const fare = d.reduce((a, x) => a + x.totals.fare, 0);
    const walk = d.reduce((a, x) => a + x.totals.walk, 0);
    const skipped = (S.plan.skipped || []).length;
    box.innerHTML = `
      <div class="s-item"><span class="s-val">${d.length} 天</span><span class="s-lbl">${visits} 个地点</span></div>
      <div class="s-item"><span class="s-val">${U.durShort(travel)}</span><span class="s-lbl">在途合计</span></div>
      <div class="s-item"><span class="s-val">${walk ? U.dist(walk) : '—'}</span><span class="s-lbl">步行</span></div>
      <div class="s-item"><span class="s-val">${fare ? '¥' + Math.round(fare) : '—'}</span><span class="s-lbl">交通费</span></div>
      ${skipped ? `<div class="s-note">另有 ${skipped} 个地点因时间不足未安排，列表中已标出</div>` : ''}`;
  }

  function renderTabs() {
    const box = $('#dayTabs');
    if (!S.plan || S.plan.days.length < 2) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = S.plan.days.map((d, i) => {
      const color = U.DAY_COLORS[i % U.DAY_COLORS.length];
      return `<button class="tab${S.activeDay === i ? ' on' : ''}" data-day="${i}">
        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};margin-right:5px;vertical-align:1px"></span>第${i + 1}天</button>`;
    }).join('');
  }

  /* 提示区已取消：跨区提醒、估算提示、天气异常都太吵。
     真正影响结果的信息改放在更靠近它的地方——
     超时 → 每天标题；未安排 → 汇总条 + 地点卡片上的「未安排」标记；
     估算 → 每段路自己带「估算」标签。 */
  function renderWarnings() {
    const box = $('#warnBox');
    if (!box) return;
    const plan = S.plan;
    if (!plan || !plan.days.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }

    const lines = [];
    plan.days.forEach((d, i) => {
      const bits = [];
      if (d.overflow > 0) bits.push(`超出 ${U.durShort(d.overflow)}`);
      const late = d.items.filter((it) => it.kind === 'visit' && it.winLate > 0);
      if (late.length) {
        bits.push(`${late.length} 处晚于设定时间（${late.slice(0, 2).map((x) => x.place.name + ' ' + U.toHM(x.arrive)).join('、')}）`);
      }
      const hb = d.items.filter((it) => it.kind === 'visit' && it.hoursDev > 0);
      if (hb.length) bits.push(`${hb.length} 处超出营业时间`);
      if (bits.length) lines.push(`第 ${i + 1} 天：${bits.join('；')}`);
    });
    const skipped = plan.skipped || [];
    if (skipped.length) lines.push(`另有 ${skipped.length} 个地点没排进去`);

    // 严格模式下，没被选进任何一天的地点压根不参与，要说清楚
    if (S.trip.strictDays === true) {
      const out = S.places.filter((p) => p.day == null).length;
      if (out) lines.push(`严格模式：${out} 个未选地点不参与规划`);
    }

    if (!lines.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = lines.map((l) => `<div>${U.esc(l)}</div>`).join('');
  }

  /* ================= 渲染：行程 ================= */
  const GLYPH = { subway: '铁', bus: '巴', brt: '巴', rail: '铁', ferry: '船', maglev: '磁', walk: '步', taxi: '车' };

  function legVehicleClass(leg) {
    if (leg.mode === 'walking') return 'walk';
    if (leg.mode === 'taxi' || leg.mode === 'driving') return 'taxi';
    const rides = (leg.steps || []).filter((s) => s.type === 'ride');
    if (!rides.length) return 'walk';
    return rides[0].vehicle || 'bus';
  }

  function legCardHTML(leg, from, to, key) {
    const cls = legVehicleClass(leg);
    const glyph = GLYPH[cls] || '巴';
    let main;
    if (leg.failed) main = '路线获取失败 · 显示估算';
    else if (leg.est || !leg.steps) {
      main = leg.mode === 'walking' ? '步行' : leg.mode === 'taxi' ? '打车' : '公共交通';
    } else if (leg.mode === 'walking') main = '步行';
    else if (leg.mode === 'taxi') main = '驾车';
    else main = leg.summary || '公共交通';

    if (to && (to.isOrigin || to.id === 'origin')) main = '回住处 · ' + main;
    else if (to && to.id === 'depart') main = '去车站 · ' + main;

    const flags = [];
    if (leg.est) flags.push('<span class="leg-flag est">估算</span>');
    if (leg.failed) flags.push('<span class="leg-flag err">取路线失败</span>');
    if (leg.transfers) flags.push(`<span class="leg-flag">换乘${leg.transfers}次</span>`);
    if (leg.fare) flags.push(`<span class="leg-flag">¥${leg.fare}</span>`);

    // 纯步行段只保留「步行 + 时间 + 距离」，逐段拆解（行进 195 米、行进 143 米…）没有意义
    const plainWalk = leg.mode === 'walking' && !leg.failed && !leg.est;

    const chips = [];
    if (!plainWalk && !leg.est && leg.steps) {
      for (const s of leg.steps) {
        if (s.type === 'walk') chips.push(`<span class="chip">步行 ${U.dist(s.meters)}</span>`);
        else if (s.type === 'ride') chips.push(`<span class="chip">${U.esc(s.line)}${s.stops != null ? ` · ${s.stops}站` : ''}</span>`);
        else if (s.type === 'drive') chips.push(`<span class="chip">${U.esc(s.road || '驾车')}</span>`);
      }
    }

    const stepsHTML = [];
    if (plainWalk) {
      // 什么都不展开
    } else if (leg.est) {
      stepsHTML.push(`<div class="leg-step"><span class="bullet ${cls}">?</span><span class="st-text">该段为几何估算，未含具体线路与站点。配置腾讯位置服务 Key 后可获得真实换乘方案。</span></div>`);
    } else if (leg.steps) {
      for (const s of leg.steps) {
        if (s.type === 'walk') {
          const text = s.instruction
            ? `<span class="st-text">${U.esc(s.instruction)}</span>`
            : `<span class="st-text">步行 <b>${U.dist(s.meters)}</b></span>`;
          stepsHTML.push(`<div class="leg-step"><span class="bullet walk">步</span>
            ${text}
            <span class="st-meta">${U.dist(s.meters)} · ${U.durShort(s.minutes)}</span></div>`);
        } else if (s.type === 'ride') {
          const dir = s.direction ? ` 往${U.esc(s.direction)}方向` : '';
          const stopInfo = s.stops != null ? ` · <b>${s.stops} 站</b>` : '';
          const enter = s.fromExit ? `${U.esc(s.from)} · ${U.esc(s.fromExit)} 进站` : `${U.esc(s.from)} 上车`;
          const leave = s.toExit ? `${U.esc(s.to)} · ${U.esc(s.toExit)} 出站` : `${U.esc(s.to)} 下车`;
          const run = (s.firstTrain && s.lastTrain)
            ? `<br /><span style="color:var(--muted);font-size:10.5px">首班 ${U.esc(s.firstTrain)} · 末班 ${U.esc(s.lastTrain)}</span>`
            : '';
          stepsHTML.push(`<div class="leg-step"><span class="bullet ${s.vehicle || 'bus'}">${GLYPH[s.vehicle] || '巴'}</span>
            <span class="st-text">乘 <b>${U.esc(s.line)}</b>${dir}${stopInfo}<br />
            ${enter} → ${leave}${run}</span>
            <span class="st-meta">${U.durShort(s.minutes)}</span></div>`);
        } else if (s.type === 'drive') {
          stepsHTML.push(`<div class="leg-step"><span class="bullet taxi">车</span>
            <span class="st-text">${s.instruction ? U.esc(s.instruction) : `驾车 <b>${U.dist(s.meters)}</b>`}${s.road ? ` · ${U.esc(s.road)}` : ''}</span>
            <span class="st-meta">${U.dist(s.meters)} · ${U.durShort(s.minutes)}</span></div>`);
        }
      }
    }
    if (leg.alternativesRoutes && leg.alternativesRoutes.length) {
      stepsHTML.push(`<div class="leg-alts">另有 ${leg.alternativesRoutes.length} 个方案：${
        leg.alternativesRoutes.map((a) => `${a.minutes}分${a.transfers ? '/换' + a.transfers + '次' : ''}`).join('　')
      }</div>`);
    }

    const hasDetail = stepsHTML.length > 0;

    return `<div class="leg-card${leg.est ? ' est' : ''}${hasDetail ? '' : ' leg-card--flat'}" data-leg="${key}">
      <div class="leg-head"${hasDetail ? ' data-act="toggleLeg"' : ''}>
        <span class="leg-icon ${cls}">${glyph}</span>
        <span class="leg-main">${U.esc(main)}</span>
        ${flags.join('')}
        <span class="leg-stat"><b>${Math.round(leg.minutes)}</b>分 · ${U.dist(leg.meters)}</span>
      </div>
      ${chips.length ? `<div class="leg-chips">${chips.join('<span class="chip-sep">›</span>')}</div>` : ''}
      ${hasDetail ? `<div class="leg-detail hidden">${stepsHTML.join('')}</div>` : ''}
    </div>`;
  }

  function renderItinerary() {
    const box = $('#itinerary');
    if (!S.plan || !S.plan.days.length) {
      box.innerHTML = `<div class="empty">
        <p>标注地点后点「规划」</p>
        <p class="muted">系统会按地理位置把地点分到每一天，<br />排好游览顺序，并给出每段的地铁/步行指引。</p>
      </div>`;
      return;
    }

    const di = Math.min(S.activeDay, S.plan.days.length - 1);
    const d = S.plan.days[di];
    if (!d) { box.innerHTML = ''; return; }

    const color = U.DAY_COLORS[di % U.DAY_COLORS.length];
    const date = S.trip.startDate ? U.fmtDate(U.addDays(S.trip.startDate, di)) : '';
    const wx = (S.weather && S.weather[di]) ? S.weather[di] : null;
    const endKind = d.items.some((i) => i.kind === 'depart') ? '到站'
      : d.items.some((i) => i.kind === 'returnhome') ? '回到酒店' : '结束';
    const dayDists = Array.from(new Set(d.order.map((p) => p.district).filter(Boolean)));
    const over = d.overflow > 0
      ? `<span class="dh-chip over">超出 ${U.durShort(d.overflow)}</span>`
      : '';

    let html = `<div class="day-card">
      <div class="day-head">
        <div class="dh-row1">
          <span class="d-dot" style="background:${color}"></span>
          <span class="dh-day">第 ${di + 1} 天</span>
          <span class="dh-date">${U.esc(date)}</span>
          ${dayDists.length ? `<span class="dh-dist">${U.esc(dayDists.join(' / '))}</span>` : ''}
        </div>
        <div class="dh-row2">
          <span class="dh-chip time">${U.toHM(d.start)}–${U.toHM(d.end)}</span>
          <span class="dh-chip end">${endKind}</span>
          ${over}
        </div>
        <div class="dh-row3">
          <span><b>${U.durShort(d.totals.visit)}</b> 游览</span>
          <span><b>${U.durShort(d.totals.travel)}</b> 在途</span>
          ${d.totals.walk ? `<span><b>${U.dist(d.totals.walk)}</b> 步行</span>` : ''}
          ${wx ? `<span class="dh-chip wx${wx.rain != null && wx.rain >= 60 ? ' wet' : ''}" title="${U.esc(wx.text)}">${wx.icon} ${Math.round(wx.tmax)}°/${Math.round(wx.tmin)}°${wx.rain != null ? ' 雨' + wx.rain + '%' : ''}</span>` : ''}
        </div>
      </div>
      <div class="tl">`;

    if (!d.items.length) {
      html += `<div class="empty">这一天没有安排。可以把别天拥挤的地点拖到这里（改「第几天」）。</div>`;
    }

    let visitIdx = 0;
    for (const it of d.items) {
      if (it.kind === 'origin') {
        html += `<div class="tl-node">
          <div class="tl-time">${U.toHM(it.depart)}</div>
          <div class="tl-rail"><span class="pin" style="color:#111827">⌂</span></div>
          <div class="tl-body">
            <div class="tl-title">${U.esc(it.place.name)} <span class="tl-chip">出发</span></div>
            <div class="tl-sub">每日行程起点</div>
          </div>
        </div>`;
      } else if (it.kind === 'checkin') {
        html += `<div class="tl-node">
          <div class="tl-time">${U.toHM(it.arrive)}<small>${U.durShort(it.depart - it.arrive)}</small></div>
          <div class="tl-rail"><span class="pin" style="color:#7c3aed">店</span></div>
          <div class="tl-body">
            <div class="tl-title">${U.esc(it.place.name)} <span class="tl-chip">放行李</span></div>
            <div class="tl-sub">到店寄存，轻装出门</div>
          </div>
        </div>`;
      } else if (it.kind === 'returnhome') {
        html += `<div class="tl-node">
          <div class="tl-time">${U.toHM(it.arrive)}</div>
          <div class="tl-rail"><span class="pin" style="color:#7c3aed">店</span></div>
          <div class="tl-body">
            <div class="tl-title">${U.esc(it.place.name)} <span class="tl-chip">回到酒店</span></div>
            <div class="tl-sub">当天行程结束</div>
          </div>
        </div>`;
      } else if (it.kind === 'depart') {
        html += `<div class="tl-node">
          <div class="tl-time">${U.toHM(it.arrive)}</div>
          <div class="tl-rail"><span class="pin" style="color:#dc2626">返</span></div>
          <div class="tl-body">
            <div class="tl-title">${U.esc(it.place.name)} <span class="tl-chip must">返程</span></div>
            <div class="tl-sub">${it.noRoute
              ? '跨城返程，不规划路线（自行前往车站）'
              : '到站候车' + (S.trip.fromCity ? '，回 ' + U.esc(S.trip.fromCity) : '')}</div>
          </div>
        </div>`;
      } else if (it.kind === 'meal') {
        html += `<div class="tl-node">
          <div class="tl-time">${U.toHM(it.start)}</div>
          <div class="tl-rail"><span class="pin" style="color:#ca8a04">🍜</span></div>
          <div class="tl-body">
            <div class="tl-title">${it.type === 'dinner' ? '晚餐' : '午餐'} <span class="tl-chip meal">${U.durShort(it.end - it.start)}</span></div>
            <div class="tl-sub">就近用餐（${U.esc(it.place.name)}附近）</div>
          </div>
        </div>`;
      } else if (it.kind === 'travel') {
        const k = `${di}_${it.depart}_${it.seq}`;
        html += `<div class="tl-leg">
          <div class="tl-time">${U.toHM(it.depart)}</div>
          <div class="tl-rail"></div>
          <div class="tl-leg-body">${legCardHTML(it.leg, it.from, it.to, k)}</div>
        </div>`;
      } else if (it.kind === 'visit') {
        visitIdx++;
        const p = it.place;
        const tags = [];
        if (p.must === 2) tags.push('<span class="tl-chip must">必去</span>');
        if (p.winTo) tags.push(`<span class="tl-chip win">${p.winTo} 前到达</span>`);
        if (it.waited > 0) tags.push(`<span class="tl-chip">等其他 ${U.durShort(it.waited)}</span>`);
        if (it.hoursDev > 0) tags.push(`<span class="tl-chip over" title="${U.esc(p.hours || '')}">超出营业时间 ${U.durShort(it.hoursDev)}</span>`);
        if (it.winLate > 0) tags.push(`<span class="tl-chip over">晚于 ${p.winTo} 到达</span>`);
        html += `<div class="tl-node">
          <div class="tl-time">${U.toHM(it.arrive)}<small>${U.durShort(it.depart - it.arrive)}</small></div>
          <div class="tl-rail"><span class="pin" style="color:${color}">${visitIdx}</span></div>
          <div class="tl-body">
            <div class="tl-title"><span class="tl-name" data-detail="${p.id}">${U.esc(p.name)}</span> ${tags.join('')}
              <span class="order-btns">
                <button data-act="up" data-id="${p.id}" title="提前一位">↑</button>
                <button data-act="down" data-id="${p.id}" title="推后一位">↓</button>
              </span>
            </div>
            <div class="tl-sub">
              <span class="tl-addr">${U.esc(p.address || p.category)}</span>
              <span class="tl-stay">停留
                <input class="stay-in" type="number" min="0" max="600" step="15"
                       value="${p.minutes}" data-stay="${p.id}" /> 分
              </span>
              ${p.aiNote ? `<span class="tl-why">${U.esc(p.aiNote)}</span>` : ''}
            </div>
          </div>
        </div>`;
      }
    }

    html += `</div></div>`;
    box.innerHTML = html;
  }

  /* ================= 详情 / 附近 ================= */
  function nearbyKeyword() {
    const it = S.trip.interests || [];
    if (it.indexOf('美食') >= 0) return '餐厅';
    if (it.indexOf('购物') >= 0) return '商场';
    if (it.indexOf('人文') >= 0) return '博物馆';
    if (it.indexOf('自然') >= 0) return '公园';
    return '景点';
  }

  /* 找到某地点在行程里的前后邻居，用来算"顺路加进去要多走多久" */
  function planNeighbors(placeId) {
    for (const d of (S.plan && S.plan.days) || []) {
      const i = d.order.findIndex((x) => x.id === placeId);
      if (i >= 0) {
        return { day: d.index, prev: i > 0 ? d.order[i - 1] : S.trip.origin, next: d.order[i + 1] || null };
      }
    }
    return null;
  }

  function openDetail(id) {
    S.detailId = id;
    S.nearbyList = null;
    renderDetail();
  }

  function renderDetail() {
    const p = S.places.find((x) => x.id === S.detailId);
    if (!p) { closeSheet(); return; }
    const kw = nearbyKeyword();
    const chips = ['餐厅', '咖啡', '景点', '商场', '地铁站', '酒店'];
    openSheet(p.name, `
      <div class="dt">
        <div class="dt-row"><span>地址</span><b>${U.esc(p.address || '—')}</b></div>
        <div class="dt-row"><span>地区</span><b>${U.esc([p.city, p.district].filter(Boolean).join(' ') || '—')}</b></div>
        <div class="dt-row"><span>电话</span><b>${U.esc(p.tel || '数据源未提供')}</b></div>
        <div class="dt-row"><span>坐标</span><b>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</b></div>
        <div class="dt-row"><span>评分</span><b>${p.rating ? U.esc(p.rating) + ' 分' : '<span class="dt-na">暂无</span>'}</b></div>
      </div>

      <div class="dt-form">
        <label>分类
          <select data-dt="category">
            ${U.CATEGORIES.map((c) => `<option value="${c}"${c === p.category ? ' selected' : ''}>${c}</option>`).join('')}
          </select>
        </label>
        <label>优先级
          <select data-dt="must">
            <option value="2"${p.must === 2 ? ' selected' : ''}>必去</option>
            <option value="1"${(p.must === 1 || p.must == null) ? ' selected' : ''}>想去</option>
            <option value="0"${p.must === 0 ? ' selected' : ''}>可选</option>
          </select>
        </label>
        <label>停留分钟<input type="number" data-dt="minutes" value="${p.minutes}" min="0" step="15" /></label>
        <label>营业时间<input type="text" data-dt="hours" value="${U.esc(p.hours || '')}" placeholder="如 10:00-22:00" /></label>
        <label>分到第几天
          <select data-dt="day">
            <option value=""${p.day == null ? ' selected' : ''}>自动分天</option>
            ${Array.from({ length: Math.max(S.trip.days || 0, (S.plan && S.plan.days.length) || 0, 1) },
              (_, i) => `<option value="${i + 1}"${p.day === i ? ' selected' : ''}>第${i + 1}天</option>`).join('')}
          </select>
        </label>
        <label>人均 ¥<input type="number" data-dt="cost" value="${p.cost || ''}" min="0" step="10" placeholder="选填" /></label>
        <label>门票 ¥/人<input type="number" data-dt="ticket" value="${p.ticket || 0}" min="0" step="10" /></label>
        <label>最晚到达<input type="time" data-dt="winTo" value="${p.winTo || ''}" /></label>
      </div>

      <div class="dt-actions">
        <button class="btn btn--tiny" data-relocate="${p.id}">在地图上重定位</button>
        <button class="btn btn--tiny ${p.skip ? '' : 'btn--danger'}" data-skip="${p.id}">${p.skip ? '恢复安排' : '这次不去'}</button>
        ${p.category === '餐饮' ? `
          <span class="dt-actions-label">排到</span>
          <button class="chip-btn ${(p.meal || 'lunch') === 'lunch' ? 'on' : ''}" data-meal="${p.id}|lunch">午餐</button>
          <button class="chip-btn ${p.meal === 'dinner' ? 'on' : ''}" data-meal="${p.id}|dinner">晚餐</button>
          <button class="chip-btn ${p.meal === 'snack' ? 'on' : ''}" data-meal="${p.id}|snack">小吃</button>` : ''}
        <span class="dt-actions-label">附近：</span>
        ${chips.map((c) => `<button class="chip-btn${c === kw ? ' on' : ''}" data-nearkeyword="${c}">${c}</button>`).join('')}
      </div>

      <div id="nearBox" class="near-box"><div class="bud-sub">选一个类别，搜周边 2 公里内的地方。</div></div>`);
  }

  async function loadNearby(keyword) {
    const p = S.places.find((x) => x.id === S.detailId);
    if (!p) return;
    const box = $('#nearBox');
    if (box) box.innerHTML = '<div class="bud-sub">搜索中…</div>';
    try {
      const res = await api('/api/nearby', { lat: p.lat, lng: p.lng, radius: 2000, keyword });
      S.nearbyList = (res.data || []).filter((d) => d.name !== p.name).slice(0, 8);
      renderNearby();
    } catch (e) {
      if (box) box.innerHTML = `<div class="bud-sub">${U.esc(e.message)}</div>`;
    }
  }

  function renderNearby() {
    const box = $('#nearBox');
    if (!box) return;
    const list = S.nearbyList || [];
    if (!list.length) { box.innerHTML = '<div class="bud-sub">2 公里内没搜到。</div>'; return; }

    const nb = planNeighbors(S.detailId);
    const tm = tripModel();
    const legOf = makeLegOf(tm);

    const rows = list.map((d) => {
      const g = U.guessCategory(d.name, d.address, d.category);
      let detour = null;
      if (nb && nb.prev) {
        const prev = nb.prev;
        const add = legOf(prev, d).minutes + (nb.next ? legOf(d, nb.next).minutes : 0);
        const base = nb.next ? legOf(prev, nb.next).minutes : 0;
        detour = Math.round(add - base);
      }
      return `<div class="near-row">
        <div class="near-left">
          <div class="near-name">${U.esc(d.name)}<span class="near-cat">${g.name}</span></div>
          <div class="near-sub">${U.esc(d.address || '')}</div>
        </div>
        <div class="near-right">
          <span class="near-dist">${d.distance != null ? U.dist(d.distance) : ''}</span>
          ${detour != null ? `<span class="near-detour ${detour <= 12 ? 'good' : ''}">顺路 +${Math.max(0, detour)}分</span>` : ''}
          <button class="btn btn--tiny" data-near="${d.id}">加入</button>
        </div>
      </div>`;
    }).join('');

    box.innerHTML = `<div class="near-head">${nb ? `加进第 ${nb.day + 1} 天，看右侧绕路代价` : '这个点还没排进行程，加入后会自动排'}</div>${rows}`;
  }

  function addNearby(id) {
    const d = (S.nearbyList || []).find((x) => x.id === id);
    if (!d) return;
    const nb = planNeighbors(S.detailId);
    const p = addPlace({
      name: d.name, address: d.address, lat: d.lat, lng: d.lng,
      district: d.district, city: d.city, adcode: d.adcode, category: d.category,
    });
    if (nb) updatePlace(p.id, { day: nb.day });
    closeSheet();
    renderAll();
    replanLight();
    toast(`已加入：${p.name}${nb ? '（第 ' + (nb.day + 1) + ' 天）' : ''}`);
  }

  function toggleSkip(id) {
    const p = S.places.find((x) => x.id === id);
    if (!p) return;
    updatePlace(id, { skip: !p.skip });
    renderAll();
    replanLight();
    toast(p.skip ? `${p.name} 已跳过，不再排进行程` : `${p.name} 已恢复`);
  }

  /* ================= 思维导图（.xmind） ================= */
  async function exportMind() {
    if (!S.plan || !S.plan.days.length) { toast('还没有方案'); return; }
    await ensureTips(S.places);
    const tree = Mind.tree(S.plan, S.trip, S.places);
    const bytes = Mind.xmind(tree, S.trip);
    const name = `${S.trip.city || '行程'}-${S.trip.startDate || todayISO()}-导图`;

    // 单文件版：没有服务端，直接下载
    if (window.TMAP_DIRECT) {
      downloadBytes(`${name}.xmind`, bytes);
      toast('已下载 .xmind，双击用 XMind 打开', 4200);
      return;
    }

    // 服务端版：写到 exports/，避开 Windows 的「网络来源」拦截
    try {
      const d = await apiPost('/api/export/xmind', { name, data: bytesToBase64(bytes) });
      toast(`已保存：${d.path}`, 9000, {
        label: '打开文件夹',
        onClick: () => { api('/api/open-exports').catch(() => toast('打不开文件夹，路径见上')); },
      });
      return d;
    } catch (e) {
      downloadBytes(`${name}.xmind`, bytes);
      toast('服务端写盘失败，已改为浏览器下载：' + name + '.xmind', 5200);
    }
  }

  /* ================= 弹层 ================= */
  function openSheet(title, html) {
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    $('#sheet').classList.remove('hidden');
  }
  function closeSheet() {
    $('#sheet').classList.add('hidden');
    S.sheetData = null;
  }

  /* ================= 多方案对比 ================= */
  function showVariants() {
    if (!S.places.length) { toast('先添加地点'); return; }
    const tm = tripModel();
    const variants = Planner.buildVariants(S.places, tm, makeLegOf(tm));
    S.sheetData = variants;

    const row = (v) => {
      const st = v.stats;
      const warn = st.overflow > 0 ? `<span class="v-warn">超时 ${U.durShort(st.overflow)}</span>` : '<span class="v-ok">不超时</span>';
      const skip = st.skipped ? `<span class="v-warn">舍弃 ${st.skipped} 个</span>` : '';
      return `<div class="v-row">
        <div class="v-left">
          <div class="v-name">${v.name}<span class="v-tag">${st.days} 天</span>${warn}${skip}</div>
          <div class="v-desc">${U.esc(v.desc)}</div>
          <div class="v-stats">
            <span>覆盖 <b>${st.covered}</b></span>
            <span>在途 <b>${U.durShort(st.travel)}</b></span>
            <span>步行 <b>${U.dist(st.walk)}</b></span>
            <span>车费 <b>¥${Math.round(st.fare)}</b></span>
            <span>最长单段 <b>${st.maxHop} 分</b></span>
            <span>最晚 <b>${U.toHM(st.maxEnd)}</b></span>
          </div>
        </div>
        <button class="btn btn--tiny btn--primary" data-adopt="${v.key}">采用</button>
      </div>`;
    };

    openSheet('方案对比', `
      <p class="sheet-hint">三套方案用同一套估算模型算出，横向比一比。采用后会自动拉取真实地铁 / 公交路线重排。</p>
      <div class="v-list">${variants.map(row).join('')}</div>`);
  }

  /* ================= 天气 ================= */
  let weatherToken = 0;
  async function loadWeather() {
    if (!S.plan || !S.plan.days.length) { S.weather = null; return; }
    const c = tripCenter();
    const days = S.plan.days.length;
    const token = ++weatherToken;
    try {
      const res = await api('/api/weather', { lat: c.lat, lng: c.lng, start: S.trip.startDate, days });
      if (token !== weatherToken) return;
      S.weather = res.data.days || null;
      S.weatherMsg = '';
    } catch (e) {
      if (token !== weatherToken) return;
      S.weather = null;
      S.weatherMsg = e.message || '天气不可用';
    }
    renderItinerary();
    renderWarnings();
  }

  /* ================= 右栏分页 ================= */
  function switchTab(tab) {
    S.budgetTab = tab;
    $$('#rightTabs .rtab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('#panePlan').classList.toggle('hidden', tab !== 'plan');
    $('#paneBudget').classList.toggle('hidden', tab !== 'budget');
    if (tab === 'budget') renderBudget();
  }

  /* ================= 预算 ================= */
  function renderBudget() {
    const el = $('#paneBudget');
    if (!S.plan || !S.plan.days.length) {
      el.innerHTML = '<div class="empty">先规划一次行程，预算才算得出来。</div>';
      return;
    }
    const tm = tripModel();
    const est = Budget.estimate(S.plan, tm, S.places);
    const act = Budget.sumEntries(S.entries);
    const budget = Number(S.trip.budgetTotal) || 0;
    const pct = budget > 0 ? Math.round((est.total / budget) * 100) : 0;
    const over = budget > 0 ? est.total - budget : 0;
    const max = Math.max.apply(null, est.items.map((i) => i.amount).concat(1));

    el.innerHTML = `
      <div class="bud-card">
        <div class="bud-head">
          <span>预估合计</span>
          <b class="${over > 0 ? 'over' : ''}">¥${est.total.toLocaleString()}</b>
        </div>
        <div class="bud-sub">${est.adults} 大人${est.children ? ' + ' + est.children + ' 小孩' : ''} · ${est.days} 天 · 折合人均 ¥${est.perPerson.toLocaleString()}</div>
        ${budget > 0 ? `
          <div class="bar"><i style="width:${Math.min(100, pct)}%;background:${over > 0 ? '#dc2626' : '#2563eb'}"></i></div>
          <div class="bud-sub ${over > 0 ? 'over' : ''}">
            预算 ¥${budget.toLocaleString()}　${over > 0 ? '超支 ¥' + over.toLocaleString() : '还剩 ¥' + (budget - est.total).toLocaleString()}
          </div>`
        : '<div class="bud-sub">没填总预算，填一个才提示超支</div>'}
      </div>

      <div class="bud-list">
        ${est.items.map((i) => `
          <div class="bud-row">
            <span class="bud-dot" style="background:${i.color}"></span>
            <span class="bud-name">${i.name}</span>
            <div class="bud-bar"><i style="width:${Math.round(i.amount / max * 100)}%;background:${i.color}"></i></div>
            <span class="bud-amt">¥${i.amount.toLocaleString()}</span>
          </div>`).join('')}
      </div>

      <div class="bud-note">
        <b>交通</b> = 市内 ${est.rideLegs} 段乘车的真实票价 + 往返大交通（¥${(Number(tm.longHaul) || 0).toLocaleString()}/人）；
        门票按你填的单价 × 人数算（小孩按 6 折折算）。
        住宿 / 餐饮 / 杂费按下面单价推算，可以自己改。
        <br />营业时间 / 评分 / 人均：点「规划」时先用高德查，查不到的再由 AI 估（标 AI 的可手改）。
      </div>

      <div class="bud-card">
        <div class="bud-head"><span>单价设置</span></div>
        <div class="bud-grid">
          <label>总预算 ¥<input type="number" data-trip="budgetTotal" value="${S.trip.budgetTotal || 0}" min="0" step="500" /></label>
          <label>大人<input type="number" data-trip="adults" value="${S.trip.adults != null ? S.trip.adults : 2}" min="1" max="20" /></label>
          <label>小孩<input type="number" data-trip="children" value="${S.trip.children || 0}" min="0" max="20" /></label>
          <label>住宿 ¥/晚<input type="number" data-bud="lodgingPerNight" value="${tm.lodgingPerNight}" min="0" step="50" /></label>
          <label>餐饮 ¥/人/餐<input type="number" data-bud="mealPerPerson" value="${tm.mealPerPerson}" min="0" step="10" /></label>
          <label>每天几餐<input type="number" data-bud="mealsPerDay" value="${tm.mealsPerDay}" min="1" max="4" /></label>
          <label>杂费 ¥/天<input type="number" data-bud="miscPerDay" value="${tm.miscPerDay}" min="0" step="10" /></label>
          <label>往返大交通 ¥/人<input type="number" data-bud="longHaul" value="${tm.longHaul || 0}" min="0" step="100" /></label>
        </div>
      </div>

      <div class="bud-card">
        <div class="bud-head"><span>记账</span><span class="bud-sub">已记 ¥${act.total.toLocaleString()}</span></div>
        <div class="bud-add">
          <input id="entryInput" type="text" placeholder="午饭 128 / 打车 35 / 门票 60" />
          <button class="btn btn--tiny" id="btnAddEntry">记一笔</button>
        </div>
        ${(S.entries || []).length ? `<ul class="entry-list">${S.entries.slice().reverse().map((e) => `
          <li>
            <span class="entry-cat" style="background:${(Budget.CAT_MAP[e.cat] || {}).color || '#64748b'}"></span>
            <span class="entry-note">${U.esc(e.note)}</span>
            <span class="entry-amt">¥${Number(e.amount).toLocaleString()}</span>
            <button class="entry-del" data-del="${e.id}" title="删除">×</button>
          </li>`).join('')}</ul>`
        : '<div class="bud-sub">还没有记账记录</div>'}
      </div>`;
  }

  function addEntry() {
    const input = $('#entryInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const p = Budget.parseQuick(text);
    if (!p) { toast('没识别出金额，写成「午饭 80」这样'); return; }
    S.entries.push({ id: U.uid('e'), cat: p.cat, amount: p.amount, note: p.note, at: Date.now() });
    input.value = '';
    save();
    renderBudget();
  }

  function renderAll() {
    renderPlaceList();
    renderMap();
    renderSummary();
    renderTabs();
    renderWarnings();
    renderItinerary();
    renderMealAssign();
    renderDayAssign();
    syncDayCountLabel();
    updatePlanBtn();
    renderBadge();
    if (S.budgetTab === 'budget') renderBudget();
  }

  function renderBadge() {
    const b = $('#keyBadge');
    if (hasDataSource()) {
      b.className = 'badge badge--ok';
      b.textContent = S.key ? '真实路线已启用' : '服务端 Key 已启用';
    } else {
      b.className = 'badge badge--warn';
      b.textContent = '估算模式 · 未配置 Key';
    }
  }

  /* ================= 手动调序 ================= */
  /* 手动调整顺序：冻结当前整套方案，只交换这两个位置 */
  function moveInDay(placeId, dir) {
    if (!S.plan) return;
    const di = S.activeDay;
    const d = S.plan.days[di];
    if (!d) return;
    const order = d.order.slice();
    const i = order.findIndex((p) => p.id === placeId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];

    // 整个方案落地成固定顺序，其余天不再被打乱
    S.plan.days.forEach((day, idx) => {
      day.order.forEach((p, k) => updatePlace(p.id, { day: idx, seq: k, soft: true }));
    });
    // 本次交换覆盖掉刚写入的顺序
    order.forEach((p, k) => updatePlace(p.id, { seq: k, day: di, soft: true }));

    replanLight();
  }

  /* ================= 事件绑定 ================= */
  function bindEvents() {
    /* --- 搜索 --- */
    const input = $('#searchInput');
    const list = $('#searchResults');
    let searchTimer = null;

    const doSearch = U.debounce(async () => {
      const kw = input.value.trim();
      if (kw.length < 1) { list.classList.add('hidden'); return; }
      list.classList.remove('hidden');
      list.innerHTML = '<li class="dropdown-empty">搜索中…</li>';
      try {
        const res = await api('/api/suggest', { keyword: kw, region: S.trip.city });
        const data = res.data || [];
        if (!data.length) {
          list.innerHTML = '<li class="dropdown-empty">没找到。试试更完整的名称。</li>';
          return;
        }
        const looksAddress = /(路|街|道|巷|弄|号|区|县|镇|村|胡同|里弄|大厦|广场|院|苑)/.test(kw) && kw.length >= 4;
        const rows = data.map((d, i) => {
          const g = U.guessCategory(d.name, d.address, d.category);
          const sub = U.subCategory(d.category);
          const label = sub ? `${g.name}·${sub}` : g.name;
          const distText = d.district && !String(d.address || '').startsWith(d.district)
            ? d.district + ' · ' : '';
          return `<li data-i="${i}">
            <span class="poi-name"><span class="poi-cat">${U.esc(label)}</span>${U.esc(d.name)}</span>
            <span class="poi-addr">${U.esc(distText + (d.address || ''))}</span>
          </li>`;
        }).join('');
        const addrRow = looksAddress
          ? `<li class="poi-address-row" data-act="geocode">
               <span class="poi-name">📍 按地址定位「${U.esc(kw)}」</span>
               <span class="poi-addr">用地址解析精确落点，适合只有门牌号的酒店 / 民宿 / 小区</span>
             </li>`
          : '';
        list.innerHTML = rows + addrRow || '<li class="dropdown-empty">没找到。试试更完整的名称，或点下方按地址定位。</li>';
        list._data = data;
      } catch (e) {
        list.innerHTML = `<li class="dropdown-empty">${U.esc(e.message)}<br />${U.esc(e.hint || '')}</li>`;
      }
    }, 260);

    input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 260); });
    input.addEventListener('focus', () => { if (input.value.trim()) doSearch(); });

    list.addEventListener('click', (e) => {
      // 「按地址定位」那一行
      if (e.target.closest('li[data-act="geocode"]')) {
        addByAddress(input.value.trim());
        return;
      }
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      const d = (list._data || [])[Number(li.dataset.i)];
      if (!d) return;
      const p = addPlace({
        name: d.name,
        address: d.address,
        lat: d.lat, lng: d.lng,
        district: d.district, city: d.city, adcode: d.adcode,
        category: d.category,
      });
      S.selected = p.id;
      input.value = '';
      list.classList.add('hidden');
      renderAll();
      if (S.map) S.map.panTo([d.lat, d.lng]);
      replanLight();
      toast(`已添加：${p.name} · ${p.category}${p.district ? ' · ' + p.district : ''}`);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap')) list.classList.add('hidden');
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = list.querySelector('li[data-i]');
        if (first) { first.click(); return; }
        const addrRow = list.querySelector('li[data-act="geocode"]');
        if (addrRow) { addrRow.click(); return; }
        addByAddress(input.value.trim());
      }
      if (e.key === 'Escape') list.classList.add('hidden');
    });

    /* --- 设置 --- */
    $('#dayStart').value = S.trip.dayStart;
    $('#dayEnd').value = S.trip.dayEnd;
    $('#pref').value = S.trip.pref;
    $('#lunchOn').checked = S.trip.lunchOn;
    $('#lunchTime').value = S.trip.lunchStart;
    $('#dinnerOn').checked = S.trip.dinnerOn !== false;
    $('#dinnerTime').value = S.trip.dinnerStart || '18:00';
    $('#returnHome').checked = S.trip.returnHome;
    $('#arriveTime').value = S.trip.arriveTime || '';
    $('#departTime').value = S.trip.departTime || '';
    $('#returnBuffer').value = S.trip.returnBuffer || '';
    $('#pace').value = S.trip.pace || 'normal';
    $('#autoTrim').checked = S.trip.autoTrim !== false;
    if ($('#useAI')) $('#useAI').checked = S.trip.useAI !== false;


    const onSetting = () => {
      S.trip.dayStart = $('#dayStart').value;
      S.trip.dayEnd = $('#dayEnd').value;
      S.trip.pref = $('#pref').value;
      S.trip.lunchOn = $('#lunchOn').checked;
      S.trip.lunchStart = $('#lunchTime').value;
      S.trip.dinnerOn = $('#dinnerOn').checked;
      S.trip.dinnerStart = $('#dinnerTime').value;
      S.trip.returnHome = $('#returnHome').checked;
      S.trip.arriveTime = $('#arriveTime').value;
      S.trip.departTime = $('#departTime').value;
      S.trip.returnBuffer = Math.max(0, Number($('#returnBuffer').value) || 0);
      S.trip.pace = $('#pace').value;
      S.trip.autoTrim = $('#autoTrim').checked;
      if ($('#useAI')) S.trip.useAI = $('#useAI').checked;
      // 天数变少时，把越界的手动日重置
      S.places.forEach((p) => { if (p.day != null && S.trip.days && p.day >= S.trip.days) p.day = null; });
      S.cache.clear();
      save();
      renderOrigin();
      replanLight();
    };
    ['#dayStart', '#dayEnd', '#pref', '#lunchOn', '#lunchTime', '#returnHome',
      '#pace', '#autoTrim', '#useAI', '#dinnerOn', '#dinnerTime',
      '#arriveTime', '#departTime', '#returnBuffer']
      .forEach((sel) => {
        const el = $(sel);
        if (el) el.addEventListener('change', onSetting);
      });

    if ($('#mealAssign')) $('#mealAssign').addEventListener('change', (e) => {
      const sel = e.target.closest('[data-meal]');
      if (!sel) return;
      const pid = sel.dataset.meal;
      const patch = { meal: sel.value };
      const cur = S.places.find((x) => x.id === pid);
      if (sel.value === 'snack' && cur && (cur.minutes || 0) > 30) {
        patch.minutes = 20;
        toast(`「${cur.name}」按小吃处理，停留改为 20 分钟`);
      }
      updatePlace(pid, patch);
      replanLight();
    });


    $('#btnToggleSettings').addEventListener('click', (e) => {
      const body = $('#settingsBody');
      const hidden = body.classList.toggle('hidden');
      e.target.textContent = hidden ? '展开' : '收起';
    });

    /* --- 酒店 / 到站 / 返程：填名字自动定位 --- */
    Object.keys(RESOLVE).forEach((kind) => {
      const cfg = RESOLVE[kind];
      const inp = $(cfg.input);
      if (!inp) return;
      inp.addEventListener('change', () => resolvePlace(kind));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); resolvePlace(kind); }
      });
      const box = $(cfg.box);
      if (!box) return;
      box.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-resolve]');
        if (sel) applyResolved(kind, S.resolveCandidates[kind] || [], Number(sel.value));
      });
      box.addEventListener('click', (e) => {
        if (!e.target.closest('[data-clear]')) return;
        if (inp) inp.value = '';
        resolvePlace(kind, '');
      });
    });

    /* --- 设置分页 --- */
    const switchPane = (pane) => {
      $$('#setTabs .set-tab').forEach((b) => b.classList.toggle('on', b.dataset.pane === pane));
      ['basic', 'pref', 'days', 'trip'].forEach((k) => {
        const el = $('#setPane' + k.charAt(0).toUpperCase() + k.slice(1));
        if (el) el.classList.toggle('hidden', k !== pane);
      });
    };
    $('#setTabs').addEventListener('click', (e) => {
      const b = e.target.closest('.set-tab');
      if (b) switchPane(b.dataset.pane);
    });
    switchPane('basic');

    /* --- 天数加减 --- */
    const changeDays = (delta) => {
      const next = Math.max(1, Math.min(14, (S.trip.days || 3) + delta));
      if (next === S.trip.days) { toast(next >= 14 ? '最多 14 天' : '至少 1 天'); return; }
      S.trip.days = next;
      save();
      syncDayCountLabel();
      renderDayAssign();
      replanLight();
    };
    const plus = $('#btnDayPlus');
    const minus = $('#btnDayMinus');
    if (plus) plus.addEventListener('click', () => changeDays(1));
    if (minus) minus.addEventListener('click', () => changeDays(-1));

    /* --- 按天指定地点 --- */
    if ($('#dayAssign')) $('#dayAssign').addEventListener('click', (e) => {
      const open = e.target.closest('[data-daypick-open]');
      if (open) { openDayPicker(Number(open.dataset.daypickOpen)); return; }
      const free = e.target.closest('[data-dayfree]');
      if (free) {
        updatePlace(free.dataset.dayfree, { day: null });
        renderDayAssign();
        renderPlaceList();
        replanLight();
      }
    });

    const btnApply = $('#btnApplyDays');
    if (btnApply) btnApply.addEventListener('click', () => {
      const picked = S.places.filter((p) => p.day != null);
      if (!picked.length) { toast('先在每天里「选地点」，再点应用'); return; }
      const rest = S.places.length - picked.length;
      S.trip.strictDays = true;
      save();
      updateStrictTag();
      plan();
      toast(`按你选的 ${picked.length} 个地点规划${rest ? `，未选的 ${rest} 个不参与` : ''}`, 4000);
    });

    const btnAuto = $('#btnAutoDays');
    if (btnAuto) btnAuto.addEventListener('click', () => {
      S.trip.strictDays = false;
      save();
      updateStrictTag();
      S.dirty = true;
      updatePlanBtn();
      toast('已恢复自动补点，点「规划」重排');
    });

    // 选择弹层里的勾选
    $('#sheetBody').addEventListener('change', (e) => {
      const dp = e.target.closest('[data-daypick]');
      if (!dp) return;
      updatePlace(dp.dataset.daypick, { day: dp.checked ? S.pickDay : null, dayAuto: false });
      renderDayPickList();
      renderDayAssign();
      renderPlaceList();
      replanLight();
    });

    /* --- 行程里直接改停留 --- */
    $('#itinerary').addEventListener('change', (e) => {
      const inp = e.target.closest('[data-stay]');
      if (!inp) return;
      const id = inp.dataset.stay;
      const v = Math.max(0, Math.min(600, Number(inp.value) || 0));
      updatePlace(id, { minutes: v, minutesUser: true, minutesAi: false });
      renderPlaceList();
      replanLight();
    });

    /* --- 已添加地点搜索 --- */
    $('#placeFilter').addEventListener('input', (e) => {
      S.filterText = e.target.value;
      renderPlaceList();
    });
    $('#placeFilter').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.target.value = ''; S.filterText = ''; renderPlaceList(); }
    });

    /* --- 路线开关 --- */
    $('#toggleRoutes').checked = S.showRoutes !== false;
    $('#toggleRoutes').addEventListener('change', (e) => {
      S.showRoutes = e.target.checked;
      save();
      renderMap();
      toast(S.showRoutes ? '已显示路线' : '已隐藏路线，只看点位');
    });

    /* --- 分组方式切换 --- */
    $('#groupSwitch').addEventListener('click', (e) => {
      const b = e.target.closest('.seg');
      if (!b) return;
      S.groupMode = b.dataset.mode;
      $$('#groupSwitch .seg').forEach((x) => x.classList.toggle('on', x.dataset.mode === S.groupMode));
      renderPlaceList();
    });

    /* --- 地点卡片 - 事件委托 --- */
    const plist = $('#placeList');

    plist.addEventListener('click', (e) => {
      // 地区分组标题：折叠 / 展开
      const head = e.target.closest('.dist-head');
      if (head) {
        const key = head.dataset.dist;
        if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key);
        renderPlaceList();
        return;
      }
      const card = e.target.closest('.place-card');
      if (!card) return;
      const id = card.dataset.id;
      const act = e.target.dataset.act;
      if (act === 'del') { removePlace(id); return; }
      if (act === 'info') { openDetail(id); return; }
      if (act === 'fav') {
        const p = S.places.find((x) => x.id === id);
        if (!p) return;
        updatePlace(id, { fav: !p.fav });
        renderPlaceList();
        if (window.Home) Home.refresh();
        toast(p.fav ? `已收藏「${p.name}」` : `已取消收藏「${p.name}」`);
        return;
      }
      if (act === 'win') {
        const p = S.places.find((x) => x.id === id);
        updatePlace(id, { winTo: p.winTo ? '' : '17:00' });
        renderPlaceList();
        replanLight();
        return;
      }
      // 点在输入框/下拉上时只切选中态，不重绘，否则输入焦点会丢
      if (e.target.closest('input, select, textarea, button')) {
        if (S.selected !== id) {
          S.selected = id;
          $$('.place-card').forEach((c) => c.classList.toggle('is-active', c.dataset.id === id));
        }
        return;
      }
      S.selected = id;
      renderPlaceList();
      renderMap();
    });

    plist.addEventListener('input', (e) => {
      const card = e.target.closest('.place-card');
      if (!card) return;
      const id = card.dataset.id;
      const act = e.target.dataset.act;
      if (act === 'name') updatePlace(id, { name: e.target.value });
      if (act === 'minutes') updatePlace(id, { minutes: Math.max(0, Number(e.target.value) || 0) });
    });

    plist.addEventListener('change', (e) => {
      const card = e.target.closest('.place-card');
      if (!card) return;
      const id = card.dataset.id;
      const act = e.target.dataset.act;
      if (act === 'day') {
        const v = e.target.value === '' ? null : Number(e.target.value);
        updatePlace(id, { day: v, seq: null, soft: false, dayAuto: false });
        replanLight();
        if (hasDataSource()) plan();
      }
      if (act === 'must') { updatePlace(id, { must: Number(e.target.value) }); replanLight(); }
      if (act === 'meal') {
        const patch = { meal: e.target.value };
        const cur = S.places.find((x) => x.id === id);
        // 小吃是顺路买的，停留不该按正餐算
        if (e.target.value === 'snack' && cur && (cur.minutes || 0) > 30) {
          patch.minutes = 20;
          toast(`「${cur.name}」按小吃处理，停留改为 20 分钟`);
        }
        updatePlace(id, patch);
        replanLight();
      }
      if (act === 'winTo') {
        updatePlace(id, { winTo: e.target.value });
        renderPlaceList();
        replanLight();
      }
    });

    /* --- 行程面板 --- */
    $('#itinerary').addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-act="toggleLeg"]');
      if (toggle) {
        const box = toggle.parentElement.querySelector('.leg-detail');
        if (box) box.classList.toggle('hidden');
        return;
      }
      const dt = e.target.closest('[data-detail]');
      if (dt) { openDetail(dt.dataset.detail); return; }
      const up = e.target.closest('[data-act="up"]');
      if (up) { moveInDay(up.dataset.id, -1); return; }
      const down = e.target.closest('[data-act="down"]');
      if (down) { moveInDay(down.dataset.id, 1); return; }
    });

    $('#dayTabs').addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (!t) return;
      S.activeDay = Number(t.dataset.day);
      renderTabs();
      renderItinerary();
    });

    /* --- 右栏分页 / 预算 --- */
    $('#rightTabs').addEventListener('click', (e) => {
      const b = e.target.closest('.rtab');
      if (b) switchTab(b.dataset.tab);
    });

    $('#paneBudget').addEventListener('change', (e) => {
      const bud = e.target.dataset.bud;
      const tripKey = e.target.dataset.trip;
      if (bud) {
        S.trip[bud] = Math.max(0, Number(e.target.value) || 0);
      } else if (tripKey) {
        const v = Math.max(0, Number(e.target.value) || 0);
        if (tripKey === 'adults') S.trip.adults = Math.max(1, v || 1);
        else S.trip.children = v;
        if (tripKey === 'budgetTotal') S.trip.budgetTotal = v;
      } else {
        return;
      }
      save();
      renderBudget();
    });

    $('#paneBudget').addEventListener('click', (e) => {
      if (e.target.id === 'btnAddEntry') { addEntry(); return; }
      const del = e.target.dataset.del;
      if (del) {
        S.entries = S.entries.filter((x) => x.id !== del);
        save();
        renderBudget();
      }
    });

    $('#paneBudget').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'entryInput') addEntry();
    });

    /* --- 弹层 --- */
    $('#sheetClose').addEventListener('click', closeSheet);
    $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
    $('#sheetBody').addEventListener('change', (e) => {
      const k = e.target.dataset.dt;
      if (!k || !S.detailId) return;
      const patch = {};
      if (k === 'winTo') patch.winTo = e.target.value;
      else if (k === 'category') patch.category = e.target.value;
      else if (k === 'image') patch.image = e.target.value.trim();
      else if (k === 'hours') { patch.hours = e.target.value.trim(); patch.hoursAi = false; }
      else if (k === 'cost') { patch.cost = Math.max(0, Number(e.target.value) || 0); patch.costAi = false; }
      else if (k === 'must') patch.must = Number(e.target.value) || 0;
      else if (k === 'day') {
        patch.day = e.target.value === '' ? null : Number(e.target.value) - 1;
        patch.dayAuto = false;
        patch.seq = null;
      }
      else { patch[k] = Math.max(0, Number(e.target.value) || 0); if (k === 'minutes') { patch.minutesUser = true; patch.minutesAi = false; } }
      updatePlace(S.detailId, patch);
      renderPlaceList();
      replanLight();
      if (k === 'hours' || k === 'cost' || k === 'day' || k === 'must') renderDetail();
    });

    $('#sheetBody').addEventListener('click', (e) => {
      if (e.target.closest('[data-air-retry]')) { loadAiRoutes(); return; }
      const addRoute = e.target.closest('[data-route-add]');
      if (addRoute) { applyRoute(Number(addRoute.dataset.routeAdd)); return; }

      const adopt = e.target.closest('[data-adopt]');
      if (adopt && Array.isArray(S.sheetData)) {
        const v = S.sheetData.find((x) => x.key === adopt.dataset.adopt);
        if (!v) return;
        S.trip.days = v.trip.days;
        S.trip.pace = v.trip.pace;
        syncDayCountLabel();
        $('#pace').value = v.trip.pace;
        closeSheet();
        save();
        plan({ reset: true });
        return;
      }
      const near = e.target.closest('[data-near]');
      if (near) { addNearby(near.dataset.near); return; }
      const nk = e.target.closest('[data-nearkeyword]');
      if (nk) { loadNearby(nk.dataset.nearkeyword); return; }
      const rl = e.target.closest('[data-relocate]');
      if (rl) {
        S.relocateId = rl.dataset.relocate;
        const p = S.places.find((x) => x.id === S.relocateId);
        closeSheet();
        $('#mapTip').textContent = `点地图，把「${p ? p.name : '该地点'}」移过去（或直接拖标记）`;
        toast('在地图上点一下即可改位置；Esc 取消');
        return;
      }

      const sk = e.target.closest('[data-skip]');
      if (sk) { toggleSkip(sk.dataset.skip); closeSheet(); return; }
      const ml = e.target.closest('[data-meal]');
      if (ml) {
        const [pid, kind] = ml.dataset.meal.split('|');
        updatePlace(pid, { meal: kind });
        renderDetail();
        replanLight();
      }
    });

    /* --- 顶栏 --- */
    $('#btnVariant').addEventListener('click', showVariants);
    $('#btnPlan').addEventListener('click', () => plan());
    $('#btnClearAll').addEventListener('click', () => {
      if (!S.places.length) return;
      if (!confirm('清空所有地点？')) return;
      S.places = [];
      S.plan = null;
      S.cache.clear();
      save();
      renderAll();
    });

    $('#btnSample').addEventListener('click', () => {
      if (S.places.length && !confirm('载入示例会覆盖当前地点，继续？')) return;
      loadSample();
    });

    /* --- Key 弹窗 --- */
    const modal = $('#modal');
    $('#btnKey').addEventListener('click', () => {
      $('#keyInput').value = S.key;
      $('#keyTestResult').classList.add('hidden');
      modal.classList.remove('hidden');
    });
    $('#keyBadge').addEventListener('click', () => $('#btnKey').click());
    $('#btnKeyCancel').addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    $('#btnKeySave').addEventListener('click', async () => {
      const k = $('#keyInput').value.trim();
      const box = $('#keyTestResult');
      box.classList.remove('hidden', 'ok', 'bad');
      if (!k) {
        S.key = '';
        U.store.set('key', '');
        S.cache.clear();
        renderBadge();
        box.className = 'key-result bad';
        box.textContent = '已清空，切回估算模式。';
        return;
      }
      box.textContent = '校验中…';
      S.key = k;
      try {
        const res = await api('/api/health');
        if (res.ok) {
          box.className = 'key-result ok';
          box.textContent = `Key 可用。示例：${res.sample.summary}，${res.sample.minutes} 分钟。`;
          U.store.set('key', k);
          S.cache.clear();
          renderBadge();
          setTimeout(() => { modal.classList.add('hidden'); plan(); }, 700);
        } else {
          box.className = 'key-result bad';
          box.textContent = res.message || '校验未通过';
          S.key = '';
        }
      } catch (e) {
        box.className = 'key-result bad';
        box.textContent = e.message + (e.hint ? '　' + e.hint : '');
        S.key = e.status === 401 ? '' : S.key;
      }
    });

    /* --- 导出 --- */
    $('#btnCopy').addEventListener('click', async () => {
      if (!S.plan) { toast('还没有方案'); return; }
      const text = Planner.planToText(S.plan, tripModel(), S.places);
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制到剪贴板');
      } catch {
        toast('复制失败，请用「导出 MD」');
      }
    });
    $('#btnExportMD').addEventListener('click', async () => {
      if (!S.plan) { toast('还没有方案'); return; }
      const got = await ensureTips(S.places);
      const text = Planner.planToText(S.plan, tripModel(), S.places);
      download(`行程方案-${S.trip.city || '未命名'}-${S.trip.startDate || todayISO()}.md`, text, 'text/markdown');
      if (got) toast(`已导出，含 ${got} 条新增攻略`, 3000);
    });
    $('#btnMind').addEventListener('click', exportMind);
    $('#btnAiRoute').addEventListener('click', openAiRoutes);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        S.relocateId = null;
        $('#mapTip').textContent = '点击地图添加地点 · 拖动标记可修正位置';
        $('#modal').classList.add('hidden');
        $('#sheet').classList.add('hidden');
        $('#searchResults').classList.add('hidden');
      }
    });
  }

  function bytesToBase64(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function downloadBytes(filename, bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ================= 填名字自动定位（不用点地图） ================= */
  const RESOLVE = {
    origin: { label: '酒店', input: '#originInput', box: '#originResolve', field: 'origin' },
    arrive: { label: '到达站', input: '#arriveInput', box: '#arriveResolve', field: 'arrive' },
    depart: { label: '返程站', input: '#departInput', box: '#departResolve', field: 'depart' },
  };

  async function resolvePlace(kind, rawText) {
    const cfg = RESOLVE[kind];
    if (!cfg) return;
    const inp = $(cfg.input);
    const text = String(rawText != null ? rawText : (inp ? inp.value : '')).trim();

    if (!text) {
      S.trip[cfg.field] = null;
      S.resolveCandidates[kind] = [];
      S.resolveState[kind] = {};
      save();
      renderResolve(kind);
      replanLight();
      return;
    }

    S.resolveState[kind] = { loading: true, q: text };
    renderResolve(kind);

    try {
      const res = await api('/api/suggest', { keyword: text, region: S.trip.city });
      const list = (res.data || []).filter((d) => d.lat && d.lng).slice(0, 6);
      if (!list.length) throw new Error('没有匹配的地点');
      let idx = list.findIndex((d) => d.name === text);
      if (idx < 0) idx = 0;
      applyResolved(kind, list, idx);
    } catch (e) {
      S.trip[cfg.field] = null;
      S.resolveCandidates[kind] = [];
      S.resolveState[kind] = { failed: true, q: text, msg: e.message };
      save();
      renderResolve(kind);
      replanLight();
    }
  }

  function applyResolved(kind, list, idx) {
    const cfg = RESOLVE[kind];
    const d = (list || [])[idx];
    if (!d) return;
    S.trip[cfg.field] = {
      id: kind, name: d.name, lat: d.lat, lng: d.lng,
      district: d.district || '', city: d.city || '',
    };
    S.resolveCandidates[kind] = list;
    S.resolveIndex[kind] = idx;
    S.resolveState[kind] = {};
    const inp = $(cfg.input);
    if (inp && inp.value.trim() !== d.name) inp.value = d.name;
    save();
    renderResolve(kind);
    replanLight();
  }

  function renderResolve(kind) {
    const cfg = RESOLVE[kind];
    if (!cfg) return;
    const box = $(cfg.box);
    if (!box) return;
    const st = S.resolveState[kind] || {};
    const p = S.trip[cfg.field];

    if (st.loading) { box.innerHTML = '<span class="resolve-tip">定位中…</span>'; return; }

    if (!p) {
      box.innerHTML = st.failed
        ? `<span class="resolve-fail">没找到「${U.esc(st.q)}」${st.msg ? '：' + U.esc(st.msg) : ''}</span>`
        : '';
      return;
    }

    const list = S.resolveCandidates[kind] || [];
    const idx = S.resolveIndex[kind] || 0;
    const pick = list.length > 1
      ? `<select class="resolve-pick" data-resolve="${kind}">${list.map((c, i) =>
        `<option value="${i}"${i === idx ? ' selected' : ''}>${U.esc(c.name)}${c.district ? ' · ' + U.esc(c.district) : ''}</option>`).join('')}</select>`
      : '';
    box.innerHTML = `<span class="resolve-ok">✓ ${U.esc(p.name)}${p.district ? ' · ' + U.esc(p.district) : ''}</span>${pick}<button class="linkbtn" data-clear="${kind}">清除</button>`;
  }

  function updateTripDot() {
    const dot = $('#tripDot');
    if (!dot) return;
    const missing = !S.trip.origin || !S.trip.arrive || !S.trip.depart;
    dot.classList.toggle('hidden', !missing);
  }

  function renderOrigin() {
    Object.keys(RESOLVE).forEach((k) => renderResolve(k));
    updateTripDot();
  }

  function syncPlaceInputs() {
    const map = { origin: S.trip.origin, arrive: S.trip.arrive, depart: S.trip.depart };
    Object.keys(RESOLVE).forEach((k) => {
      const cfg = RESOLVE[k];
      const inp = $(cfg.input);
      if (inp) inp.value = map[k] ? map[k].name : '';
      S.resolveCandidates[k] = map[k] ? [map[k]] : [];
      S.resolveIndex[k] = 0;
      S.resolveState[k] = {};
      renderResolve(k);
    });
    updateTripDot();
  }

  /* ================= 示例 ================= */
  function loadSample() {
    const s = window.SAMPLE_TRIP;
    S.trip = Object.assign(defaultTrip(), s.trip, { startDate: S.trip.startDate || todayISO(), days: s.trip.days });
    S.places = s.places.map((p) => Object.assign({
      id: U.uid('p'), must: 1, day: null, winFrom: '', winTo: '', note: '',
    }, p));
    S.cache.clear();
    S.activeDay = 0;
    S.selected = null;
    syncSettingsUI();
    save();
    syncPlaceInputs();
    fitBounds();
    S.dirty = true;
    renderAll();
    toast('示例已载入，点「规划」开始排路线');
  }

  function updateStrictTag() {
    const tag = $('#strictTag');
    if (tag) tag.classList.toggle('hidden', S.trip.strictDays !== true);
  }

  function syncDayCountLabel() {
    updateStrictTag();
    const el = $('#dayCountLabel');
    if (el) el.textContent = `${S.trip.days || 3} 天`;
    const box = $('#dayAssign');
    if (box) renderDayAssign();
  }

  function syncSettingsUI() {
    $('#dayStart').value = S.trip.dayStart;
    $('#dayEnd').value = S.trip.dayEnd;
    $('#pref').value = S.trip.pref;
    $('#lunchOn').checked = S.trip.lunchOn;
    $('#lunchTime').value = S.trip.lunchStart;
    $('#dinnerOn').checked = S.trip.dinnerOn !== false;
    $('#dinnerTime').value = S.trip.dinnerStart || '18:00';
    $('#returnHome').checked = S.trip.returnHome;
    $('#arriveTime').value = S.trip.arriveTime || '';
    $('#departTime').value = S.trip.departTime || '';
    $('#returnBuffer').value = S.trip.returnBuffer || '';
    $('#pace').value = S.trip.pace || 'normal';
    $('#autoTrim').checked = S.trip.autoTrim !== false;
    if ($('#useAI')) $('#useAI').checked = S.trip.useAI !== false;
  }

  /* ================= 启动 ================= */
  async function boot() {
    S.key = U.store.get('key', '') || window.TMAP_KEY_DEFAULT || (window.APP_CONFIG && window.APP_CONFIG.tmapKey) || '';
    S.trip = defaultTrip();

    const had = load();
    // 地图延后到第一次进入规划器时再初始化：首屏是首页，容器隐藏时 Leaflet 量不到尺寸
    bindEvents();
    syncPlaceInputs();

    // 先确认服务端有没有内置 Key，再决定要不要走真实路线
    if (window.TMAP_DIRECT) { renderBadge(); }
    else try {
      const res = await fetch('/api/config');
      const j = await res.json();
      if (j && j.ok && j.data && j.data.hasKey) S.serverKey = true;
    } catch (e) { /* 忽略 */ }
    renderBadge();

    if (!had) {
      loadSample();
    } else {
      S.dirty = S.places.length > 0;
      renderAll();
      if (S.places.length) fitBounds();
    }

    // 首页（dashboard）：状态与操作通过 bridge 暴露给它
    if (window.Home) {
      Home.mount({
        getState: () => S,
        openSheet: (title, html) => openSheet(title, html),
        exportMind: () => exportMind(),
        // 新建行程：当前这份先存起来，再开一张白纸
        newTrip: () => {
          const kept = archiveCurrent();
          restoreSnap({ trip: Object.assign(defaultTrip(), { days: 3 }), places: [] });
          save();
          syncSettingsUI();
          syncPlaceInputs();
          renderAll();
          if (window.Home) Home.show('planner');
          toast(kept ? '已保存上一段行程，这是新的空行程' : '新建了一个空行程，搜索添加地点');
        },

        // 打开存档：把当前这份存回去，再把目标取出来
        openTrip: (id) => {
          const i = S.trips.findIndex((t) => t.id === id);
          if (i < 0) return;
          const target = S.trips[i];
          const cur = S.places.length ? snapCurrent() : null;
          S.trips.splice(i, 1);
          if (cur) S.trips.unshift(cur);
          restoreSnap(target);
          save();
          syncSettingsUI();
          syncPlaceInputs();
          renderAll();
          if (window.Home) Home.show('planner');
          toast(`已打开「${target.trip && target.trip.city ? target.trip.city : '行程'}」`);
        },

        deleteTrip: (id) => {
          const i = S.trips.findIndex((t) => t.id === id);
          if (i < 0) return;
          const name = (S.trips[i].trip && S.trips[i].trip.city) || '行程';
          S.trips.splice(i, 1);
          save();
          if (window.Home) Home.refresh();
          toast(`已删除「${name}」`);
        },
        onShowPlanner: () => {
          if (!S.map) initMap();
          setTimeout(() => {
            if (!S.map) return;
            S.map.invalidateSize();
            // 地图是延后创建的，之前的 renderMap 被跳过了，这里补一次
            renderMap();
            if (!S.map._fitted && S.places.length) { S.map._fitted = true; fitBounds(); }
          }, 60);
        },
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
