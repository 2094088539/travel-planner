/* 验证单文件版的直连层：模拟浏览器 document，让 JSONP 真实打到腾讯接口 */
globalThis.window = globalThis;
const https = require('https');
const KEY = process.env.TMAP_KEY || '';
if (!KEY) { console.error('请先设置 TMAP_KEY 环境变量'); process.exit(1); }

globalThis.TmapNorm = require('./public/js/tmap-norm.js');

/* --- 用 https 模拟 <script src> 的加载与执行 --- */
globalThis.document = {
  createElement() { return {}; },
  head: {
    appendChild(script) {
      const url = script.src;
      const cb = decodeURIComponent((url.match(/callback=([^&]+)/) || [])[1] || '');
      https.get(url, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            // 响应形如 cb&&cb({...})，在全局作用域里执行
            const fn = new Function('with(this){' + body + '}');
            fn.call(globalThis);
          } catch (e) {
            if (script.onerror) script.onerror(e);
          }
        });
      }).on('error', (e) => { if (script.onerror) script.onerror(e); });
    },
  },
};

require('./public/js/tmap-direct.js');

const t0 = Date.now();
const step = async (label, fn) => {
  const s = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${label}  ${Date.now() - s}ms`);
    return r;
  } catch (e) {
    console.log(`✗ ${label}  ${e.message}${e.hint ? ' | ' + e.hint : ''}`);
    return null;
  }
};

(async () => {
  console.log('=== 单文件直连层实测（JSONP） ===');

  const sug = await step('/api/suggest', () =>
    DirectApi.get('/api/suggest', { keyword: '全聚德', region: '北京' }, KEY));
  if (sug) sug.data.slice(0, 3).forEach((d) => console.log('   ', d.name, '|', d.district, '|', d.category));

  const geo = await step('/api/geocode', () =>
    DirectApi.get('/api/geocode', { address: '建国路87号', region: '北京' }, KEY));
  if (geo) console.log('   ', geo.data[0].name, '|', geo.data[0].district, '|', geo.data[0].lat + ',' + geo.data[0].lng);

  const rev = await step('/api/reverse', () =>
    DirectApi.get('/api/reverse', { lat: 39.916345, lng: 116.397155 }, KEY));
  if (rev) console.log('   ', rev.data.district, '| pois', rev.data.pois.length);

  const near = await step('/api/nearby', () =>
    DirectApi.get('/api/nearby', { lat: 39.916345, lng: 116.397155, radius: 1200, keyword: '餐厅' }, KEY));
  if (near) console.log('   ', near.data.length, '条 |', near.data[0].name, near.data[0].distance + 'm');

  const leg = await step('/api/leg（公交）', () =>
    DirectApi.get('/api/leg', {
      from: '39.908722,116.397499', to: '39.882244,116.406519', mode: 'transit', policy: 'RECOMMEND',
    }, KEY));
  if (leg) {
    const d = leg.data;
    console.log('   ', d.minutes + '分', d.meters + '米', '¥' + d.fare, d.transfers + '次换乘', '|', d.summary);
    d.steps.forEach((s) => {
      if (s.type === 'ride') console.log('      🚇', s.line, s.from + '→' + s.to, s.stops + '站', s.minutes + '分');
      else console.log('      🚶', s.meters + '米');
    });
    console.log('    polyline 点数:', d.polyline ? d.polyline.length : 0);
  }

  const walk = await step('/api/leg（步行）', () =>
    DirectApi.get('/api/leg', { from: '39.9087,116.3975', to: '39.9055,116.3976', mode: 'walking' }, KEY));
  if (walk) console.log('   ', walk.data.minutes + '分', walk.data.meters + '米');

  const wx = await step('/api/weather', () =>
    DirectApi.get('/api/weather', { lat: 24.48, lng: 118.09, start: '2026-11-14', days: 3 }, KEY));
  if (wx) (wx.data.days || []).forEach((d) => console.log('   ', d.date, d.icon, d.text, Math.round(d.tmax) + '°'));

  const cfg = await step('/api/config', () => DirectApi.get('/api/config', {}, KEY));
  if (cfg) console.log('   hasKey =', cfg.data.hasKey);

  console.log('\n总耗时', Date.now() - t0, 'ms');
})();
