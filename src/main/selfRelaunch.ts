/**
 * 自我重启：把被环境污染的进程换成干净的
 * ============================================================
 * 背景：本机全局设了 `ELECTRON_RUN_AS_NODE=1`，另外 WorkBuddy 会通过
 * `NODE_OPTIONS` 注入一个 node shim。开发期跑 `start.cmd` 时脚本会剔除它们，
 * 但**打包成 exe 之后双击启动，这两个变量会直接继承过来**，结果是：
 *
 *   - `ELECTRON_RUN_AS_NODE=1` → Electron 退化成纯 Node，窗口永远不出现
 *   - `NODE_OPTIONS` 里的 shim → 主进程里 `mkdirSync` 静默失效（数据库建不出来）
 *
 * 这两个变量在**进程启动的一瞬间就已生效**，程序内部改不了当前进程的形态，
 * 唯一的办法是：重新拉起一个干净环境下的自己，然后退出当前进程。
 *
 * 用 `LX_DESKTOP_RELAUNCHED` 做标记，保证只重启一次，不会来回循环。
 */

import { spawn } from 'child_process'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const RELAUNCH_FLAG = 'LX_DESKTOP_RELAUNCHED'

/**
 * 打包后没有控制台，出问题只能靠落盘日志查。
 * 注意这里用命名导入而非 `import fs from 'fs'` —— webpack 的 externals 下
 * default 导入可能取到 undefined，会让整个函数静默失效（踩过）。
 */
const LOG_FILE = join(tmpdir(), 'lx-desktop-relaunch.log')
const log = (msg: string) => {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch (_) { /* 写不进去就算了，别影响启动 */ }
}

// 探针：只记「被污染」或「刚刚重启过」这两种可疑情形，正常启动不写。
// 打包后没有控制台，出问题只能靠它定位。
if (process.env.ELECTRON_RUN_AS_NODE || process.env.NODE_OPTIONS || process.env[RELAUNCH_FLAG]) {
  log('模块已加载。ELECTRON_RUN_AS_NODE=' + JSON.stringify(process.env.ELECTRON_RUN_AS_NODE) +
    ' NODE_OPTIONS=' + JSON.stringify((process.env.NODE_OPTIONS ?? '').slice(0, 60)) +
    ' flag=' + JSON.stringify(process.env[RELAUNCH_FLAG]) +
    ' type=' + String(process.type) +
    ' argv=' + JSON.stringify(process.argv))
}

/** 当前进程是否被环境变量带坏了 */
const isPolluted = () => {
  if (process.env.ELECTRON_RUN_AS_NODE) return true
  const opts = process.env.NODE_OPTIONS ?? ''
  // 只认 WorkBuddy 的 node shim，别误伤正常的 NODE_OPTIONS 参数
  return /node-language-shim|app\.asar\.unpacked/i.test(opts)
}

if (isPolluted() && process.env[RELAUNCH_FLAG] !== '1') {
  log(`检测到污染环境，准备重启。execPath=${process.execPath} argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}`)
  const env: NodeJS.ProcessEnv = { ...process.env, [RELAUNCH_FLAG]: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  let child = null
  try {
    child = spawn(process.execPath, process.argv.slice(1), {
      env,
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    })
    if (child.pid) log(`已拉起干净进程 pid=${child.pid}`)
    child.on('error', (err) => log('子进程报错: ' + err.message))
    child.unref()
  } catch (err) {
    log('spawn 抛异常: ' + String(err))
  }

  // 不要立刻退出：Windows 上父进程走得比子进程站稳还快时，
  // 会把刚拉起的子进程一起带走（实测表现为「重启后一个进程都不剩」）。
  setTimeout(() => {
    log('父进程退出')
    process.exit(0)
  }, 2000)
}

