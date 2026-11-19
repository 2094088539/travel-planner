/**
 * 浏览器直连腾讯位置服务（JSONP）
 *
 * 单文件版没有 Node 代理，所有请求走 JSONP：
 *   - 腾讯接口不返回 CORS 头，但支持 output=jsonp
 *   - 个人 Key 的 QPS 很低，这里排队串行 + 最小间隔 280ms + 限流退避重试
 *   - 响应解析复用 TmapNorm（与服务端同一份代码）
 */
(function (global) {
  'use strict';

  const BASE = 'https://apis.map.qq.com/ws';
  const INTERVAL = 280;
  const RETRIES = 4;

  let chain = Promise.resolve();
  let lastAt = 0;
  let seq = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function schedule(fn) {
    const run = chain.then(async () => {
      const wait = lastAt + INTERVAL - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      return fn();
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const name = '__tmap_cb_' + (++seq);
      const script = document.createElement('script');
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete global[name]; } catch (e) { global[name] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      };

      const timer = setTimeout(() => { finish(); reject(new Error('请求超时，检查网络')); }, 15000);

      global[name] = (data) => { finish(); resolve(data); };
      script.onerror = () => { finish(); reject(new Error('网络请求失败')); };
      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'output=jsonp&callback=' + name;
      document.head.appendChild(script);
    });
  }

  const norm = () => global.TmapNorm;

  async function call(path, params, key, attempt) {
    if (!key) {
      const e = new Error('未配置腾讯位置服务 Key');
      e.hint = '点右上角「数据源」填入 Key';
      throw e;
    }
    const tries = attempt || 0;
    const qs = Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .map((k) => k + '=' + encodeURIComponent(params[k]))
      .join('&');
    const url = BASE + path + '?' + (qs ? qs + '&' : '') + 'key=' + encodeURIComponent(key);

    const json = await schedule(() => jsonp(url));

    if (json.status === 120 && tries < RETRIES) {
      await sleep(400 * Math.pow(2, tries));
      return call(path, params, key, tries + 1);
    }
    if (json.status !== 0) {
      const e = new Error(json.message || ('接口返回 status=' + json.status));
      e.tmapStatus = json.status;
      if ([311, 375, 110, 111, 112].indexOf(json.status) >= 0) {
        e.hint = 'Key 无效或没开通 WebServiceAPI';
      }
      throw e;
    }
    return json;
  }

  /* ---------------- 各接口 ---------------- */

  function mapPoi(d, flat) {
    const ad = flat ? d : (d.ad_info || {});
    return {
      id: d.id,
      name: d.title,
      address: d.address || '',
      lat: d.location && d.location.lat,
      lng: d.location && d.location.lng,
      category: d.category || '',
      type: d.type,
      district: flat ? (d.district || '') : (ad.district || ''),
      city: flat ? (d.city || '') : (ad.city || ''),
      province: flat ? (d.province || '') : (ad.province || ''),
      adcode: flat ? (d.adcode || '') : (ad.adcode || ''),
      tel: d.tel || '',
      distance: d._distance != null ? Math.round(Number(d._distance)) : null,
      kind: 'poi',
    };
  }

  async function suggest(params, key) {
    const json = await call('/place/v1/suggestion', {
      keyword: params.keyword || '',
      region: params.region || '',
      region_fix: 0,
      page_size: 10,
    }, key);
    // suggestion 的 data 在顶层，没有 result 包裹
    return (json.data || []).map((d) => mapPoi(d, true)).filter((d) => d.lat && d.lng);
  }

  async function search(params, key) {
    const region = params.region || '';
    const json = await call('/place/v1/search', {
      keyword: params.keyword || '',
      boundary: region ? 'region(' + region + ',0)' : 'region(全国,0)',
      page_size: 10,
      page_index: 1,
      orderby: '_distance',
    }, key);
    // place/v1/search 的 data 也在顶层（没有 result 包裹）
    const payload = json.result || json;
    return (payload.data || []).map((d) => mapPoi(d, false)).filter((d) => d.lat && d.lng);
  }

  async function nearby(params, key) {
    const json = await call('/place/v1/search', {
      keyword: params.keyword || '',
      boundary: 'nearby(' + params.lat + ',' + params.lng + ',' + (params.radius || 1500) + ',1)',
      page_size: 12,
      orderby: '_distance',
    }, key);
    const payload = json.result || json;
    return (payload.data || []).map((d) => mapPoi(d, false)).filter((d) => d.lat && d.lng);
  }

  async function geocode(params, key) {
    const raw = String(params.address || '').trim();
    if (!raw) throw new Error('缺少地址');
    const region = String(params.region || '').trim();
    // 腾讯地址解析必须带城市，否则返回 348
    let addr = raw;
    if (region && !/(省|市|自治区|特别行政区)/.test(addr.slice(0, 10))) {
      const prefix = /(市|省|区|县|盟|州)$/.test(region) ? region : region + '市';
      addr = prefix + addr;
    }
    let json;
    try {
      json = await call('/geocoder/v1/', { address: addr }, key);
    } catch (e) {
      if (e.tmapStatus === 348 || /参数错误/.test(e.message)) {
        e.message = '没能解析「' + raw + '」';
        e.hint = '地址太模糊。补上城市和街道，或用「北京市朝阳区建国路87号」这种写法';
      }
      throw e;
    }
    const r = json.result || {};
    const comp = r.address_components || r.address_component || {};
    const parts = [comp.province, comp.city, comp.district, comp.street, comp.street_number]
      .filter((v) => v).filter((v, i, a) => a.indexOf(v) === i);
    const full = parts.join('');
    return [{
      id: 'addr_' + ((r.location && r.location.lat) || 0) + '_' + ((r.location && r.location.lng) || 0),
      name: r.title || full || raw,
      address: full || addr,
      lat: r.location && r.location.lat,
      lng: r.location && r.location.lng,
      district: comp.district || '',
      city: comp.city || '',
      province: comp.province || '',
      adcode: (r.ad_info && r.ad_info.adcode) || '',
      category: '',
      level: r.level,
      similarity: r.similarity != null ? r.similarity : null,
      kind: 'address',
    }];
  }

  async function reverse(params, key) {
    const json = await call('/geocoder/v1/', {
      location: params.lat + ',' + params.lng,
      get_poi: 1,
    }, key);
    const r = json.result || json;
    const comp = r.address_component || r.address_components || {};
    return {
      address: r.address || '',
      formatted: (r.formatted_addresses && r.formatted_addresses.recommend) || r.address || '',
      city: comp.city || '',
      province: comp.province || '',
      district: comp.district || '',
      adcode: (r.ad_info && r.ad_info.adcode) || '',
      pois: (r.pois || []).slice(0, 6).map((x) => ({
        name: x.title, lat: x.location && x.location.lat, lng: x.location && x.location.lng,
        address: x.address, category: x.category,
        district: (x.ad_info && x.ad_info.district) || '',
      })),
    };
  }

  async function leg(params, key) {
    const mode = params.mode || 'transit';
    const policy = params.policy || 'RECOMMEND';
    const N = norm();

    if (mode === 'walking' || mode === 'driving') {
      const json = await call('/direction/v1/' + mode, { from: params.from, to: params.to }, key);
      const payload = json.result || json;
      const route = (payload.routes || [])[0];
      if (!route) throw new Error('未找到路线');
      return N.normalizeSimpleRoute(route, mode);
    }

    const json = await call('/direction/v1/transit', { from: params.from, to: params.to, policy }, key);
    const routes = ((json.result || json).routes) || [];
    if (!routes.length) throw new Error('未找到公共交通路线');
    const data = N.normalizeTransitRoute(routes[0]);
    data.alternativesRoutes = routes.slice(1, 4).map((r) => {
      const n = N.normalizeTransitRoute(r);
      return { minutes: n.minutes, meters: n.meters, fare: n.fare, summary: n.summary, transfers: n.transfers };
    });
    return data;
  }

  async function weather(params) {
    const days = Math.min(16, Math.max(1, Number(params.days || 3)));
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', params.lat);
    url.searchParams.set('longitude', params.lng);
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('timezone', 'Asia/Shanghai');
    if (params.start) {
      const d0 = new Date(params.start + 'T00:00:00');
      if (isNaN(d0.getTime())) throw new Error('start 日期格式应为 YYYY-MM-DD');
      d0.setDate(d0.getDate() + days - 1);
      const pad = (n) => String(n).padStart(2, '0');
      url.searchParams.set('start_date', params.start);
      url.searchParams.set('end_date', d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate()));
    } else {
      url.searchParams.set('forecast_days', String(days));
    }
    const res = await fetch(url.toString());
    const json = await res.json();
    if (!json.daily) throw new Error(json.reason ? '取不到预报：' + json.reason : '该日期超出预报范围');
    const N = norm();
    const list = (json.daily.time || []).map((date, i) => {
      const w = N.wmoText(Number(json.daily.weather_code[i]));
      return {
        date, code: json.daily.weather_code[i], text: w.text, icon: w.icon, indoor: w.indoor,
        tmax: json.daily.temperature_2m_max[i],
        tmin: json.daily.temperature_2m_min[i],
        rain: json.daily.precipitation_probability_max
          ? Number(json.daily.precipitation_probability_max[i]) : null,
      };
    });
    return { days: list };
  }

  /* Key 校验：跑一次真实公交规划，确认能出线路 */
  async function health(params, key) {
    if (!key) return { ok: true, key: false, message: '未配置 Key，运行在估算模式' };
    const json = await call('/direction/v1/transit', {
      from: '39.908722,116.397499', to: '39.882244,116.406519', policy: 'RECOMMEND',
    }, key);
    const routes = ((json.result || json).routes) || [];
    if (!routes.length) return { ok: false, key: true, message: '接口通但没返回路线' };
    const n = norm().normalizeTransitRoute(routes[0]);
    return {
      ok: n.steps.some((s) => s.type === 'ride'),
      key: true,
      message: 'Key 可用',
      sample: {
        minutes: n.minutes, fare: n.fare, summary: n.summary,
        steps: n.steps.map((s) => (s.type === 'ride'
          ? `${s.line}（往${s.direction}）${s.from}→${s.to} ${s.stops}站 ${s.minutes}分`
          : `步行${s.meters}米`)),
      },
    };
  }

  const ROUTES = {
    '/api/config': async (p, key) => ({ hasKey: !!key }),
    '/api/suggest': (p, key) => suggest(p, key),
    '/api/search': (p, key) => search(p, key),
    '/api/nearby': (p, key) => nearby(p, key),
    '/api/geocode': (p, key) => geocode(p, key),
    '/api/resolve-address': (p, key) => geocode(p, key),
    '/api/reverse': (p, key) => reverse(p, key),
    '/api/leg': (p, key) => leg(p, key),
    '/api/weather': (p, key) => weather(p),
  };

  global.DirectApi = {
    /* 与本地服务保持同样的返回形状：{ ok:true, data } */
    async get(path, params, key) {
      // health 的返回形状和别的接口不同，直接透出
      if (path === '/api/health') return health(params || {}, key);
      const fn = ROUTES[path];
      if (!fn) throw new Error('单文件版不支持该接口：' + path);
      const data = await fn(params || {}, key);
      return { ok: true, data };
    },
  };
})(window);
