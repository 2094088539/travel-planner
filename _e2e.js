/* 端到端自检：模拟浏览器「规划 → 取真实路线 → 重排」的完整流程 */
globalThis.window = globalThis;
require('./public/js/util.js');
require('./public/js/planner.js');
require('./public/js/sample.js');

const http = require('http');
const PORT = Number(process.env.PORT || 8788);

function get(p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p }, (s) => {
      let d = '';
      s.on('data', (c) => { d += c; });
      s.on('end', () => res(JSON.parse(d)));
    });
    r.on('error', rej);
    r.end();
  });
}

const S = globalThis.SAMPLE_TRIP;
const places = S.places.map((p, i) => Object.assign({ id: 'p' + i, must: 1, day: null, seq: null, winFrom: '', winTo: '' }, p));

const tm = {
  city: '北京', days: 3,
  dayStart: 8 * 60 + 30, dayEnd: 21 * 60,
  lunchOn: true, lunchStart: 12 * 60, lunchDur: 60,
  returnHome: true, origin: S.trip.origin, pref: 'RECOMMEND', startDate: '2026-11-20',
  adults: 2, children: 1, interests: [], pace: 'normal', autoTrim: true,
  arrive: S.trip.arrive, arriveTime: 8 * 60,
  depart: S.trip.depart, departTime: 20 * 60,
  fromCity: '上海',
};

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const key = (a, b) => `${tm.pref}|${r5(a.lat)},${r5(a.lng)}>${r5(b.lat)},${r5(b.lng)}`;
const cache = new Map();
const legOf = (a, b) => (a.id && a.id === b.id)
  ? { mode: 'walking', minutes: 0, meters: 0, est: true }
  : (cache.get(key(a, b)) || Planner.estimateLeg(a, b, tm.pref));

function collect(plan) {
  const seen = new Set(), out = [];
  for (const d of plan.days) for (const l of d.legs) {
    const k = key(l.from, l.to);
    if (cache.has(k) || seen.has(k)) continue;
    seen.add(k); out.push({ k, a: l.from, b: l.to });
  }
  return out;
}

(async () => {
  let plan = Planner.buildPlan(places, tm, legOf);
  let total = 0;

  async function runJobs(jobs, label) {
    console.log(`\n== ${label}：${jobs.length} 段 ==`);
    for (const j of jobs) {
      const est = Planner.estimateLeg(j.a, j.b, tm.pref);
      const primary = est.mode === 'walking' ? 'walking' : est.mode === 'taxi' ? 'driving' : 'transit';
      const straight = U.haversine(j.a, j.b);
      let best = null;
      try {
        const r = await get(`/api/leg?from=${j.a.lat},${j.a.lng}&to=${j.b.lat},${j.b.lng}&mode=${primary}&policy=${tm.pref}`);
        total++;
        if (r.ok) best = r.data;
        else console.log('  失败', j.a.name, '→', j.b.name, r.error && r.error.message);
        if (primary === 'transit' && straight < 2600 && best && best.minutes >= 20) {
          const r2 = await get(`/api/leg?from=${j.a.lat},${j.a.lng}&to=${j.b.lat},${j.b.lng}&mode=walking&policy=${tm.pref}`);
          total++;
          if (r2.ok && r2.data.minutes < best.minutes - 3) best = r2.data;
        }
      } catch (e) { console.log('  异常', e.message); }
      cache.set(j.k, best || Object.assign({}, est, { failed: true }));
    }
  }

  await runJobs(collect(plan), '第 1 轮取真实路线');
  plan = Planner.refine(plan, tm, legOf, { rebalance: true });

  const rest = collect(plan);
  if (rest.length) {
    await runJobs(rest, '第 2 轮补缺');
  }
  plan = Planner.reschedule(plan, tm, legOf);

  console.log(`\n共请求 ${total} 段路线`);
  let real = 0, est = 0;
  for (const d of plan.days) for (const l of d.legs) l.leg.real ? real++ : est++;
  console.log(`真实段落 ${real}，估算/失败 ${est}`);

  for (const d of plan.days) {
    console.log(`\n===== 第 ${d.index + 1} 天  ${U.toHM(d.start)}–${U.toHM(d.end)}  ${d.overflow > 0 ? '⚠超时 ' + d.overflow + '分' : '不超时'} =====`);
    console.log(`在途 ${d.totals.travel} 分 · 游览 ${d.totals.visit} 分 · 步行 ${d.totals.walk} 米 · 车费 ${d.totals.fare} 元`);
    for (const it of d.items) {
      if (it.kind === 'origin') console.log(`  ${U.toHM(it.depart)} 出发：${it.place.name}`);
      else if (it.kind === 'meal') console.log(`  ${U.toHM(it.start)}–${U.toHM(it.end)} 午餐`);
      else if (it.kind === 'visit') console.log(`  ${U.toHM(it.arrive)}–${U.toHM(it.depart)} ${it.place.name}`);
      else if (it.kind === 'travel') {
        const l = it.leg;
        const tag = l.real ? '真实' : '估算';
        console.log(`     ↓ ${U.toHM(it.depart)} [${tag}] ${l.minutes}分 ${l.meters}米 ${l.fare ? '¥' + l.fare : ''} ${l.summary || ''}`);
        if (l.real && l.steps && process.env.VERBOSE) {
          for (const s of l.steps) {
            if (s.type === 'ride') console.log(`         🚇 ${s.line} 往${s.direction} ${s.from}${s.fromExit ? '(' + s.fromExit + ')' : ''} → ${s.to} ${s.stops}站 ${s.minutes}分`);
            else console.log(`         🚶 步行 ${s.meters}米 ${s.minutes}分`);
          }
        }
      }
    }
  }
  console.log('\n警告：');
  plan.warnings.forEach((w) => console.log(' -', w.level, w.text));

  console.log('\n========== 导出的 Markdown 预览（前 60 行）==========');
  console.log(Planner.planToText(plan, tm, places).split('\n').slice(0, 60).join('\n'));
})();
