/**
 * 把整个应用打包成单个 HTML（可双击直接打开，无需 Node 服务）
 *
 *   node build-standalone.js
 *   → travel-planner.html
 *
 * 做三件事：
 *   1. 内联 Leaflet 的 css/js 与自己的 css/js
 *   2. 打上 TMAP_DIRECT 标记，让 app.js 走 JSONP 而不是本地代理
 *   3. 插入 tmap-norm.js（响应解析）与 tmap-direct.js（JSONP 客户端）
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');

let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

/* ---------- 1. 样式 ---------- */
const styleTag = (css) => `<style>\n${css}\n</style>`;
html = html.replace(
  /<link rel="stylesheet" href="vendor\/leaflet\.css" \/>/,
  () => styleTag(read('vendor/leaflet.css'))
);
html = html.replace(
  /<link rel="stylesheet" href="css\/style\.css" \/>/,
  () => styleTag(read('css/style.css'))
);
html = html.replace(
  /<link rel="stylesheet" href="css\/home\.css" \/>/,
  () => styleTag(read('css/home.css'))
);

/* ---------- 2. Leaflet（含 CDN 兜底那段一起换掉） ---------- */
const leafletFallback =
  /<script src="vendor\/leaflet\.js"><\/script>\s*<script>[\s\S]*?<\/script>/;
if (!leafletFallback.test(html)) throw new Error('找不到 Leaflet 引入段');
html = html.replace(leafletFallback, () => `<script>\n${read('vendor/leaflet.js')}\n</script>`);

/* ---------- 3. 业务脚本 ---------- */
// 本地私钥文件不进仓库，但打包时要带上（产物 travel-planner.html 已在 .gitignore）
html = html.replace(/<script src="js\/config\.local\.js"[^>]*><\/script>\s*/, '');

const ORDER = ['config', 'util', 'budget', 'mind', 'planner', 'sample', 'amap', 'ai', 'home', 'app'];
for (const name of ORDER) {
  const tag = `<script src="js/${name}.js"></script>`;
  if (html.indexOf(tag) < 0) throw new Error('找不到 ' + tag);

  if (name === 'config') {
    let inline = read('js/config.js');
    const localPath = path.join(PUB, 'js/config.local.js');
    if (fs.existsSync(localPath)) {
      inline += '\n/* ---- config.local.js ---- */\n' + fs.readFileSync(localPath, 'utf8');
    }
    html = html.replace(tag, () => `<script>\n${inline}\n</script>`);
    continue;
  }

  if (name === 'app') {
    // app.js 之前插入直连所需的两块
    const KEY = (process.env.TMAP_KEY || '').trim();
    const pre = `<script>window.TMAP_DIRECT = true;`
      + `window.TMAP_KEY_DEFAULT = ${JSON.stringify(KEY)};</script>\n`
      + `<script>\n${read('js/tmap-norm.js')}\n</script>\n`
      + `<script>\n${read('js/tmap-direct.js')}\n</script>\n`;
    html = html.replace(tag, () => pre + `<script>\n${read(`js/${name}.js`)}\n</script>`);
  } else {
    html = html.replace(tag, () => `<script>\n${read(`js/${name}.js`)}\n</script>`);
  }
}

/* ---------- 4. 收尾检查 ---------- */
const left = html.match(/src="js\/[\w.]+\.js"/g) || html.match(/href="(css|vendor)\/[\w.]+"/g);
if (left) throw new Error('还有未内联的外链：' + left.join(', '));

const out = path.join(ROOT, 'travel-planner.html');
fs.writeFileSync(out, html, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('已生成 ' + out);
console.log('  大小 ' + kb(Buffer.byteLength(html)));
console.log('  含 Leaflet ' + (html.indexOf('leaflet-container') >= 0 ? '✓' : '✗'));
console.log('  含直连标记 ' + (html.indexOf('window.TMAP_DIRECT = true') >= 0 ? '✓' : '✗'));
console.log('  含解析模块 ' + (html.indexOf('root.TmapNorm = api') >= 0 ? '✓' : '✗'));
console.log('  含 JSONP 客户端 ' + (html.indexOf('global.DirectApi') >= 0 ? '✓' : '✗'));
