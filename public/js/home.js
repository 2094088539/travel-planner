/**
 * 首页（dashboard）
 *
 * 由 app.js 通过 Home.mount(bridge) 注入状态与操作，自己不持有数据。
 * 视图：home（概览）/ footprint（中国地图看足迹）/ planner（原有的规划器）
 */
(function (global) {
  'use strict';

  const TILE = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';

  const S = { bridge: null, view: 'home', fpMap: null, fpLayer: null };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function state() { return S.bridge.getState(); }

  /* ---------------- 数据派生 ---------------- */
  function cityOf(p, fallback) {
    const c = String((p && p.city) || '').replace(/市$/, '').trim();
    return c || fallback || '';
  }

  function stats() {
    const st = state();
    const trip = st.trip || {};
    const places = st.places || [];
    const plan = st.plan;

    const cities = new Set();
    places.forEach((p) => { const c = cityOf(p, trip.city); if (c) cities.add(c); });

    let km = 0;
    if (plan && plan.days) {
      plan.days.forEach((d) => d.legs.forEach((l) => { km += (l.leg.meters || 0); }));
    }

    return {
      places: places.length,
      cities: cities.size,
      days: trip.days || 0,
      people: (Number(trip.adults) || 1) + (Number(trip.children) || 0),
      km: Math.round(km / 1000),
      trip,
      plan,
    };
  }

  function dateRange(trip, days) {
    if (!trip.startDate) return '未设日期';
    const d0 = new Date(trip.startDate + 'T00:00:00');
    if (isNaN(d0.getTime())) return '未设日期';
    const d1 = new Date(d0.getTime() + Math.max(0, (days || 1) - 1) * 86400000);
    const f = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
    return days > 1 ? `${f(d0)} → ${f(d1)}` : f(d0);
  }

  /* ---------------- 渲染 ---------------- */
  function renderNav() {
    const cur = S.view;
    return `<div class="home-nav">
      <div class="home-brand"><i>◎</i>行程规划</div>
      <div class="home-tabs" id="homeTabs">
        <button class="home-tab${cur === 'planner' ? ' on' : ''}" data-view="planner">我的旅行</button>
        <button class="home-tab${cur === 'footprint' ? ' on' : ''}" data-view="footprint">足迹</button>
        <button class="home-tab" data-view="favs">收藏</button>
      </div>
      <div class="home-actions">
        <button class="btn btn--ghost btn--tiny" data-view="home">首页</button>
      </div>
    </div>`;
  }

  function renderHome() {
    const d = stats();
    const trip = d.trip;
    const empty = !d.places;
    const cityName = String(trip.city || '新行程').replace(/市$/, '');

    return `${renderNav()}
    <div class="home-body">
      <div class="hero${empty ? ' hero--empty' : ''}">
        <div class="hero-top">
          <span class="hero-badge">${empty ? '新建' : '最近'}</span>
          <div class="hero-tools">
            ${empty ? '' : '<button class="hero-btn" data-act="edit" title="继续编辑">✎</button>'}
            ${empty ? '' : '<button class="hero-btn" data-act="export" title="导出导图">⤓</button>'}
          </div>
        </div>
        <div class="hero-city">${esc(cityName)}</div>
        <div class="hero-sub">${empty
          ? '空行程，去「我的旅行」搜索添加地点'
          : (d.plan && d.plan.days ? d.plan.days.length + ' 天行程已排好' : '还没有开始规划')}</div>
        <div class="ticket">
          <div class="ticket-cell"><div class="ticket-k">旅客</div><div class="ticket-v">${d.people} <small>位</small></div></div>
          <div class="ticket-cell"><div class="ticket-k">旅行日期</div><div class="ticket-v">${esc(empty ? '待定' : dateRange(trip, d.days))}</div></div>
          <div class="ticket-cell"><div class="ticket-k">地点</div><div class="ticket-v">${d.places} <small>个目的地</small></div></div>
        </div>
      </div>

      <div class="stats">
        <div class="stat stat--dark">
          <div class="stat-k">足迹 · 已去过城市</div>
          <div class="stat-v">${d.cities} <small>/ ${Math.max(d.cities, 1)}</small></div>
          <div class="stat-sub">已标记 ${d.places} 个地点</div>
        </div>
        <div class="stat">
          <div class="stat-k">旅行总数</div>
          <div class="stat-v">1 <small>次</small></div>
          <div class="stat-sub">当前这次</div>
        </div>
        <div class="stat">
          <div class="stat-k">旅行天数</div>
          <div class="stat-v">${d.days} <small>天</small></div>
          <div class="stat-sub">${d.plan ? '已排入 ' + d.plan.days.length + ' 天' : '未开始'}</div>
        </div>
        <div class="stat">
          <div class="stat-k">累计里程</div>
          <div class="stat-v">${d.km} <small>公里</small></div>
          <div class="stat-sub">${d.plan ? '按规划路线累计' : '还没规划'}</div>
        </div>
      </div>
      ${tripsSection(state().trips)}
    </div>
    <button class="home-fab" data-act="newTrip">＋ 新建行程</button>`;
  }

  /* 存档的其它行程 */
  function tripsSection(trips) {
    if (!trips || !trips.length) return '';
    const rows = trips.map((t) => {
      const city = String((t.trip && t.trip.city) || '未命名').replace(/市$/, '');
      const days = (t.trip && t.trip.days) || 0;
      const n = (t.places || []).length;
      const d = t.savedAt ? new Date(t.savedAt) : null;
      const when = d && !isNaN(d.getTime()) ? `${d.getMonth() + 1}月${d.getDate()}日` : '';
      return `<div class="trip-card" data-trip="${esc(t.id)}">
        <div class="tc-main">
          <div class="tc-city">${esc(city)}</div>
          <div class="tc-meta">${days} 天 · ${n} 个地点${when ? ' · ' + when : ''}</div>
        </div>
        <span class="tc-open">打开</span>
        <button class="tc-del" data-trip-del="${esc(t.id)}" title="删除这段行程">×</button>
      </div>`;
    }).join('');
    return `<div class="trip-block">
      <div class="trip-head">全部行程<span>${trips.length}</span></div>
      <div class="trip-list">${rows}</div>
    </div>`;
  }

  /* 足迹地图 */
  function renderFootprint() {
    return `${renderNav()}
    <div class="fp-head">
      <div class="fp-title">足迹</div>
      <div class="fp-sub" id="fpSub">正在统计…</div>
    </div>
    <div id="footprintMap"></div>`;
  }

  function drawFootprint() {
    const st = state();
    const places = st.places || [];
    const groups = new Map();
    places.forEach((p) => {
      const key = cityOf(p, st.trip.city) || '未知';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });

    const sub = document.getElementById('fpSub');
    if (sub) {
      sub.textContent = groups.size
        ? `去过 ${groups.size} 个城市 · 共标记 ${places.length} 个地点`
        : '还没有标记地点，先去规划一次行程';
    }

    if (!S.fpMap) {
      S.fpMap = L.map('footprintMap', { zoomControl: true, attributionControl: false, minZoom: 3 })
        .setView([35.5, 105], 4);
      L.tileLayer(TILE, { subdomains: ['1', '2', '3', '4'], maxZoom: 18, minZoom: 3 }).addTo(S.fpMap);
      L.control.attribution({ prefix: false, position: 'bottomright' }).addAttribution('底图 © 高德地图').addTo(S.fpMap);
      S.fpLayer = L.layerGroup().addTo(S.fpMap);
    }
    S.fpLayer.clearLayers();

    const pts = [];
    groups.forEach((list, city) => {
      const lat = list.reduce((a, p) => a + p.lat, 0) / list.length;
      const lng = list.reduce((a, p) => a + p.lng, 0) / list.length;
      pts.push([lat, lng]);
      L.marker([lat, lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="fp-pin">${esc(city)} <i>${list.length}</i></div>`,
          iconSize: [60, 22], iconAnchor: [30, 11],
        }),
        zIndexOffset: 300,
      }).addTo(S.fpLayer).bindPopup(
        `<div class="popup-title">${esc(city)}</div>`
        + list.slice(0, 8).map((p) => `<div class="popup-meta">${esc(p.name)}</div>`).join('')
      );
    });

    if (pts.length === 1) S.fpMap.setView(pts[0], 9);
    else if (pts.length > 1) S.fpMap.fitBounds(L.latLngBounds(pts).pad(0.45));
    setTimeout(() => S.fpMap.invalidateSize(), 60);
  }

  /* ---------------- 视图切换 ---------------- */
  function show(view) {
    S.view = view;
    const home = document.getElementById('homeView');
    const plan = document.getElementById('plannerView');
    if (!home || !plan) return;
    const isPlanner = view === 'planner';
    home.classList.toggle('hidden', isPlanner);
    plan.classList.toggle('hidden', !isPlanner);

    if (isPlanner) {
      if (S.bridge.onShowPlanner) S.bridge.onShowPlanner();
      return;
    }
    if (view === 'footprint') {
      home.innerHTML = renderFootprint();
      drawFootprint();
    } else if (view === 'favs') {
      openFavs();
      home.innerHTML = renderHome();
    } else {
      home.innerHTML = renderHome();
    }
  }

  function openFavs() {
    const st = state();
    const favs = (st.places || []).filter((p) => p.fav);
    const rows = favs.map((p) => `<div class="dp-row"><span class="dp-name">${esc(p.name)}</span><span class="dp-cat">${esc(p.category)}</span></div>`).join('');
    S.bridge.openSheet('收藏的地点', rows || '<div class="bud-sub">还没有收藏。在地点卡片上点 ☆ 就能收藏。</div>');
  }

  /* ---------------- 事件 ---------------- */
  let bound = false;
  function bindHome() {
    const home = document.getElementById('homeView');
    if (!home || bound) return;
    bound = true;

    home.addEventListener('click', (e) => {
      const v = e.target.closest('[data-view]');
      if (v) { show(v.dataset.view); return; }

      // 行程列表：删除按钮优先于卡片本身（不然点 × 也会打开）
      const del = e.target.closest('[data-trip-del]');
      if (del) {
        if (confirm('删除这段行程？地点会一起删掉。')) S.bridge.deleteTrip(del.dataset.tripDel);
        return;
      }
      const card = e.target.closest('[data-trip]');
      if (card) { S.bridge.openTrip(card.dataset.trip); return; }

      const a = e.target.closest('[data-act]');
      if (!a) return;
      const act = a.dataset.act;
      if (act === 'edit') { show('planner'); return; }
      if (act === 'export') { S.bridge.exportMind(); return; }

      if (act === 'newTrip') {
        const st = state();
        if (st.places && st.places.length && !confirm('新建行程会清空当前的地点，确定吗？')) return;
        S.bridge.newTrip();
      }
    });
  }

  function rerender() {
    const home = document.getElementById('homeView');
    if (!home || S.view === 'planner' || S.view === 'footprint') return;
    home.innerHTML = renderHome();
  }

  /* ---------------- 挂载 ---------------- */
  function mount(bridge) {
    S.bridge = bridge;
    const home = document.getElementById('homeView');
    if (!home) return;
    home.innerHTML = renderHome();
    bindHome();
    show('home');
  }

  global.Home = {
    mount,
    show,
    refresh() { if (S.view !== 'planner') rerender(); },
    currentView() { return S.view; },
  };
})(window);
