/* 无浏览器环境下验证规划引擎（仅用于开发自检） */
globalThis.window = globalThis;
require('./public/js/util.js');
require('./public/js/planner.js');
require('./public/js/sample.js');

const S = globalThis.SAMPLE_TRIP;
const places = S.places.map((p, i) => Object.assign({ id: 'p' + i, must: 1, day: null, winFrom: '', winTo: '' }, p));

const trip = {
  city: S.trip.city,
  days: S.trip.days,
  dayStart: 8 * 60 + 30,
  dayEnd: 21 * 60,
  lunchOn: true,
  lunchStart: 12 * 60,
  lunchDur: 60,
  returnHome: S.trip.returnHome,
  origin: S.trip.origin,
  pref: 'RECOMMEND',
  startDate: '2026-11-20',
};

const legOf = (a, b) => (a.id === b.id ? { mode: 'walking', minutes: 0, meters: 0, est: true } : Planner.estimateLeg(a, b, trip.pref));

console.log('== 天数建议 ==');
console.log('suggestDays =', Planner.suggestDays(places, trip, legOf));

const t0 = Date.now();
const plan = Planner.buildPlan(places, trip, legOf);
console.log('plan 耗时', Date.now() - t0, 'ms');

let totalPlaces = 0;
for (const d of plan.days) {
  totalPlaces += d.order.length;
  console.log(`\n--- 第${d.index + 1}天  ${U.toHM(d.start)}-${U.toHM(d.end)}  在途${d.totals.travel}分 游览${d.totals.visit}分 步行${d.totals.walk}m 超时${d.overflow}分`);
  for (const it of d.items) {
    if (it.kind === 'visit') console.log(`  ${U.toHM(it.arrive)}-${U.toHM(it.depart)}  ${it.place.name} (${it.place.minutes}分)`);
    else if (it.kind === 'meal') console.log(`  ${U.toHM(it.start)} 午餐`);
    else if (it.kind === 'travel') console.log(`      ↳ ${it.leg.mode} ${it.leg.minutes}分 ${it.leg.meters}m`);
    else if (it.kind === 'origin') console.log(`  ${U.toHM(it.depart)} 出发点 ${it.place.name}`);
  }
}

console.log('\n覆盖地点：', totalPlaces, '/', places.length);
console.log('警告：');
plan.warnings.forEach((w) => console.log('  -', w.level, w.text));

/* 手动调序测试 */
console.log('\n== 手动调序（第1天前两个对调）==');
const d0 = plan.days[0];
const a = d0.order[0], b = d0.order[1];
d0.order.forEach((p, i) => { p.day = 0; p.seq = i; });
a.seq = 1; b.seq = 0;
const plan2 = Planner.buildPlan(places, trip, legOf);
console.log('调序后第1天顺序：', plan2.days[0].order.map((p) => p.name).join(' → '));

/* 时间窗测试 */
console.log('\n== 时间窗（故宫 10:00 前到达）==');
places.forEach((p) => { p.day = null; p.seq = null; });
const gu = places.find((p) => p.name.includes('故宫'));
gu.winTo = '10:00';
const plan3 = Planner.buildPlan(places, trip, legOf);
plan3.days.forEach((d) => {
  const hit = d.items.find((it) => it.kind === 'visit' && it.place === gu);
  if (hit) console.log(`故宫安排在第${d.index + 1}天 ${U.toHM(hit.arrive)} 到达；该天超时 ${d.overflow} 分`);
});
plan3.warnings.forEach((w) => console.log('  -', w.level, w.text));
