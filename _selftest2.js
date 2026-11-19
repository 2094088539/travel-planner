/* 新功能自检：兴趣、节奏、超时舍弃、多方案、预算 */
globalThis.window = globalThis;
require('./public/js/util.js');
require('./public/js/budget.js');
require('./public/js/planner.js');
require('./public/js/sample.js');

const S = globalThis.SAMPLE_TRIP;
const places = S.places.map((p, i) => Object.assign({ id: 'p' + i, must: 1, day: null, seq: null, winFrom: '', winTo: '', ticket: 0, skip: false }, p));

const base = {
  city: '北京', days: 3,
  dayStart: 8 * 60 + 30, dayEnd: 21 * 60,
  lunchOn: true, lunchStart: 12 * 60, lunchDur: 60,
  returnHome: false, origin: S.trip.origin, pref: 'RECOMMEND',
  startDate: '2026-11-20',
  travelers: 2, interests: [], pace: 'normal', autoTrim: true,
  lodgingPerNight: 350, mealPerPerson: 70, mealsPerDay: 2, miscPerDay: 60,
};

const legOf = (a, b) => (a.id && a.id === b.id)
  ? { mode: 'walking', minutes: 0, meters: 0, est: true }
  : Planner.estimateLeg(a, b, base.pref);

const show = (tag, plan) => {
  let line = `${tag}  `;
  plan.days.forEach((d) => {
    line += `[D${d.index + 1} ${U.toHM(d.start)}-${U.toHM(d.end)} 超${d.overflow} ${d.order.length}点] `;
  });
  if (plan.skipped && plan.skipped.length) line += `舍弃:${plan.skipped.map((x) => x.place.name).join(',')}`;
  console.log(line);
};

console.log('=== 1. 节奏影响结束时间 ===');
for (const pace of ['relaxed', 'normal', 'packed']) {
  const t = Object.assign({}, base, { pace });
  const p = Planner.buildPlan(places, t, legOf);
  show(`pace=${pace.padEnd(8)}`, p);
}

console.log('\n=== 2. 兴趣影响取舍（2 天硬塞 12 个点）===');
for (const interests of [[], ['美食'], ['购物'], ['自然']]) {
  const t = Object.assign({}, base, { days: 2, interests });
  const p = Planner.buildPlan(places, t, legOf);
  show(`兴趣=${JSON.stringify(interests).padEnd(16)}`, p);
}

console.log('\n=== 3. 多方案对比 ===');
const variants = Planner.buildVariants(places, base, legOf);
variants.forEach((v) => {
  const s = v.stats;
  console.log(
    `${v.name.padEnd(4)} ${s.days}天  覆盖${s.covered}  在途${s.travel}分  步行${s.walk}m  车费¥${Math.round(s.fare)}`,
    `最长单段${s.maxHop}分  最晚${U.toHM(s.maxEnd)}  超时${s.overflow}  舍弃${s.skipped}`
  );
});

console.log('\n=== 4. 预算 ===');
const plan = Planner.buildPlan(places, base, legOf);
// 给几个点填门票
places.find((p) => p.name.includes('故宫')).ticket = 60;
places.find((p) => p.name.includes('颐和园')).ticket = 30;
places.find((p) => p.name.includes('天坛')).ticket = 15;
const est = Budget.estimate(plan, base, places);
console.log(`合计 ¥${est.total}  ${est.pax}人 ${est.days}天  人均 ¥${est.perPerson}  乘车 ${est.rideLegs} 段`);
est.items.forEach((i) => console.log(`  ${i.name.padEnd(3)} ¥${i.amount}`));

console.log('\n=== 5. 快速记账解析 ===');
['午饭 128', '打车 35', '门票 60元', '奶茶18', '酒店 680', '随便说点什么'].forEach((t) => {
  const r = Budget.parseQuick(t);
  console.log(' ', t.padEnd(12), r ? `→ ${r.cat} ${r.amount} 「${r.note}」` : '→ 识别失败');
});

console.log('\n=== 6. 跳过地点 ===');
const withSkip = places.map((p) => Object.assign({}, p));
withSkip.find((p) => p.name.includes('圆明园')).skip = true;
const p6 = Planner.buildPlan(withSkip, base, legOf);
show('圆明园已跳过  ', p6);

console.log('\n=== 7. 导出文本仍可用 ===');
const txt = Planner.planToText(plan, base, places);
console.log('  长度', txt.length, '首行', txt.split('\n')[0]);
