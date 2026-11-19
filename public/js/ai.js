/**
 * AI（DeepSeek）：排行程 + 补资料
 *
 * 1) planDays —— 决定「哪天去哪几个点、当天先后顺序、每个点待多久」。
 *    具体到分钟的到达时刻仍由本地排程算，保证可行；模型负责的是「合理性」：
 *    闭馆日、上午人少、傍晚看夜景这类判断。
 * 2) fillInfo —— 补「营业时间」和「人均消费」。高德能给的优先用高德，
 *    高德没有的小馆子才让模型估个参考值。
 *
 * 接口支持 CORS（含 file://），单文件版可以直连，不需要服务端代理。
 * 注意：DeepSeek 的对话接口**不联网**，模型靠训练知识判断，不用假装它查了全网。
 */
(function (global) {
  'use strict';

  const ENDPOINT = 'https://api.deepseek.com/chat/completions';
  /* Key 不写死在代码里：优先读 config.local.js / 页面里填的，其次 localStorage */
  function configKey() {
    const c = global.APP_CONFIG || {};
    return String(c.deepseekKey || '').trim();
  }
  const MODEL = 'deepseek-chat';
  const TIMEOUT = 45000;

  function key() {
    try { return localStorage.getItem('aiKey') || configKey(); } catch (e) { return configKey(); }
  }

  function available() { return !!key(); }

  /* 从模型输出里抠 JSON，容忍 ```json 围栏和前后废话 */
  function parseJson(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    return JSON.parse(t);
  }

  /* 统一对话：超时、错误、JSON 解析都收在这里 */
  async function chat(userPrompt, maxTokens) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key() },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.3,
          max_tokens: maxTokens || 2000,
          stream: false,
          messages: [
            { role: 'system', content: '你是资深中文行程规划师，只输出 JSON，不输出解释。' },
            { role: 'user', content: userPrompt },
          ],
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error('AI 接口返回 ' + res.status);
    const json = await res.json();
    const text = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : '';
    return parseJson(text);
  }

  /**
   * 排行程：哪天 → 顺序 → 每点待多久
   * @returns {Promise<Map<string, {day:number, seq:number, stay:number, why:string}>>}
   */
  async function planDays(places, trip) {
    const days = Math.max(1, Number(trip.days) || 1);
    const brief = places.map((p) => {
      const o = {
        id: p.id,
        n: p.name,
        d: p.district || '',
        c: p.category,
        m: p.must === 2 ? '必去' : p.must === 0 ? '可选' : '想去',
        t: p.minutes,
      };
      if (p.category === '餐饮') {
        o.meal = p.meal === 'dinner' ? '晚餐' : p.meal === 'snack' ? '小吃' : '午餐';
      }
      if (p.hours) o.hours = String(p.hours).slice(0, 40);
      return o;
    });

    const startH = Math.floor((Number(trip.dayStart) || 510) / 60);
    const endH = Math.floor((Number(trip.dayEnd) || 1260) / 60);
    const budget = (Number(trip.dayEnd) || 1260) - (Number(trip.dayStart) || 510);

    const prompt = `请把下面 ${brief.length} 个地点排进 ${days} 天，并决定**每天的先后顺序**和**每个点建议待多久**。

判断依据（用你的常识，不要编造）：
- 有闭馆日的（博物馆、部分景点周一闭馆）不要排在那天
- 需要早去的（热门景点上午人少、要排队登顶的）尽量排在当天靠前
- 适合傍晚或夜间的（夜市、灯光秀、滨江夜景）排在当天靠后
- 面积大、走路多的（大型景区、山、岛）给足时间，别硬塞
- 同一天的地点尽量在同一个区（看 d 字段），别来回横穿城市
- 每天总时长不超过 ${budget} 分钟（${startH}:00 到 ${endH}:00，已扣掉午餐晚餐各 60 分钟）
- 每天最多 2 家餐厅（午餐一家 + 晚餐一家），小吃不算；正餐按 11:30–13:30 / 17:30–19:30 归位
- 「必去」优先，放不下时先丢「可选」；每天至少一个地点，不要空天

输出严格 JSON，不要解释：
{"days":[{"d":1,"items":[{"id":"p1","stay":180,"why":"上午人少，需三小时"},{"id":"p2","stay":60,"why":"傍晚上来看日落"}]}]}

字段说明：
- 外层数组长度必须正好 ${days}
- items 的顺序就是当天游览顺序
- stay = 建议停留分钟（整数）
- why = 一句话说明为什么排在这个时段，最多 18 个汉字，没有理由就给 ""

地点：${JSON.stringify(brief)}`;

    const data = await chat(prompt, 2200);
    const rows = Array.isArray(data) ? data : (data && data.days);
    if (!Array.isArray(rows)) throw new Error('AI 返回格式不对');

    const valid = new Set(places.map((p) => p.id));
    const out = new Map();

    rows.forEach((row, di) => {
      // 兼容两种格式：["id1","id2"] 或 [{id,stay,why}]
      const items = Array.isArray(row) ? row : (row && Array.isArray(row.items) ? row.items : []);
      const dayIndex = (row && Number.isFinite(Number(row.d))) ? Math.max(0, Number(row.d) - 1) : di;
      items.forEach((it, si) => {
        const id = typeof it === 'string' ? it : (it && it.id);
        if (!id || !valid.has(id) || out.has(id)) return;
        const stay = typeof it === 'object' && Number.isFinite(Number(it.stay))
          ? Math.round(Number(it.stay)) : 0;
        const why = typeof it === 'object' ? String(it.why || '').trim().slice(0, 24) : '';
        out.set(id, {
          day: Math.min(dayIndex, days - 1),
          seq: si,
          stay: stay > 0 && stay <= 600 ? stay : 0,
          why,
        });
      });
    });

    if (!out.size) throw new Error('AI 没有返回有效安排');
    return out;
  }

  /**
   * 补「营业时间」和「人均消费」
   * @param {Array<{id,name,address,city,district,category,needHours,needCost}>} items
   * @returns {Promise<Map<string, {hours?:string, cost?:number}>>}
   */
  async function fillInfo(items) {
    const list = (items || []).slice(0, 30);
    const out = new Map();
    for (let i = 0; i < list.length; i += 8) {
      const batch = list.slice(i, i + 8);
      const brief = batch.map((p) => ({
        id: p.id,
        n: p.name,
        a: p.address || '',
        c: p.city || p.district || '',
        k: p.category || '',
        need: [p.needHours ? '营业时间' : '', p.needCost ? '人均消费' : ''].filter(Boolean).join('、'),
      }));
      const prompt = `下面是旅行地点，请补齐「营业时间」和（餐饮类的）「人均消费」。

规则：
- 营业时间用中文，北京时间 24 小时制，例如「周一至周日 10:00-22:00」「全天开放」
- 人均消费只对餐饮给，单位人民币，给个整数参考值就行（比如 45、120），不需要精确
- 不确定、或本来就没有固定营业时间的（海滩、街道、观景台），对应字段填空字符串 ""
- 只输出 JSON，不要解释

格式：{"info":{"id1":{"hours":"周一至周日 10:00-22:00","cost":""},"id2":{"hours":"","cost":85}}}

地点：${JSON.stringify(brief)}`;

      try {
        const data = await chat(prompt, 1200);
        const map = (data && data.info) || {};
        Object.keys(map).forEach((id) => {
          const v = map[id] || {};
          const hours = String(v.hours || '').trim();
          const cost = Number(v.cost);
          if (!hours && !Number.isFinite(cost)) return;
          out.set(id, { hours: hours || '', cost: Number.isFinite(cost) ? Math.round(cost) : 0 });
        });
      } catch (e) {
        /* 单批失败不影响其它批 */
      }
    }
    return out;
  }

  /**
   * 生成游玩建议（攻略）
   * @param {Array<{id,name,category,address,hours,tips}>} places
   * @returns {Promise<Map<string, string>>}
   */
  async function fillTips(places) {
    const list = (places || []).filter((p) => p && !p.tips).slice(0, 28);
    const out = new Map();
    for (let i = 0; i < list.length; i += 7) {
      const batch = list.slice(i, i + 7);
      const brief = batch.map((p) => ({
        id: p.id, n: p.name, k: p.category || '', a: p.address || '', h: p.hours || '',
      }));
      const prompt = `下面是一批旅行地点，请给每个地点写一条**游玩建议**（攻略）。

要求：
- 一条 25–60 个汉字，说清楚「怎么玩 / 怎么省时间 / 避什么坑 / 什么时候去最好」
- 不要复述营业时间、地址这些已有信息
- 不要写「值得一去」「非常推荐」这种空话，要给具体动作
- 不确定的不要编，宁可写得笼统一点
- 只输出 JSON，不要解释

格式：{"tips":{"id1":"从北门进人少，先看主殿再往东走，登顶要另买票","id2":"..."}}

地点：${JSON.stringify(brief)}`;

      try {
        const data = await chat(prompt, 1400);
        const map = (data && data.tips) || {};
        Object.keys(map).forEach((id) => {
          const v = String(map[id] || '').trim();
          if (v) out.set(id, v.slice(0, 120));
        });
      } catch (e) {
        /* 单批失败不影响其它批 */
      }
    }
    return out;
  }

  /**
   * 生成热门路线方案（只做参考，不直接改用户的规划）
   * @param {object} trip  { city, days }
   * @param {string} ask   用户补充要求（可空）
   * @returns {Promise<Array<{name,days,desc,spots:[{n,d,stay}]}>>}
   */
  async function proposeRoutes(trip, ask) {
    const city = String((trip && trip.city) || '').replace(/市$/, '') || '目的地';
    const days = Math.max(1, Number(trip && trip.days) || 3);

    const prompt = `请给出 3 条「${city}」的热门经典旅游路线（${days} 天左右的行程），供游客参考。

要求：
- 只写真实存在、知名度高的地点，不要编造；不确定的宁可不写
- 每条路线 5–8 个点，按建议游览顺序排列，并标出安排在第几天
- 说明写 30–60 字：说清适合谁、这条线的亮点是什么，不要空话
${ask ? '- 用户补充要求：' + ask : ''}

输出严格 JSON，不要解释：
{"routes":[{"name":"厦门经典三日","days":3,"desc":"第一次来厦门适合这条，市区+鼓浪屿全覆盖","spots":[{"n":"鼓浪屿","d":1,"stay":240},{"n":"南普陀寺","d":2,"stay":90}]}]}`;

    const data = await chat(prompt, 2200);
    const rows = data && data.routes;
    if (!Array.isArray(rows)) throw new Error('返回格式不对');

    const out = [];
    rows.forEach((r) => {
      if (!r || !r.name) return;
      const spots = (Array.isArray(r.spots) ? r.spots : [])
        .map((x) => {
          const n = typeof x === 'string' ? x : (x && x.n);
          if (!n) return null;
          const d = typeof x === 'object' && Number.isFinite(Number(x.d)) ? Math.max(1, Number(x.d)) : 1;
          const stay = typeof x === 'object' && Number.isFinite(Number(x.stay)) ? Math.round(Number(x.stay)) : 0;
          return { n: String(n).trim().slice(0, 30), d, stay: stay > 0 && stay <= 600 ? stay : 0 };
        })
        .filter(Boolean)
        .slice(0, 12);
      if (!spots.length) return;
      out.push({
        name: String(r.name).trim().slice(0, 24),
        days: Math.max(1, Math.min(14, Number(r.days) || days)),
        desc: String(r.desc || '').trim().slice(0, 120),
        spots,
      });
    });
    return out;
  }

  global.Ai = { planDays, fillInfo, fillTips, proposeRoutes, available, key };
})(window);
