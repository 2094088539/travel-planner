/**
 * 后台启动器
 *
 * 用 Node 自己 fork 一个脱离父进程的服务：
 *   - detached：父进程退出后子进程继续跑
 *   - windowsHide：不开窗口
 *   - stdout/stderr 重定向到 logs/server.log，事后可查
 *
 * 为什么不用 .vbs：Windows 11 把 VBScript 列为高风险类型，
 * 双击必弹「未知发布者 / 来自 Internet 的文件」安全警告。
 *
 * 为什么用端口探测判断"已在运行"：Windows 上 process.kill(pid, 0) 不可靠，
 * 探测端口才是真的——端口能连上就说明服务活着。
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 8787);
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const PID_FILE = path.join(__dirname, '.server.pid');

function portAlive(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(600);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

(async () => {
  if (await portAlive(PORT)) {
    console.log(`服务已经在运行：http://127.0.0.1:${PORT}/`);
    console.log('不用重复启动。要重启就先双击 stop-background.bat。');
    process.exit(0);
  }

  // 端口空着，之前的 pid 文件是残留，清掉
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) { /* 忽略 */ }

  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }
  const out = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(out, `\n===== ${new Date().toLocaleString('zh-CN')} 启动 =====\n`);

  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'server.js'), '--port', String(PORT), '--no-open'],
    { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: __dirname }
  );
  child.unref();

  // 等它真的监听起来，别急着报成功
  let ok = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await portAlive(PORT)) { ok = true; break; }
  }

  if (ok) {
    console.log(`已在后台启动：http://127.0.0.1:${PORT}/`);
    console.log(`日志：${LOG_FILE}`);
    console.log('停止：双击 stop-background.bat');
    process.exit(0);
  } else {
    console.error('启动失败，看日志：' + LOG_FILE);
    process.exit(1);
  }
})();
