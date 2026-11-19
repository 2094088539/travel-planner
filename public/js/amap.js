/**
 * 高德 POI 资料补全（JS API）
 *
 * 腾讯位置服务不返回营业时间 / 评分 / 人均 / 电话 / 图片，高德的 PlaceSearch 有这些字段。
 * 注意：这里的 Key 是「Web端(JS API)」类型，不能用于 restapi.amap.com（会报 USERKEY_PLAT_NOMATCH），
 * 所以只能在浏览器里通过 JS API 调用，需要配套的安全密钥。
 *
 * 只做「补资料」：搜索和路线规划仍走腾讯，换掉那两块的收益远小于重写解析的风险。
 */
(function (global) {
  'use strict';

  function keys() {
    const c = global.APP_CONFIG || {};
    return {
      key: String(c.amapKey || '').trim(),
      security: String(c.amapSecurity || '').trim(),
    };
  }

  let loading = null;

  function load() {
    if (global.AMap && global.AMap.PlaceSearch) return Promise.resolve();
    if (loading) return loading;
    const k = keys();
    if (!k.key) return Promise.reject(new Error('没有配置高德 Key'));
    loading = new Promise((resolve, reject) => {
      global._AMapSecurityConfig = { securityJsCode: k.security };
      const s = document.createElement('script');
      s.src = `https://webapi.amap.com/maps?v=2.0&key=${k.key}&plugin=AMap.PlaceSearch`;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('高德 JS API 加载失败'));
      document.head.appendChild(s);
    });
    return loading;
  }

  /* 去掉括号里的门店后缀，「四季民福烤鸭店(故宫店)」→「四季民福烤鸭店」 */
  function stripParen(name) {
    return String(name || '').replace(/[（(][^）)]*[）)]/g, '').trim();
  }

  function distance(a, lat, lng) {
    if (!a || a.lat == null) return Infinity;
    try { return global.U.haversine(a, { lat, lng }); } catch (e) { return Infinity; }
  }

  function pick(list, place) {
    if (!list || !list.length) return null;
    // 先按距离筛，再按名字相似度挑——同名连锁店很多，位置才是硬指标
    let best = null, bestScore = -Infinity;
    const base = stripParen(place.name);
    list.forEach((p) => {
      const loc = String(p.location || '').split(',');
      const lat = Number(loc[1]), lng = Number(loc[0]);
      if (!Number.isFinite(lat)) return;
      const d = distance(place, lat, lng);
      if (d > 3000) return;
      let score = -d / 1000;
      const nm = stripParen(p.name);
      if (nm === base) score += 6;
      else if (nm.indexOf(base) >= 0 || base.indexOf(nm) >= 0) score += 3;
      if (score > bestScore) { bestScore = score; best = { p, lat, lng, d }; }
    });
    return best;
  }

  function search(keyword, city, pageSize) {
    return new Promise((resolve) => {
      const ps = new global.AMap.PlaceSearch({
        city: city || '',
        citylimit: false,
        extensions: 'all',
        pageSize: pageSize || 5,
      });
      ps.search(keyword, (status, result) => {
        if (status !== 'complete' || !result || !result.poiList) { resolve([]); return; }
        resolve(result.poiList.pois || []);
      });
    });
  }

  /* 一个地点要试的几种查法，从精确到宽松 */
  function candidates(place) {
    const out = [];
    const base = stripParen(place.name);
    out.push(place.name);
    if (base && base !== place.name) out.push(base);
    if (base.length > 6) out.push(base.slice(0, 6));
    return out.filter((v, i, a) => v && a.indexOf(v) === i);
  }

  /**
   * 补一个地点的资料
   * @returns {Promise<object|null>} { rating, cost, hours, tel, image, amapId }
   */
  async function enrichOne(place) {
    await load();
    const city = String(place.city || '').replace(/市$/, '');
    for (const kw of candidates(place)) {
      const list = await search(kw, city, 5);
      const hit = pick(list, place);
      if (!hit) continue;
      const p = hit.p;
      const photo = (p.photos || [])[0];
      return {
        amapId: p.id || '',
        rating: p.rating ? String(p.rating) : '',
        cost: p.cost ? Math.round(Number(p.cost)) : 0,
        hours: String(p.opentime2 || p.open_time || '').trim(),
        tel: String(p.tel || '').trim(),
        image: photo && photo.url ? String(photo.url).replace(/^http:/, 'https:') : '',
        amapAt: Date.now(),
      };
    }
    return null;
  }

  /**
   * 批量补：只补缺字段的，串行跑避免被限流
   * @param {Array} places
   * @param {(done:number,total:number)=>void} onProgress
   */
  async function enrichMany(places, onProgress) {
    const todo = (places || []).filter((p) => p && p.lat != null);
    const out = new Map();
    for (let i = 0; i < todo.length; i++) {
      try {
        const info = await enrichOne(todo[i]);
        if (info) out.set(todo[i].id, info);
      } catch (e) { /* 单个失败不影响其它 */ }
      if (onProgress) onProgress(i + 1, todo.length);
    }
    return out;
  }

  global.Amap = { load, enrichOne, enrichMany };
})(window);
