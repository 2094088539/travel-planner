/**
 * 行程 → 思维导图（.xmind）
 *
 * .xmind 是一个 zip，装三个文件：
 *   content.json    思维导图结构（新版 XMind 只认这个）
 *   metadata.json   元信息
 *   manifest.json   文件清单
 *
 * 注意：新版 XMind 写的 content.xml 其实是一段「请勿用旧版打开」的警告占位，
 * 不是数据，所以这里不生成 XML。
 *
 * 不依赖任何第三方库（zip 自己打包，只存储不压缩），浏览器和 Node 同一份代码。
 */
(function (global) {
  'use strict';

  const CAT_ORDER = ['餐饮', '景点', '博物馆', '购物', '住宿', '交通枢纽', '其他'];

  function groupPlaces(places) {
    const map = new Map();
    (places || []).forEach((p) => {
      const k = p.category || '其他';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    });
    const known = CAT_ORDER.filter((k) => map.has(k));
    const extra = [...map.keys()].filter((k) => CAT_ORDER.indexOf(k) < 0);
    return known.concat(extra).map((k) => ({ name: k, list: map.get(k) }));
  }

  /* 城市归一：'北京市' 和 '北京' 视为同一个 */
  function cityKey(o) {
    return String((o && o.city) || '').replace(/[市\s]/g, '');
  }

  /* 跨城判定：两边都有城市名就比名字，缺一个就按直线距离兜底（120 公里） */
  function isCrossCity(a, b) {
    if (!a || !b) return false;
    const ca = cityKey(a);
    const cb = cityKey(b);
    if (ca && cb) return ca !== cb;
    try { return U.haversine(a, b) > 120000; } catch (e) { return false; }
  }

  function cityLabel(o) {
    return cityKey(o) || '异地';
  }

  /* 一段路怎么写：不超过一行，不带表情 */
  function legText(leg, from, to) {
    if (!leg) return '';
    if (isCrossCity(from, to)) {
      return `跨城（${cityLabel(from)} 到 ${cityLabel(to)}），不安排行程`;
    }
    if (leg.mode === 'walking') {
      return `步行 ${U.dist(leg.meters)}，${U.durShort(leg.minutes)}`;
    }
    if (leg.mode === 'taxi' || leg.mode === 'driving') {
      return `打车 ${U.dist(leg.meters)}，${U.durShort(leg.minutes)}`;
    }
    const bits = [];
    bits.push(leg.summary || '公共交通');
    bits.push(U.durShort(leg.minutes));
    if (leg.transfers) bits.push(`换乘${leg.transfers}次`);
    if (leg.fare) bits.push(`¥${leg.fare}`);
    return bits.join('，');
  }

  /* 落脚点下面的两行：地址、通勤 */
  function placeInfo(place, leg, from) {
    const kids = [];
    const addr = String(place.address || '').replace(/^[^省市区县]{0,6}(省|市)/, '');
    if (addr && addr !== place.name) kids.push({ label: `地址：${addr}`, children: [] });
    if (place.hours) kids.push({ label: `营业时间：${place.hours}`, children: [] });
    const meta = [];
    if (place.rating) meta.push(`评分 ${place.rating}`);
    if (place.cost) meta.push(`人均 ¥${place.cost}`);
    if (place.ticket) meta.push(`门票 ¥${place.ticket}`);
    if (meta.length) kids.push({ label: meta.join(' · '), children: [] });
    if (leg) kids.push({ label: `通勤：${legText(leg, from, place)}`, children: [] });
    if (place.tips) kids.push({ label: `建议：${place.tips}`, children: [] });
    return kids;
  }

  /* 这份行程涉及哪些城市（缺 city 的按目的地城市算，避免误判） */
  function citiesOf(places, trip) {
    const fallback = cityKey({ city: trip && trip.city });
    const set = new Set();
    (places || []).forEach((p) => {
      const c = cityKey(p) || fallback;
      if (c) set.add(c);
    });
    if (!set.size && fallback) set.add(fallback);
    return [...set];
  }

  /* 跨城行程：只按城市整理地点，不排日程（城际交通排不了，硬排就是假行程） */
  function cityTree(places, cities) {
    const root = { label: `${cities.join(' / ')} 跨城行程`, children: [] };
    root.children.push({
      label: `跨城不做日程安排（${cities.length} 个城市，城际交通请自行安排）`,
      children: [],
    });
    cities.forEach((c) => {
      const inCity = (places || []).filter((p) => (cityKey(p) || c) === c);
      if (!inCity.length) return;
      root.children.push({
        label: `${c}（${inCity.length}）`,
        children: groupPlaces(inCity).map((g) => ({
          label: `${g.name}（${g.list.length}）`,
          children: g.list.map((p) => {
            const info = [p.address, p.district, p.tel].filter(Boolean).join('，');
            return { label: p.name, children: info ? [{ label: info, children: [] }] : [] };
          }),
        })),
      });
    });
    return root;
  }

  /* 生成树：行程 → 第N天 → 时间+景点（地址/通勤）→ 全部地点（按类别） */
  function tree(plan, trip, places) {
    const city = (trip && trip.city) || '行程';
    const cities = citiesOf(places, trip);
    if (cities.length > 1) return cityTree(places, cities);

    const root = { label: `${city.replace(/市$/, '')} ${plan.days.length} 天`, children: [] };

    (plan.days || []).forEach((d, i) => {
      const date = trip && trip.startDate
        ? U.fmtDate(U.addDays(trip.startDate, i)).split(' ')[0]
        : '';
      const dists = Array.from(new Set(d.order.map((p) => p.district).filter(Boolean)));
      const node = {
        label: `第${i + 1}天${date ? ' ' + date : ''}${dists.length ? ' ' + dists.join('/') : ''}`,
        children: [],
      };

      let leg = null;
      let from = null;

      (d.items || []).forEach((it) => {
        if (it.kind === 'travel') { leg = it.leg; from = it.from; return; }

        if (it.kind === 'origin') {
          node.children.push({
            label: `${U.toHM(it.depart)} ${it.place.name} 出发`,
            children: placeInfo(it.place, leg, from),
          });
        } else if (it.kind === 'checkin') {
          node.children.push({
            label: `${U.toHM(it.arrive)} 住处放行李`,
            children: placeInfo(it.place, leg, from),
          });
        } else if (it.kind === 'visit') {
          node.children.push({
            label: `${U.toHM(it.arrive)}-${U.toHM(it.depart)} ${it.place.name}`,
            children: placeInfo(it.place, leg, from),
          });
        } else if (it.kind === 'meal') {
          node.children.push({
            label: `${U.toHM(it.start)} ${it.type === 'dinner' ? '晚餐' : '午餐'}`,
            children: leg ? [{ label: `通勤：${legText(leg, from, it.place)}`, children: [] }] : [],
          });
        } else if (it.kind === 'returnhome') {
          node.children.push({
            label: `${U.toHM(it.arrive)} 回到住处`,
            children: leg ? [{ label: `通勤：${legText(leg, from, it.place)}`, children: [] }] : [],
          });
        } else if (it.kind === 'depart') {
          node.children.push({
            label: `${U.toHM(it.arrive)} ${it.place.name} ${it.noRoute ? '返程' : '候车'}`,
            children: leg ? [{ label: `通勤：${legText(leg, from, it.place)}`, children: [] }] : [],
          });
        }
        leg = null;
        from = null;
      });

      root.children.push(node);
    });

    // 附：全部地点，按类别分组
    if (places && places.length) {
      const groups = groupPlaces(places);
      root.children.push({
        label: `全部地点（${places.length}）`,
        children: groups.map((g) => ({
          label: `${g.name}（${g.list.length}）`,
          children: g.list.map((p) => {
            const info = [p.address, p.district, p.tel].filter(Boolean).join('，');
            const sub = [];
            if (info) sub.push({ label: `地址：${info}`, children: [] });
            const bits = [];
            if (p.hours) bits.push(`营业时间 ${p.hours}`);
            if (p.rating) bits.push(`评分 ${p.rating}`);
            if (p.cost) bits.push(`人均 ¥${p.cost}`);
            if (bits.length) sub.push({ label: bits.join(' · '), children: [] });
            if (p.tips) sub.push({ label: `建议：${p.tips}`, children: [] });
            return { label: p.name, children: sub };
          }),
        })),
      });
    }

    return root;
  }

  /* ---------------- zip 打包 ---------------- */

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return Uint8Array.from(Buffer.from(str, 'utf8'));
  }

  let CRC_TABLE = null;
  function crc32(data) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[i] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* 只存储不压缩，浏览器和 Node 都能跑 */
  function zipStore(files) {
    const parts = [];
    const central = [];
    let offset = 0;

    files.forEach((f) => {
      const name = utf8(f.name);
      const data = f.data;
      const crc = crc32(data);

      const lh = new Uint8Array(30 + name.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);   // 文件名 UTF-8
      dv.setUint16(8, 0, true);        // 存储
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true);
      dv.setUint16(28, 0, true);
      lh.set(name, 30);

      const cd = new Uint8Array(46 + name.length);
      const dv2 = new DataView(cd.buffer);
      dv2.setUint32(0, 0x02014b50, true);
      dv2.setUint16(4, 20, true);
      dv2.setUint16(6, 20, true);
      dv2.setUint16(8, 0x0800, true);
      dv2.setUint16(10, 0, true);
      dv2.setUint16(12, 0, true);
      dv2.setUint16(14, 0x21, true);
      dv2.setUint32(16, crc, true);
      dv2.setUint32(20, data.length, true);
      dv2.setUint32(24, data.length, true);
      dv2.setUint16(28, name.length, true);
      dv2.setUint16(30, 0, true);
      dv2.setUint16(32, 0, true);
      dv2.setUint16(34, 0, true);
      dv2.setUint16(36, 0, true);
      dv2.setUint32(38, 0, true);
      dv2.setUint32(42, offset, true);
      cd.set(name, 46);

      parts.push(lh, data);
      central.push(cd);
      offset += lh.length + data.length;
    });

    let cdSize = 0;
    central.forEach((c) => { cdSize += c.length; });

    const eocd = new Uint8Array(22);
    const dv3 = new DataView(eocd.buffer);
    dv3.setUint32(0, 0x06054b50, true);
    dv3.setUint16(4, 0, true);
    dv3.setUint16(6, 0, true);
    dv3.setUint16(8, files.length, true);
    dv3.setUint16(10, files.length, true);
    dv3.setUint32(12, cdSize, true);
    dv3.setUint32(16, offset, true);
    dv3.setUint16(20, 0, true);

    const out = new Uint8Array(offset + cdSize + 22);
    let p = 0;
    parts.forEach((b) => { out.set(b, p); p += b.length; });
    central.forEach((c) => { out.set(c, p); p += c.length; });
    out.set(eocd, p);
    return out;
  }

  /* ---------------- xmind 结构 ---------------- */

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  function toTopic(n, isRoot) {
    const t = isRoot
      ? { id: uuid(), class: 'topic', title: n.label, structureClass: 'org.xmind.ui.timeline.left' }
      : { id: uuid(), title: n.label };
    const kids = n.children || [];
    if (kids.length) t.children = { attached: kids.map((c) => toTopic(c)) };
    return t;
  }

  /* 模板主题：XMind 默认彩虹配色（从模板文件取出，直接写进 content.json） */
  const THEME = {"boundary":{"properties":{"borderColor":"#00000066","borderLineStyle":"dash","borderLineWidth":2,"fill":"#9b9b9bff","fontFamily":"Roboto","fontSize":13,"fontStyle":"normal","fontWeight":"400","radius":6,"textAlign":"center"}},"centralTopic":{"properties":{"borderColor":"#000000","borderLineWidth":3,"fill":"#000000ff","fontFamily":"Roboto","fontSize":28,"fontStyle":"normal","fontWeight":"700","lineArrowShape":"none","lineClass":4,"lineColor":"#ADADAD","lineDash":[0,0],"lineWidth":3,"radius":6,"textAlign":"center"}},"floatingTopic":{"properties":{"borderColor":"#EEEBEE","borderLineWidth":0,"fill":"#eeebeeff","fontFamily":"Roboto","fontSize":14,"fontStyle":"normal","fontWeight":"500","lineArrowShape":"none","lineClass":6,"lineDash":[0,0],"lineWidth":2,"radius":6,"textAlign":"center"}},"mainTopic":{"properties":{"borderColor":"#ffffff","borderLineWidth":3,"fill":"#ff6b6bff","fontFamily":"Roboto","fontSize":18,"fontStyle":"normal","fontWeight":"500","lineClass":6,"lineWidth":2,"radius":6,"textAlign":"left"}},"relationships":{"properties":{"fontFamily":"Roboto","fontSize":13,"fontStyle":"normal","fontWeight":"400","lineArrowBeginShape":"none","lineArrowShape":"curved","lineColor":"#00000066","lineDash":[6,6],"lineWidth":2,"relationLineShape":"curved","textAlign":"center"}},"style":{"properties":{"fill":"#ffffffff","rainbowStyleList":[{"mainTopic":{"borderColor":"#FF6B6B","fill":"#FF6B6B","lineColor":"#FF6B6B"},"subTopic":{"borderColor":"#FF6B6B","color":"#660000","fill":"#ff6b6b33","lineColor":"#FF6B6B"}},{"mainTopic":{"borderColor":"#FF9F69","fill":"#FF9F69","lineColor":"#FF9F69"},"subTopic":{"borderColor":"#FF9F69","color":"#662400","fill":"#ff9f6933","lineColor":"#FF9F69"}},{"mainTopic":{"borderColor":"#97D3B6","fill":"#97D3B6","lineColor":"#97D3B6"},"subTopic":{"borderColor":"#97D3B6","color":"#1e4733","fill":"#97d3b633","lineColor":"#97D3B6"}},{"mainTopic":{"borderColor":"#88E2D7","fill":"#88E2D7","lineColor":"#88E2D7"},"subTopic":{"borderColor":"#88E2D7","color":"#13524a","fill":"#88e2d733","lineColor":"#88E2D7"}},{"mainTopic":{"borderColor":"#6FD0F9","fill":"#6FD0F9","lineColor":"#6FD0F9"},"subTopic":{"borderColor":"#6FD0F9","color":"#044661","fill":"#6fd0f933","lineColor":"#6FD0F9"}},{"mainTopic":{"borderColor":"#E18BEE","fill":"#E18BEE","lineColor":"#E18BEE"},"subTopic":{"borderColor":"#E18BEE","color":"#4e0d58","fill":"#e18bee33","lineColor":"#E18BEE"}}]}},"subTopic":{"properties":{"borderColor":"#ffffff","borderLineWidth":0,"fill":"#ff6b6b33","fontFamily":"Roboto","fontSize":14,"fontStyle":"normal","fontWeight":"500","lineClass":6,"radius":6,"textAlign":"left"}},"summaryTopic":{"properties":{"borderColor":"#000000","borderLineWidth":0,"fill":"#000000ff","fontFamily":"Roboto","fontSize":14,"fontStyle":"normal","fontWeight":"400","lineClass":6,"lineColor":"#000000","lineDash":[0,0],"lineWidth":2,"summaryLineShape":"straight","textAlign":"center"}},"topic":"default"};

  /* 把主题转成 xmind 文件里的形状：style → map，每个槽位带 id */
  function themeForFile(t) {
    const out = {};
    Object.keys(t || {}).forEach((k) => {
      if (k === 'topic') return;
      const slot = t[k] || {};
      const key = k === 'style' ? 'map' : k;
      out[key] = { id: uuid(), properties: slot.properties || {} };
    });
    return out;
  }

  function contentJson(root) {
    return [{
      id: uuid(),
      revisionId: uuid(),
      class: 'sheet',
      title: '思维导图',
      rootTopic: toTopic(root, true),
      topicOverlapping: 'overlap',
      arrangeableLayerOrder: [],
      zones: [],
      theme: Object.assign({ topic: 'default' }, themeForFile(THEME)),
    }];
  }

  /* 返回 Uint8Array，交给下载或上传 */
  function xmind(root) {
    const content = JSON.stringify(contentJson(root));
    const meta = JSON.stringify({
      dataStructureVersion: '3',
      creator: { name: 'travel-planner', version: '1.0' },
      layoutEngineVersion: '5',
    });
    const manifest = JSON.stringify({
      'file-entries': { 'content.json': {}, 'metadata.json': {} },
    });

    return zipStore([
      { name: 'content.json', data: utf8(content) },
      { name: 'metadata.json', data: utf8(meta) },
      { name: 'manifest.json', data: utf8(manifest) },
    ]);
  }

  global.Mind = { tree, xmind };
})(window);
