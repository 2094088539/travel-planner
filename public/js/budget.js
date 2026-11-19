/**
 * 预算与记账
 *
 * 能做到「真」的部分：
 *   - 交通费：直接用规划结果里每段的真实票价（腾讯返回的 price），估算段按 3 元兜底
 *   - 门票：地点自己填的单价 × 人数
 *   - 住宿 / 餐饮 / 其他：按人均单价 × 天数推算，可在设置里改
 * 评分、营业时间、人均消费这类数据腾讯接口不提供，不做猜测。
 */
(function (global) {
  'use strict';

  const CATS = [
    { key: 'transport', name: '交通', color: '#2563eb' },
    { key: 'lodging', name: '住宿', color: '#7c3aed' },
    { key: 'food', name: '餐饮', color: '#e8590c' },
    { key: 'ticket', name: '门票', color: '#0ca678' },
    { key: 'other', name: '其他', color: '#64748b' },
  ];

  const CAT_MAP = {};
  CATS.forEach((c) => { CAT_MAP[c.key] = c; });

  function estimate(plan, trip, places) {
    const adults = Math.max(1, Number(trip.adults) || 1);
    const children = Math.max(0, Number(trip.children) || 0);
    const pax = adults + children;
    // 儿童按 6 折折算成"等效成人"，用于门票/餐饮/交通
    const paxEq = adults + children * 0.6;
    const days = (plan && plan.days && plan.days.length) || Math.max(1, Number(trip.days) || 1);
    const nights = Math.max(1, days);

    // 交通：真实票价优先，走路不计费
    let transport = 0;
    let rideLegs = 0;
    (plan?.days || []).forEach((d) => {
      d.legs.forEach((l) => {
        const leg = l.leg;
        if (leg.mode === 'walking') return;
        rideLegs++;
        transport += leg.fare != null && leg.fare > 0 ? leg.fare : 3;
      });
    });
    transport = Math.round(transport * paxEq);
    // 往返大交通（出发城市 ↔ 到达城市）：腾讯没有票价源，按用户填的金额计
    const longHaul = Math.round((Number(trip.longHaul) || 0) * paxEq);

    // 门票：只算真正排进行程的地点
    const used = new Set();
    (plan?.days || []).forEach((d) => d.order.forEach((p) => used.add(p.id)));
    const ticketBase = (places || [])
      .filter((p) => (plan ? used.has(p.id) : true))
      .reduce((a, p) => a + (Number(p.ticket) || 0), 0);
    const ticket = Math.round(ticketBase * paxEq);

    const lodging = Math.round((Number(trip.lodgingPerNight) || 0) * nights);
    const meals = trip.mealsPerDay != null ? Number(trip.mealsPerDay) : 2;
    const food = Math.round((Number(trip.mealPerPerson) || 0) * meals * days * paxEq);
    const other = Math.round((Number(trip.miscPerDay) || 0) * days);

    const amounts = { transport: transport + longHaul, lodging, food, ticket, other };
    const items = CATS.map((c) => ({ ...c, amount: amounts[c.key] || 0 }));
    const total = items.reduce((a, x) => a + x.amount, 0);

    return {
      items, total, pax, paxEq, adults, children, days, nights, longHaul, localTransport: transport,
      transport: Math.round(transport / Math.max(1, paxEq)),
      perPerson: Math.round(total / Math.max(1, paxEq)), rideLegs,
    };
  }

  function sumEntries(entries) {
    const out = {};
    CATS.forEach((c) => { out[c.key] = 0; });
    (entries || []).forEach((e) => {
      if (out[e.cat] == null) out.other += Number(e.amount) || 0;
      else out[e.cat] += Number(e.amount) || 0;
    });
    const total = Object.values(out).reduce((a, b) => a + b, 0);
    return { byCat: out, total };
  }

  function parseQuick(text) {
    // 「午饭 80」这类快速记账，返回 {cat, amount, note}
    const t = String(text || '').trim();
    const numMatch = t.match(/(\d+(?:\.\d+)?)/);
    if (!numMatch) return null;
    const amount = Number(numMatch[1]);
    const lower = t.toLowerCase();
    let cat = 'other';
    if (/车|地铁|公交|打|taxi|交通|机票|高铁/.test(lower)) cat = 'transport';
    else if (/住|酒店|民宿|房/.test(lower)) cat = 'lodging';
    else if (/吃|饭|餐|咖啡|奶茶|food|早|午|晚/.test(lower)) cat = 'food';
    else if (/票|门票|景区|ticket/.test(lower)) cat = 'ticket';
    const note = t.replace(numMatch[0], '').replace(/元|块|¥|￥/g, '').trim() || CAT_MAP[cat].name;
    return { cat, amount, note };
  }

  global.Budget = { CATS, CAT_MAP, estimate, sumEntries, parseQuick };
})(window);
