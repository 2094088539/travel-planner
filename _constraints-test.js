globalThis.window = globalThis;
require('./public/js/util.js');
require('./public/js/planner.js');

const P = (id, name, lat, lng, cat, min, extra) => Object.assign({
  id, name, lat, lng, category: cat, minutes: min, must: 1,
  district: '东城区', address: '北京市东城区' + name, city: '北京市', adcode: '110101',
  day: null, seq: null, winFrom: '', winTo: '', meal: '', skip: false, note: '', ticket: 0,
}, extra || {});

const SIGHTS = () => [
  P('a', '故宫博物院', 39.9163, 116.3972, '景点', 120, { must: 2 }),
  P('b', '景山公园', 39.9250, 116.3960, '景点', 60, { ticket: 2 }),
  P('c', '南锣鼓巷', 39.9370, 116.4030, '景点', 90),
  P('d', '雍和宫', 39.9470, 116.4170, '景点', 75, { ticket: 25 }),
];
const RESTAURANTS = () => [
  P('e', '全聚德', 39.8990, 116.3980, '餐饮', 75, { meal: 'lunch' }),
  P('f', '四季民福', 39.9130, 116.4030, '餐饮', 75, { meal: 'dinner' }),
];
const ALL = () => SIGHTS().concat(RESTAURANTS());
const ORIGIN = { id: 'h', name: '住处', lat: 39.9080, lng: 116.4000, district: '东城区' };

const BASE = () => ({
  city: '北京', days: 1, dayStart: 510, dayEnd: 1260, pace: 'normal', pref: 'RECOMMEND',
  lunchOn: true, lunchStart: 720, lunchDur: 60, dinnerOn: true, dinnerStart: 1080, dinnerDur: 60,
  returnHome: true, origin: ORIGIN, autoTrim: true, returnBuffer: 0,
  startDate: '2026-11-20', adults: 2, children: 0,
});

const HM = (m) => U.toHM(m);
const build = (trip, places) => {
  const leg = (a, b) => (a.id && a.id === b.id)
    ? { mode: 'walking', minutes: 0, meters: 0, walkMeters: 0, est: true }
    : Planner.estimateLeg(a, b, trip.pref);
  return Planner.buildPlan(places || ALL(), trip, leg);
};
const byId = (d, id) => d.items.find((i) => i.kind === 'visit' && i.place.id === id);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
};

/* 1 每天开始 / 结束 */
{
  const t = build(Object.assign(BASE(), { dayStart: 600 }));
  check('每天开始时间', t.days[0].start === 600, `设 10:00，实际 ${HM(t.days[0].start)}`);
}
{
  const a = build(BASE()).days[0], b = build(Object.assign(BASE(), { dayEnd: 900 })).days[0];
  check('每天结束时间', b.end <= 900 && b.end < a.end, `21:00→15:00 收工 ${HM(a.end)} → ${HM(b.end)}`);
}

/* 2 午餐：没有午餐店时才补通用餐块 */
{
  const t1 = Object.assign(BASE(), { lunchStart: 690 });
  const t2 = Object.assign(BASE(), { lunchStart: 780 });
  const m1 = build(t1, SIGHTS()).days[0].items.find((i) => i.kind === 'meal' && i.type !== 'dinner');
  const m2 = build(t2, SIGHTS()).days[0].items.find((i) => i.kind === 'meal' && i.type !== 'dinner');
  check('午餐时间', !!m1 && !!m2 && m2.start - m1.start === 90,
    `11:30→13:00 餐块 ${m1 ? HM(m1.start) : '无'} → ${m2 ? HM(m2.start) : '无'}`);
}
{
  const d1 = build(Object.assign(BASE(), { lunchDur: 60 }), SIGHTS()).days[0];
  const d2 = build(Object.assign(BASE(), { lunchDur: 90 }), SIGHTS()).days[0];
  const m1 = d1.items.find((i) => i.kind === 'meal' && i.type !== 'dinner');
  const m2 = d2.items.find((i) => i.kind === 'meal' && i.type !== 'dinner');
  check('午餐时长', !!m1 && !!m2 && (m2.end - m2.start) - (m1.end - m1.start) === 30,
    `60→90 分，实际 ${m2 ? m2.end - m2.start : '-'} 分`);
}
{
  const d = build(Object.assign(BASE(), { lunchOn: false }), SIGHTS()).days[0];
  check('午餐开关', !d.items.some((i) => i.kind === 'meal' && i.type !== 'dinner'), '关掉后无午餐块');
}

/* 3 晚餐：晚餐店应落在晚餐窗口 */
{
  const v1 = byId(build(Object.assign(BASE(), { dinnerStart: 1050 })).days[0], 'f');
  const v2 = byId(build(Object.assign(BASE(), { dinnerStart: 1140 })).days[0], 'f');
  check('晚餐时间', !!v1 && !!v2 && v2.arrive > v1.arrive,
    `18:00→19:00 四季民福到达 ${v1 ? HM(v1.arrive) : '-'} → ${v2 ? HM(v2.arrive) : '-'}`);
}
{
  const withDinner = build(BASE(), SIGHTS()).days[0].items.filter((i) => i.kind === 'meal' && i.type === 'dinner');
  check('没有晚餐店时补餐块', withDinner.length === 1, withDinner[0] ? `${HM(withDinner[0].start)} 晚餐` : '没补');
}

/* 4 餐饮安排：小吃不锁饭点 */
{
  const ps = ALL();
  ps[4].meal = 'snack'; ps[4].minutes = 20;
  const v = byId(build(BASE(), ps).days[0], 'e');
  check('小吃不锁饭点', !!v && (v.mealDev || 0) === 0, `全聚德改小吃，到达 ${v ? HM(v.arrive) : '-'}`);
}
{
  const v = byId(build(BASE()).days[0], 'e');
  check('午餐店锁中午', !!v && v.arrive >= 690 && v.arrive <= 810, `全聚德到达 ${v ? HM(v.arrive) : '-'}`);
}

/* 5 节奏 */
{
  const r = build(Object.assign(BASE(), { pace: 'relaxed' })).days[0];
  const n = build(BASE()).days[0];
  const p = build(Object.assign(BASE(), { pace: 'packed' })).days[0];
  check('节奏改收工时间', r.plannedEnd === 1200 && n.plannedEnd === 1260 && p.plannedEnd === 1305,
    `轻松 ${HM(r.plannedEnd)} / 适中 ${HM(n.plannedEnd)} / 紧凑 ${HM(p.plannedEnd)}`);
}
{
  const many = ALL().concat([
    P('g', '天坛', 39.8820, 116.4070, '景点', 90), P('i', '北海公园', 39.9250, 116.3890, '景点', 90),
    P('j', '什刹海', 39.9400, 116.3860, '景点', 90), P('k', '恭王府', 39.9350, 116.3860, '景点', 90),
  ]);
  const r = build(Object.assign(BASE(), { days: 3, pace: 'relaxed' }), many);
  const maxPerDay = Math.max(...r.days.map((d) => d.order.length));
  const nMax = Math.max(...build(Object.assign(BASE(), { days: 3 }), many).days.map((d) => d.order.length));
  check('轻松模式每天 ≤4 点', maxPerDay <= 4, `轻松最多 ${maxPerDay} 个/天，适中 ${nMax} 个/天`);
}

/* 6 出行偏好（估算模式） */
{
  const w = build(Object.assign(BASE(), { pref: 'WALK_ONLY' })).days[0];
  const t = build(Object.assign(BASE(), { pref: 'TAXI' })).days[0];
  const wm = [...new Set(w.legs.map((l) => l.leg.mode))].join('/');
  const tm = [...new Set(t.legs.map((l) => l.leg.mode))].join('/');
  check('偏好：仅步行', wm === 'walking', `实际 ${wm}`);
  check('偏好：打车', tm === 'taxi', `实际 ${tm}`);
}

/* 7 停留时间 */
{
  const ps = ALL(); ps[0].minutes = 30;
  const v = byId(build(BASE(), ps).days[0], 'a');
  check('停留时间', v && v.depart - v.arrive === 30, `120→30，实际 ${v ? v.depart - v.arrive : '-'} 分`);
}

/* 8 时间窗 */
{
  const ps = ALL(); ps[3].winTo = '15:00';
  const v = byId(build(BASE(), ps).days[0], 'd');
  check('最晚到达', v && v.arrive <= 900, `雍和宫 ≤15:00，实际 ${v ? HM(v.arrive) : '未排'}`);
}
{
  const ps = ALL(); ps[3].winFrom = '16:00';
  const v = byId(build(BASE(), ps).days[0], 'd');
  check('最早到达（会等）', v && v.arrive >= 960, `雍和宫 ≥16:00，实际 ${v ? HM(v.arrive) : '未排'}`);
}

/* 9 分天锁定 / 优先级 / 自动舍弃 */
{
  const ps = ALL(); ps[3].day = 1;
  const plan = build(Object.assign(BASE(), { days: 2 }), ps);
  check('分天锁定', plan.days[1].order.some((p) => p.id === 'd'), '雍和宫锁到第 2 天');
}
{
  const many = ALL().concat([P('g', '天坛', 39.8820, 116.4070, '景点', 120)]);
  many[0].must = 2; many[4].must = 0;
  const plan = build(Object.assign(BASE(), { dayEnd: 780 }), many);
  const lost = (plan.skipped || []).map((s) => s.place.name);
  check('必去优先保留', !lost.includes('故宫博物院'), `丢弃：${lost.join('、') || '无'}`);
}
{
  const many = ALL().concat([P('g', '天坛', 39.8820, 116.4070, '景点', 120)]);
  const on = build(Object.assign(BASE(), { dayEnd: 780 }), many);
  const off = build(Object.assign(BASE(), { dayEnd: 780, autoTrim: false }), many);
  check('自动舍弃开关', on.skipped.length > 0 && off.skipped.length === 0,
    `开=丢 ${on.skipped.length}，关=丢 ${off.skipped.length}`);
}

/* 10 闭环：回住处 / 到站 / 发车 */
{
  const t = Object.assign(BASE(), { returnHome: false });
  check('每晚回住处', !build(t).days[0].items.some((i) => i.kind === 'returnhome'), '关掉后无回住处');
}
{
  const t = Object.assign(BASE(), {
    days: 2, arrive: { id: 'ar', name: '北京站', lat: 39.9040, lng: 116.4270, city: '北京市' }, arriveTime: 600,
    depart: { id: 'dp', name: '北京南站', lat: 39.8650, lng: 116.3780, city: '北京市' }, departTime: 1020,
  });
  const plan = build(t);
  check('到达时间', plan.days[0].start >= 600, `到达 10:00，第 1 天 ${HM(plan.days[0].start)} 开始`);
  check('发车时间', plan.days[1].end <= 990, `发车 17:00，末天 ${HM(plan.days[1].end)} 收工`);
}
{
  const base = Object.assign(BASE(), { days: 1, departTime: 1080 });
  const a = build(base).days[0];
  const b = build(Object.assign({}, base, { returnBuffer: 60 })).days[0];
  check('没返程站时提前收工', b.plannedEnd === a.plannedEnd - 60,
    `提前 60 分：${HM(a.plannedEnd)} → ${HM(b.plannedEnd)}`);
}

/* 11 地点跳过 */
{
  const ps = ALL(); ps[1].skip = true;
  const d = build(BASE(), ps).days[0];
  check('跳过标记', !d.order.some((p) => p.id === 'b'), '景山公园标记跳过');
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
