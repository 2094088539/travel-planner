/* 通用工具函数 */
(function (global) {
  'use strict';

  const U = {};

  U.uid = function (prefix) {
    return (prefix || 'p') + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  };

  U.clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* 经纬度距离（米）。GCJ-02 上用 haversine 足够，短距离误差可忽略 */
  U.haversine = function (a, b) {
    if (!a || !b) return 0;
    const R = 6371008.8;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const la1 = a.lat * rad, la2 = b.lat * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  /* 分钟 <-> HH:MM */
  U.toHM = function (min) {
    const m = Math.round(Math.max(0, min));
    const h = Math.floor(m / 60) % 24;
    const mm = m % 60;
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  };
  U.fromHM = function (s, dflt) {
    if (typeof s !== 'string' || !s.includes(':')) return dflt == null ? 0 : dflt;
    const [h, m] = s.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return dflt == null ? 0 : dflt;
    return h * 60 + m;
  };

  U.dur = function (min) {
    const m = Math.round(min);
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
  };
  U.durShort = function (min) {
    const m = Math.round(min);
    if (m < 60) return m + '分';
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h${r}m` : `${h}h`;
  };
  U.dist = function (meters) {
    if (meters == null) return '';
    return meters < 1000 ? Math.round(meters) + ' 米' : (meters / 1000).toFixed(1) + ' 公里';
  };

  U.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  U.debounce = function (fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  U.throttle = function (fn, ms) {
    let last = 0, timer = null;
    return function (...args) {
      const now = Date.now();
      const rest = ms - (now - last);
      if (rest <= 0) { last = now; fn.apply(this, args); }
      else if (!timer) {
        timer = setTimeout(() => { timer = null; last = Date.now(); fn.apply(this, args); }, rest);
      }
    };
  };

  /* 并发受限的 map */
  U.pMap = async function (items, limit, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    });
    await Promise.all(runners);
    return out;
  };

  /* 'YYYY-MM-DD' + n 天 */
  U.addDays = function (dateStr, n) {
    const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
    if (isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + n);
    return d;
  };
  U.fmtDate = function (d) {
    if (!d) return '';
    const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 ${w}`;
  };

  U.store = {
    get(k, dflt) {
      try {
        const v = localStorage.getItem('tp:' + k);
        return v == null ? dflt : JSON.parse(v);
      } catch { return dflt; }
    },
    set(k, v) {
      try { localStorage.setItem('tp:' + k, JSON.stringify(v)); } catch { /* 忽略 */ }
    },
    del(k) { try { localStorage.removeItem('tp:' + k); } catch { /* 忽略 */ } },
  };

  /* 地点分类：停留时长默认值与图标 */
  const CATEGORY_PRESET = [
    { name: '景点', minutes: 120, icon: '🏞' },
    { name: '博物馆', minutes: 120, icon: '🏛' },
    { name: '餐饮', minutes: 75, icon: '🍜' },
    { name: '购物', minutes: 90, icon: '🛍' },
    { name: '住宿', minutes: 20, icon: '🏨' },
    { name: '交通枢纽', minutes: 20, icon: '🚉' },
    { name: '其他', minutes: 60, icon: '📍' },
  ];

  function preset(name) {
    const hit = CATEGORY_PRESET.find((c) => c.name === name);
    return hit ? { name: hit.name, minutes: hit.minutes, icon: hit.icon } : { name: '其他', minutes: 60, icon: '📍' };
  }

  /* 一级：腾讯返回的 category 层级串，如「美食:中餐厅:北京菜」 */
  const CATEGORY_RULES = [
    { re: /酒店|宾馆|住宿|民宿|旅馆|客栈|青旅|招待所|度假村|短租/, name: '住宿' },
    { re: /美食|餐饮|咖啡|茶艺|冷饮|甜品|糕点|小吃|酒吧|餐吧|夜宵/, name: '餐饮' },
    { re: /博物馆|博物院|美术馆|展览馆|科技馆|纪念馆|艺术馆|图书馆|档案馆|画廊/, name: '博物馆' },
    { re: /交通|机场|火车站|地铁|公交|码头|港口|长途汽车|收费站|加油站/, name: '交通枢纽' },
    { re: /购物|商场|百货|超市|便利店|市场|商业街|免税|奥特莱斯|专卖店/, name: '购物' },
    { re: /景点|风景|公园|园林|动物园|植物园|水族馆|游乐|温泉|寺庙|道观|教堂|古迹|遗址|长城|古镇|湿地|剧院|电影院|体育馆/, name: '景点' },
  ];

  /* 二级：靠名称识别。很多酒店/餐厅的名称里根本没有「酒店」「餐厅」二字 */
  const NAME_RULES = [
    {
      name: '住宿',
      re: /(酒店|宾馆|旅馆|民宿|客栈|公寓|青旅|招待所|度假村|如家|汉庭|全季|桔子|亚朵|锦江|速8|速八|格林豪泰|维也纳|宜必思|希尔顿|万豪|洲际|喜来登|香格里拉|凯悦|威斯汀|索菲特|丽思|华住|七天|7天|布丁|城市便捷|尚客优|丽枫|美居|雅乐轩|康莱德|艾美|温德姆|君悦|柏悦|安缦|开元|锦江之星|汉庭优佳)/,
    },
    {
      name: '餐饮',
      re: /(餐厅|饭庄|菜馆|酒家|食府|饭店|火锅|烧烤|烤肉|烤鸭|小吃|面馆|拉面|饺子|包子|米粉|粥铺|茶餐厅|咖啡馆|咖啡|茶馆|茶楼|奶茶|甜品|烘焙|面包|酒吧|餐吧|食堂|自助餐|寿司|披萨|汉堡|麦当劳|肯德基|星巴克|瑞幸|海底捞|西贝|全聚德|便宜坊|庆丰|呷哺|必胜客|汉堡王|外婆家|喜茶|奈雪|蜜雪|老乡鸡|真功夫|吉野家|沙县|兰州拉面|眉州东坡|局气|四季民福|南门涮肉|东来顺|紫光园)/,
    },
    { name: '博物馆', re: /(博物|美术馆|展览馆|科技馆|纪念馆|艺术馆|图书馆|画廊|会展)/ },
    { name: '交通枢纽', re: /(机场|航站楼|火车站|高铁站|汽车站|客运站|码头|港口|地铁站|公交站|轻轨站)/ },
    { name: '购物', re: /(商场|百货|购物中心|超市|便利店|免税店|奥特莱斯|太古里|万象城|大悦城|万达|天街|SKP|步行街|集市|批发市场|花市)/ },
    { name: '景点', re: /(公园|园林|植物园|动物园|海洋馆|水族馆|景区|古镇|古街|湿地|温泉|乐园|寺院|寺庙|道观|教堂|宫|殿|塔|长城|遗址|故居|纪念堂|观景|沙滩|海滩|瀑布|胡同|广场|山|湖|岛|洞|大学|学院|校区|学村|文创|艺术区|老街)/ },
  ];

  U.guessCategory = function (name, addr, rawCategory) {
    const cat = String(rawCategory || '');
    if (cat) {
      for (const r of CATEGORY_RULES) if (r.re.test(cat)) return preset(r.name);
    }
    const text = `${name || ''} ${addr || ''}`;
    for (const r of NAME_RULES) if (r.re.test(text)) return preset(r.name);
    return preset('其他');
  };

  /* 从「美食:中餐厅:北京菜」里取出最末一级用于展示 */
  U.subCategory = function (raw) {
    const parts = String(raw || '').split(/[:：]/).map((x) => x.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 1] : '';
  };

  /* 从地址里粗略提取区县名，用于旧数据兼容 */
  U.extractDistrict = function (addr) {
    let a = String(addr || '').trim();
    if (!a) return '';
    const i = a.indexOf('市');
    if (i >= 0 && i < 8) a = a.slice(i + 1);
    const m = a.match(/^([\u4e00-\u9fa5]{2,4}?(?:区|县))/);
    return m ? m[1] : '';
  };

  U.CATEGORIES = CATEGORY_PRESET.map((c) => c.name);
  U.catMinutes = function (cat) { return preset(cat).minutes; };
  U.catIcon = function (cat) { return preset(cat).icon; };

  U.DAY_COLORS = ['#2563eb', '#e8590c', '#0ca678', '#9333ea', '#db2777', '#ca8a04', '#0891b2', '#4b5563'];

  /* 简单哈希，用于稳定配色 */
  U.hashStr = function (s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  };

  U.vehicleLabel = function (v) {
    return ({ subway: '地铁', bus: '公交', brt: '快速公交', rail: '城际', ferry: '轮渡', maglev: '磁浮', walk: '步行', taxi: '打车' })[v] || '公交';
  };

  global.U = U;
})(window);
