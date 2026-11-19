/**
 * 行程规划工具 —— 本地服务
 *
 * 职责：
 *   1. 静态资源服务
 *   2. 代理腾讯位置服务 WebService（搜索 / 逆地理 / 公交 / 步行 / 驾车）
 *   3. 把原始返回统一成前端可直接消费的 Leg 结构
 *   4. 内存缓存，避免同一段路重复消耗配额
 *
 * 启动： node server.js  [--port 8787] [--key YOUR_KEY] [--no-open]
 * Key 也可以环境变量 TMAP_KEY，或者由前端在页面里填写（随请求头 X-Tmap-Key 传入）。
 *
 * 关于腾讯接口的字段事实（已实测 2026-11）：
 *   - direction 系列里 duration 的单位是【分钟】，不是秒
 *   - 公交方案价格 price 单位是【分】，-1 表示未知
 *   - 线路名在 lines[].title，上/下车站是 geton / getoff，站口在 geton.exit.title
 *   - 乘车方向在 lines[].destination.title
 *   - polyline 是【数字数组】：[lat, lng, dLat, dLng, ...]，后项为 /1e6 的增量
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(getArg('port', process.env.PORT || 8787));
/* Key 来源优先级：--key 参数 > 环境变量 TMAP_KEY > 同目录 key.txt */
function readKeyFile() {
  try {
    return fs.readFileSync(path.join(__dirname, 'key.txt'), 'utf8')
      .split(/\r?\n/)[0].trim();
  } catch (e) {
    return '';
  }
}
const ENV_KEY = getArg('key', process.env.TMAP_KEY || readKeyFile());
const NO_OPEN = argv.includes('--no-open');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TMAP = 'https://apis.map.qq.com/ws';
const REQUEST_TIMEOUT = 15000;

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */
const CACHE = new Map();
const CACHE_TTL = 6 * 3600 * 1000;
const CACHE_MAX = 3000;

function cacheGet(k) {
  const hit = CACHE.get(k);
  if (!hit) return null;
  if (hit.exp < Date.now()) { CACHE.delete(k); return null; }
  return hit.v;
}
function cacheSet(k, v) {
  if (CACHE.size > CACHE_MAX) {
    let n = 0;
    for (const key of CACHE.keys()) { CACHE.delete(key); if (++n > 500) break; }
  }
  CACHE.set(k, { v, exp: Date.now() + CACHE_TTL });
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('上游返回非 JSON：' + text.slice(0, 200));
    }
  } finally {
    clearTimeout(timer);
  }
}

const TmapNorm = require('./public/js/tmap-norm.js');
const {
  num, toMinutes, decodePolyline, decodeBase64Polyline, wmoText,
  vehicleFromRaw, buildSummary, normalizeTransitRoute, normalizeSimpleRoute,
} = TmapNorm;

/* ------------------------------------------------------------------ */
/* 请求节流：腾讯个人 Key 的 QPS 很低，并发会直接报「每秒请求量已达上限」    */
/* ------------------------------------------------------------------ */
const RATE = {
  minInterval: Number(process.env.TMAP_INTERVAL || 260),
  maxConcurrent: 1,
  retries: 4,
};
let queue = [];
let activeCount = 0;
let lastCallAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scheduleUpstream(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

function pump() {
  if (!queue.length || activeCount >= RATE.maxConcurrent) return;
  const wait = lastCallAt + RATE.minInterval - Date.now();
  if (wait > 0) { setTimeout(pump, wait); return; }

  const job = queue.shift();
  activeCount++;
  lastCallAt = Date.now();
  Promise.resolve()
    .then(job.fn)
    .then(job.resolve, job.reject)
    .finally(() => { activeCount--; pump(); });
}

/* ------------------------------------------------------------------ */
/* 腾讯 API 封装                                                       */
/* ------------------------------------------------------------------ */
function needKey(key) {
  if (!key) {
    const e = new Error('未配置腾讯位置服务 Key');
    e.status = 401;
    e.hint = '点页面右上角「数据源」填入 Key，或启动时加 --key / 设置环境变量 TMAP_KEY。申请地址：https://lbs.qq.com/dev/console/application/mine';
    throw e;
  }
}

function isRateLimited(json) {
  const msg = String(json && json.message || '');
  return num(json && json.status, -1) === 120 || /每秒|频率|限流|上限/.test(msg);
}

/* 注意：place/v1/suggestion 把 data 放在顶层，没有 result 包裹。
   这里统一返回 result（若有），否则返回整个响应，调用方按需取字段。 */
function checkTencent(json) {
  const st = num(json.status, -1);
  if (st !== 0) {
    const e = new Error(json.message || `腾讯接口返回 status=${st}`);
    e.status = 502;
    e.tmapStatus = st;
    if ([311, 375, 199, 110, 111, 112].includes(st)) {
      e.status = 401;
      e.hint = 'Key 无效、未开通对应服务或来源未授权，请到 https://lbs.qq.com/dev/console 检查';
    }
    throw e;
  }
  return json.result || json;
}

async function tmapGet(pathname, params, key, attempt) {
  needKey(key);
  const tries = attempt || 0;
  const url = new URL(TMAP + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('key', key);
  url.searchParams.set('output', 'json');

  const json = await scheduleUpstream(() => fetchJson(url.toString()));

  if (isRateLimited(json) && tries < RATE.retries) {
    await sleep(400 * Math.pow(2, tries) + Math.random() * 200);
    return tmapGet(pathname, params, key, tries + 1);
  }
  if (isRateLimited(json)) {
    const e = new Error('接口调用频率超限，请稍后重试（或调大 TMAP_INTERVAL）');
    e.status = 429;
    throw e;
  }
  return checkTencent(json);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      d += c;
      if (d.length > (limit || 4e6)) { req.destroy(); reject(new Error('内容过大')); }
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function safeFileName(name) {
  return String(name || '导出')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80) || '导出';
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const key = (req.headers['x-tmap-key'] || url.searchParams.get('key') || ENV_KEY || '').trim();
  const q = url.searchParams;
  const p = url.pathname;

  try {
    /* --- 输入提示 --- */
    if (p === '/api/suggest') {
      const cacheKey = `sg|${q.get('keyword')}|${q.get('region')}|${key.slice(-6)}`;
      const hit = cacheGet(cacheKey);
      if (hit) return sendJson(res, 200, { ok: true, data: hit, cached: true });

      const result = await tmapGet('/place/v1/suggestion', {
        keyword: q.get('keyword') || '',
        region: q.get('region') || '',
        region_fix: 0,
        page_size: 10,
      }, key);

      // 注意：suggestion 的 address 已经是完整地址，别再拼 province/city 会重复
      const data = (result.data || []).map((d) => ({
        id: d.id,
        name: d.title,
        address: d.address || '',
        lat: d.location?.lat,
        lng: d.location?.lng,
        category: d.category || '',
        type: d.type,
        district: d.district || '',
        city: d.city || '',
        province: d.province || '',
        adcode: d.adcode || '',
        kind: 'poi',
      })).filter((d) => d.lat && d.lng);
      cacheSet(cacheKey, data);
      return sendJson(res, 200, { ok: true, data });
    }

    /* --- 地点搜索 --- */
    if (p === '/api/search') {
      const region = q.get('region') || '';
      const boundary = region ? `region(${region},0)` : 'region(全国,0)';
      const result = await tmapGet('/place/v1/search', {
        keyword: q.get('keyword') || '',
        boundary,
        page_size: 10,
        page_index: 1,
        orderby: '_distance',
      }, key);
      const data = (result.data || []).map((d) => ({
        id: d.id,
        name: d.title,
        address: d.address || '',
        lat: d.location?.lat,
        lng: d.location?.lng,
        category: d.category || '',
        type: d.type,
        district: d.ad_info?.district || '',
        city: d.ad_info?.city || '',
        province: d.ad_info?.province || '',
        adcode: d.ad_info?.adcode || '',
        tel: d.tel || '',
        kind: 'poi',
      })).filter((d) => d.lat && d.lng);
      return sendJson(res, 200, { ok: true, data });
    }

    /* --- 逆地理 --- */
    if (p === '/api/reverse') {
      const location = `${q.get('lat')},${q.get('lng')}`;
      const cacheKey = `rv|${location}|${key.slice(-6)}`;
      const hit = cacheGet(cacheKey);
      if (hit) return sendJson(res, 200, { ok: true, data: hit, cached: true });
      const result = await tmapGet('/geocoder/v1/', { location, get_poi: 1 }, key);
      const comp = result.address_component || result.address_components || {};
      const data = {
        address: result.address || '',
        formatted: result.formatted_addresses?.recommend || result.address || '',
        city: comp.city || '',
        province: comp.province || '',
        district: comp.district || '',
        adcode: result.ad_info?.adcode || '',
        pois: (result.pois || []).slice(0, 6).map((x) => ({
          name: x.title, lat: x.location?.lat, lng: x.location?.lng,
          address: x.address, category: x.category,
          district: x.ad_info?.district || '',
        })),
      };
      cacheSet(cacheKey, data);
      return sendJson(res, 200, { ok: true, data });
    }

    /* --- 地址解析：把一段文字地址变成可添加的地点 --- */
    if (p === '/api/geocode' || p === '/api/resolve-address') {
      const address = (q.get('address') || '').trim();
      const region = (q.get('region') || '').trim();
      if (!address) return sendJson(res, 400, { ok: false, error: { message: '缺少 address' } });

      // 腾讯地址解析必须带城市，否则直接 348 参数错误。缺了就补上
      let addr = address;
      if (region && !/(省|市|自治区|特别行政区)/.test(addr.slice(0, 10))) {
        const prefix = /(市|省|区|县|盟|州)$/.test(region) ? region : region + '市';
        addr = prefix + addr;
      }

      const cacheKey = `gc|${addr}|${key.slice(-6)}`;
      const hit = cacheGet(cacheKey);
      if (hit) return sendJson(res, 200, { ok: true, data: hit, cached: true });

      let result;
      try {
        result = await tmapGet('/geocoder/v1/', { address: addr }, key);
      } catch (e) {
        if (e.tmapStatus === 348 || /参数错误/.test(e.message)) {
          e.message = `没能解析「${address}」`;
          e.hint = '地址太模糊。补上城市和街道，或用「北京市朝阳区建国路87号」这种写法';
          e.status = 404;
        }
        throw e;
      }
      const comp = result.address_components || result.address_component || {};
      // 去掉「北京市北京市」这种重复段
      const parts = [comp.province, comp.city, comp.district, comp.street, comp.street_number]
        .filter((v) => v)
        .filter((v, i, arr) => arr.indexOf(v) === i);
      const full = parts.join('');
      const data = {
        id: 'addr_' + (result.location?.lat || 0) + '_' + (result.location?.lng || 0),
        name: result.title || full || address,
        address: full || addr,
        query: address,
        similarity: result.similarity != null ? result.similarity : null,
        lat: result.location?.lat,
        lng: result.location?.lng,
        district: comp.district || '',
        city: comp.city || '',
        province: comp.province || '',
        adcode: result.ad_info?.adcode || '',
        category: '',
        level: result.level,
        kind: 'address',
      };
      cacheSet(cacheKey, data);
      return sendJson(res, 200, { ok: true, data });
    }

    /* --- 天气（Open-Meteo，免费无 Key） --- */
    if (p === '/api/weather') {
      const lat = q.get('lat') || '39.9087';
      const lng = q.get('lng') || '116.3975';
      const start = q.get('start') || '';
      const days = Math.min(16, Math.max(1, Number(q.get('days') || 3)));

      const cacheKey = `wx|${lat}|${lng}|${start}|${days}`;
      const hit = cacheGet(cacheKey);
      if (hit) return sendJson(res, 200, { ok: true, data: hit, cached: true });

      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', lat);
      url.searchParams.set('longitude', lng);
      url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
      url.searchParams.set('timezone', 'Asia/Shanghai');
      // forecast_days 与 start_date/end_date 互斥，只能二选一
      if (start) {
        const d0 = new Date(start + 'T00:00:00');
        if (isNaN(d0.getTime())) return sendJson(res, 400, { ok: false, error: { message: 'start 日期格式应为 YYYY-MM-DD' } });
        d0.setDate(d0.getDate() + days - 1);
        const pad = (n) => String(n).padStart(2, '0');
        // 用本地日期拼接，不能用 toISOString（东八区会算早一天）
        const end = `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`;
        url.searchParams.set('start_date', start);
        url.searchParams.set('end_date', end);
      } else {
        url.searchParams.set('forecast_days', String(days));
      }

      let json;
      try {
        json = await fetchJson(url.toString());
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: { message: '天气服务不可用：' + e.message } });
      }
      if (!json.daily) {
        return sendJson(res, 200, {
          ok: false,
          error: {
            message: json.reason
              ? '该日期取不到预报：' + json.reason
              : '该日期超出天气预报范围（约 16 天内）',
          },
        });
      }

      const d = json.daily;
      const list = (d.time || []).map((date, i) => {
        const code = num(d.weather_code?.[i], -1);
        const w = wmoText(code);
        return {
          date,
          code,
          text: w.text,
          icon: w.icon,
          indoor: w.indoor,
          tmax: d.temperature_2m_max?.[i],
          tmin: d.temperature_2m_min?.[i],
          rain: d.precipitation_probability_max?.[i] != null ? num(d.precipitation_probability_max[i]) : null,
        };
      });
      const data = { days: list, fetchedAt: Date.now() };
      cacheSet(cacheKey, data);
      return sendJson(res, 200, { ok: true, data });
    }

    /* --- 周边搜索（附近推荐 / 顺路） --- */
    if (p === '/api/nearby') {
      const lat = q.get('lat');
      const lng = q.get('lng');
      const radius = Math.min(10000, Math.max(200, Number(q.get('radius') || 1500)));
      const keyword = q.get('keyword') || '';
      if (!lat || !lng) return sendJson(res, 400, { ok: false, error: { message: '缺少 lat/lng' } });

      const cacheKey = `nb|${lat}|${lng}|${radius}|${keyword}|${key.slice(-6)}`;
      const hit = cacheGet(cacheKey);
      if (hit) return sendJson(res, 200, { ok: true, data: hit, cached: true });

      const result = await tmapGet('/place/v1/search', {
        keyword,
        boundary: `nearby(${lat},${lng},${radius},1)`,
        page_size: 12,
        orderby: '_distance',
      }, key);

      const data = (result.data || []).map((d) => ({
        id: d.id,
        name: d.title,
        address: d.address || '',
        lat: d.location?.lat,
        lng: d.location?.lng,
        category: d.category || '',
        district: d.ad_info?.district || '',
        city: d.ad_info?.city || '',
        adcode: d.ad_info?.adcode || '',
        tel: d.tel || '',
        distance: d._distance != null ? Math.round(num(d._distance)) : null,
        kind: 'poi',
      })).filter((d) => d.lat && d.lng);
      cacheSet(cacheKey, data);
      return sendJson(res, 200, { ok: true, data });
    }

    /* --- 单段路线 --- */
    if (p === '/api/leg') {
      const from = q.get('from');
      const to = q.get('to');
      const mode = q.get('mode') || 'transit';
      const policy = q.get('policy') || 'RECOMMEND';

      if (!from || !to) return sendJson(res, 400, { ok: false, error: { message: '缺少 from/to' } });

      const cacheKey = `lg|${from}|${to}|${mode}|${policy}|${key.slice(-6)}`;
      const hit = cacheGet(cacheKey);
      if (hit) return sendJson(res, 200, { ok: true, data: hit, cached: true });

      let data;
      if (mode === 'walking' || mode === 'driving') {
        const result = await tmapGet(`/direction/v1/${mode}`, { from, to }, key);
        const route = (result.routes || [])[0];
        if (!route) throw Object.assign(new Error('未找到路线'), { status: 404 });
        data = normalizeSimpleRoute(route, mode);
      } else {
        const result = await tmapGet('/direction/v1/transit', { from, to, policy }, key);
        const routes = result.routes || [];
        if (!routes.length) throw Object.assign(new Error('未找到公共交通路线'), { status: 404 });

        data = normalizeTransitRoute(routes[0]);
        data.alternativesRoutes = routes.slice(1, 4).map((r) => {
          const n = normalizeTransitRoute(r);
          return {
            minutes: n.minutes, meters: n.meters, fare: n.fare,
            summary: n.summary, transfers: n.transfers,
          };
        });
      }
      cacheSet(cacheKey, data);
      return sendJson(res, 200, { ok: true, data });
    }

    /* --- 导出 .xmind（base64 传二进制） --- */
    if (p === '/api/export/xmind') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { message: '请用 POST' } });
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: { message: '请求体不是合法 JSON' } });
      }
      const buf = Buffer.from(String(body.data || ''), 'base64');
      if (!buf.length) return sendJson(res, 400, { ok: false, error: { message: '内容为空' } });

      const dir = path.join(__dirname, 'exports');
      await fs.promises.mkdir(dir, { recursive: true });
      const file = path.join(dir, safeFileName(body.name) + '.xmind');
      await fs.promises.writeFile(file, buf);
      return sendJson(res, 200, { ok: true, data: { path: file, dir } });
    }

    /* --- 运行配置 --- */
    if (p === '/api/config') {
      return sendJson(res, 200, { ok: true, data: { hasKey: !!ENV_KEY, interval: RATE.minInterval } });
    }

    /* --- 健康检查 --- */
    if (p === '/api/health') {
      if (!key) return sendJson(res, 200, { ok: true, key: false, message: '未配置 Key，运行在估算模式' });
      const result = await tmapGet('/direction/v1/transit', {
        from: '39.908722,116.397499',
        to: '39.882244,116.406519',
        policy: 'RECOMMEND',
      }, key);
      const route = (result.routes || [])[0];
      if (!route) return sendJson(res, 200, { ok: false, key: true, message: '接口通但未返回路线' });
      const norm = normalizeTransitRoute(route);
      return sendJson(res, 200, {
        ok: norm.steps.some((s) => s.type === 'ride'),
        key: true,
        message: 'Key 可用',
        sample: {
          minutes: norm.minutes,
          fare: norm.fare,
          transfers: norm.transfers,
          summary: norm.summary,
          steps: norm.steps.map((s) => (s.type === 'ride'
            ? `${s.line}（往${s.direction}）${s.from}${s.fromExit ? '(' + s.fromExit + ')' : ''}→${s.to} ${s.stops}站 ${s.minutes}分`
            : `步行${s.meters}米 ${s.minutes}分`)),
          polylinePoints: norm.polyline ? norm.polyline.length : 0,
        },
      });
    }

    return sendJson(res, 404, { ok: false, error: { message: '未知接口 ' + p } });
  } catch (e) {
    const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    return sendJson(res, code, {
      ok: false,
      error: {
        message: e.message || '请求失败',
        hint: e.hint || '',
        tmapStatus: e.tmapStatus || null,
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\\/])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      sendJson(res, 500, { ok: false, error: { message: e.message } });
    });
    return;
  }
  serveStatic(req, res, url);
});

const PID_FILE = path.join(__dirname, '.server.pid');

function writePid() {
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch (e) { /* 忽略 */ }
}
function clearPid() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const v = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (v === String(process.pid)) fs.unlinkSync(PID_FILE);
    }
  } catch (e) { /* 忽略 */ }
}
process.on('exit', clearPid);
process.on('SIGINT', () => { clearPid(); process.exit(0); });
process.on('SIGTERM', () => { clearPid(); process.exit(0); });

server.listen(PORT, '127.0.0.1', () => {
  writePid();
  const u = `http://127.0.0.1:${PORT}/`;
  console.log('');
  console.log('  行程规划器已启动');
  console.log('  ' + u);
  console.log(`  数据源：${ENV_KEY ? '已内置 Key' : '未内置 Key（页面内填写，或走估算模式）'}`);
  console.log('  退出：Ctrl+C');
  console.log('');
  if (!NO_OPEN && process.platform === 'win32') {
    exec(`start "" "${u}"`, { shell: 'cmd.exe' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，换一个：node server.js --port 8788`);
    process.exit(1);
  }
  throw e;
});
