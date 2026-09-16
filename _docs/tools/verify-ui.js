/**
 * 界面回归验证工具
 * ============================================================
 * 用法（在项目根目录）：
 *
 *   node_modules/electron/dist/electron.exe _docs/tools/verify-ui.js
 *
 * 如果直接跑没反应（被环境变量带成 Node 模式），先清掉那两个变量：
 *
 *   set ELECTRON_RUN_AS_NODE= && set NODE_OPTIONS= && node_modules\electron\dist\electron.exe _docs\tools\verify-ui.js
 *
 * 它做的事：
 *   1. 加载真实主进程 dist/main.js（所以 IPC、音源沙箱都是真的）
 *   2. 用独立 userData 目录（.verify-data），不碰平时用的数据
 *   3. 在渲染层把控制条每个按钮点一遍，验证是否真有反应
 *   4. 播放一首并检查进度、时长、歌词、seek
 *   5. 截图存到 _docs/screenshots/
 *
 * 前提：先跑过 npm run build:renderer（需要 dist/index.html + dist/renderer.js）
 *
 * 改这个脚本时留意三个坑：
 *   - 合成的 element.click() 不算用户手势，Chromium 的自动播放策略会把 audio.play() 拒掉。
 *     所以 executeJavaScript 必须带第二个参数 userGesture=true。
 *   - BrowserWindow.getAllWindows() 的第一个不一定是主窗口：音源沙箱那个隐藏窗口
 *     可能排在前面。要按 URL 里有没有 index.html 来挑。
 *   - Electron 40+ 的 console-message 事件签名变成了对象（原来是一串位置参数），
 *     两种写法都要兼容，否则什么都打不出来。
 */

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..', '..')
const SHOT_DIR = path.join(ROOT, '_docs', 'screenshots')

// 独立数据目录：不干扰 %APPDATA%\lx-music-desktop，同时绕开单实例锁
app.setPath('userData', path.join(ROOT, '.verify-data'))

require(path.join(ROOT, 'dist', 'main.js'))

const wait = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))

const TEST = `(async () => {
  const q = s => document.querySelector(s)
  const qa = s => Array.from(document.querySelectorAll(s))
  const nap = ms => new Promise(r => setTimeout(r, ms))
  const R = {}
  const errs = []
  window.addEventListener('error', e => errs.push('error: ' + e.message))
  window.addEventListener('unhandledrejection', e => errs.push('reject: ' + (e.reason && e.reason.message)))

  R.lxAppType = typeof window.lxApp
  if (!window.lxApp) { R.fatal = 'lxApp 未挂载'; return R }
  const { S, P, lx, audio } = window.lxApp

  // ── 音源：先清掉历史，回到「全新安装」状态，再让 bootstrap 用默认源 ──
  // 否则上一轮验证装过的源会留着，导致每次测的源都不一样、结果不可比
  if (lx.list.length) {
    await lx.remove(lx.list.map(a => a.id))
    lx.state = 'idle'
    lx.current = null
    S.lastApiId = ''
    S.save()
    await nap(1200)
  }
  await lx.bootstrap()
  for (let i = 0; i < 30 && lx.state !== 'ok'; i++) await nap(500)
  R.apiState = lx.state
  R.apiName = lx.current ? lx.current.name : null
  R.apiListLen = lx.list.length

  // ── 设置面板 ──
  q('.topbar__home').click()
  await nap(400)
  R.panelOpen = !q('#lxPanel').hidden
  R.tabs = qa('.lxp__tabs button').map(b => b.textContent.trim())
  R.apiListItems = qa('#lxApiList .lxItem').length
  R.sourceDir = q('#lxDirTitle') ? q('#lxDirTitle').textContent : null
  R.dirFiles = qa('#lxDirList .lxItem .lxItem__name').map(x => x.textContent)
  qa('.lxp__tabs button')[1].click(); await nap(200)
  R.queueItems = qa('#lxQueueList .lxItem').length
  qa('.lxp__tabs button')[2].click(); await nap(200)
  R.qualitySegs = qa('#lxQualitySeg button').length
  R.modeSegs = qa('#lxModeSeg button').length
  qa('.lxp__tabs button')[3].click(); await nap(200)
  R.uiRanges = qa('#lxUiBlur, #lxUiBright, #lxUiOpacity').length
  q('.lxp__close').click(); await nap(300)
  R.panelClosed = q('#lxPanel').hidden

  // ── 控制条按钮 ──
  q('.btn[aria-label="单曲循环"]').click(); await nap(120)
  R.modeSingle = S.mode
  q('.btn[aria-label="随机播放"]').click(); await nap(120)
  R.modeRandom = S.mode
  q('.btn[aria-label="单曲循环"]').click(); await nap(120)

  const fav0 = S.favorites.length
  q('.btn[aria-label="收藏"]').click(); await nap(150)
  R.favDelta = S.favorites.length - fav0

  // 「添加」按钮 → 打开搜索加歌浮层
  R.topSearchBtn = !!q('#lxTopSearch')
  q('.btn[aria-label="添加"]').click()
  await nap(400)
  R.searchOpen = !q('#lxSearch').hidden
  const kw = q('#lxSearchKw')
  kw.value = '夜曲'
  kw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  for (let i = 0; i < 30; i++) {
    await nap(500)
    if (qa('#lxSearchRes2 .lxItem').length) break
  }
  R.searchResults = qa('#lxSearchRes2 .lxItem').length
  R.searchFirst = q('#lxSearchRes2 .lxItem__name') ? q('#lxSearchRes2 .lxItem__name').textContent : null
  R.searchFirstMeta = q('#lxSearchRes2 .lxItem__meta') ? q('#lxSearchRes2 .lxItem__meta').textContent : null
  const qn0 = S.queue.length
  const plusBtn = q('#lxSearchRes2 .lxItem [data-queue]')
  if (plusBtn) plusBtn.click()
  await nap(600)
  R.queueDeltaByPlus = S.queue.length - qn0
  const closeEl = q('#lxSearch [data-sclose]')
  if (closeEl) closeEl.click()
  await nap(300)
  R.searchClosed = q('#lxSearch').hidden

  q('.btn--std').click(); await nap(250)
  R.qualityPopup = !!q('.lxPop')
  q('.btn--std').click(); await nap(200)

  q('.btn[aria-label="睡眠定时"]').click(); await nap(250)
  R.sleepPopup = !!q('.lxPop')
  if (q('.lxPop')) q('.lxPop__item').click()
  await nap(150)

  const sp0 = S.space
  qa('.btn--text').find(b => b.textContent.trim() === '360').click(); await nap(300)
  R.spaceToggled = S.space !== sp0
  qa('.btn--text').find(b => b.textContent.trim() === '360').click(); await nap(200)

  q('.btn--han').click(); await nap(400)
  R.lyricPanelOpens = q('#lxLyric').classList.contains('is-on')
  q('.btn--han').click(); await nap(200)

  const t0 = q('.time').textContent
  q('.time').click(); await nap(200)
  R.timeModeToggles = q('.time').textContent !== t0
  q('.time').click(); await nap(150)

  q('.btn[aria-label="播放队列"]').click(); await nap(300)
  R.queuePanelOpens = !q('#lxPanel').hidden
  q('.lxp__close').click(); await nap(200)

  // ── 播放 ──
  S.index = 0
  S.save()
  const idx0 = S.index
  R.indexBeforePlay = S.index
  R.nameBeforePlay = P.current() ? P.current().name : null
  q('.pause').click()
  for (let i = 0; i < 30; i++) {
    await nap(500)
    if (isFinite(audio.duration) && audio.duration > 0 && audio.currentTime > 3) break
  }
  R.indexAfterPlay = S.index
  R.playing = !audio.paused
  R.currentTime = Number((audio.currentTime || 0).toFixed(2))
  R.duration = Number((audio.duration || 0).toFixed(2))
  R.progressWidth = q('.progress__fill').style.width
  R.timeText = q('.time').textContent
  R.song = P.current() ? P.current().name : null
  R.lyricLines = P.lyric.length

  q('.pause').click(); await nap(300)
  R.pausedAfterClick = audio.paused

  // 下一曲（等它真的播起来再往下测，否则 seek 会因为 duration 还没就绪而无效）
  q('.btn[aria-label="下一曲"]').click()
  for (let i = 0; i < 40; i++) {
    await nap(500)
    if (S.index !== idx0 && isFinite(audio.duration) && audio.duration > 0 &&
        !audio.paused && audio.currentTime > 1) break
  }
  R.nextSong = P.current() ? P.current().name : null
  R.nextPlaying = !audio.paused
  R.durationBeforeSeek = Number((audio.duration || 0).toFixed(2))

  // 进度条 seek 到 60%
  const bar = q('.progress')
  const r = bar.getBoundingClientRect()
  bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width * 0.6, bubbles: true, pointerId: 1 }))
  bar.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + r.width * 0.6, bubbles: true, pointerId: 1 }))
  await nap(800)
  R.seekOk = audio.currentTime > (audio.duration || 0) * 0.5
  R.progressAfterSeek = q('.progress__fill').style.width

  // ── 界面设置 ──
  window.lxApp.openPanel('ui')
  await nap(300)
  const blur = q('#lxUiBlur')
  blur.value = '8'
  blur.dispatchEvent(new Event('input', { bubbles: true }))
  await nap(200)
  R.blurApplied = q('#c').style.filter
  q('#lxUiReset').click(); await nap(200)
  R.blurAfterReset = q('#c').style.filter || '(空)'
  q('.lxp__close').click()

  // ── 在线音源：点第一个，验证能否真从社区仓库下载并导入 ──
  window.lxApp.openPanel('api')
  await nap(400)
  R.onlineCount = qa('#lxOnlineList .lxItem').length
  if (R.onlineCount) {
    const before = lx.list.length
    qa('#lxOnlineList .lxItem')[0].click()
    for (let i = 0; i < 60; i++) {
      await nap(500)
      if (lx.list.length > before) break
    }
    R.onlineImported = lx.list.length > before
    R.apiListAfterOnline = lx.list.length
    R.currentAfterOnline = lx.current ? lx.current.name : null
  }
  q('.lxp__close').click()

  audio.pause()
  R.errors = errs
  return R
})()`

app.whenReady().then(async () => {
  await wait(2500)

  const wins = BrowserWindow.getAllWindows()
  log('窗口数量: ' + wins.length)
  if (!wins.length) { app.exit(1); return }
  wins.forEach((w, i) => log('  [' + i + '] ' + w.getTitle() + '  visible=' + w.isVisible()))

  const win = wins.find(w => /index\.html/.test(w.webContents.getURL())) || wins[0]
  log('使用窗口: ' + win.getTitle())

  win.webContents.on('console-message', (...args) => {
    let msg = ''
    if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) msg = args[0].message
    else msg = String(args[2] || '')
    if (/Security Warning|electronjs\.org|Insecure|allowRunning|This warning|Policy set/.test(msg)) return
    log('[renderer] ' + msg)
  })

  try { win.show() } catch (e) { /* 忽略 */ }
  await wait(1200)

  // 清掉上次验证残留的状态，保证从默认队列第一首开始
  try {
    await win.webContents.executeJavaScript('localStorage.clear(); true')
    const loaded = new Promise(r => win.webContents.once('did-finish-load', r))
    win.webContents.reload()
    await loaded
    await wait(3000)
  } catch (e) {
    log('重置状态失败: ' + e.message)
  }

  log('')
  log('══ 开始 UI 验证 ══')
  let res
  try {
    res = await win.webContents.executeJavaScript(TEST, true)
  } catch (e) {
    log('执行测试脚本失败: ' + e.message)
    app.exit(1)
    return
  }

  log('')
  log('══ 结果 ══')
  log(JSON.stringify(res, null, 2))

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  try {
    await win.webContents.executeJavaScript("document.querySelector('.lxLyric').classList.add('is-on'); true")
    await wait(700)
    fs.writeFileSync(path.join(SHOT_DIR, 'shot-lyric.png'), (await win.webContents.capturePage()).toPNG())
    log('截图: _docs/screenshots/shot-lyric.png')
  } catch (e) { log('截图失败: ' + e.message) }

  try {
    await win.webContents.executeJavaScript("document.querySelector('.lxLyric').classList.remove('is-on'); window.lxApp.openPanel('api'); true")
    await wait(700)
    fs.writeFileSync(path.join(SHOT_DIR, 'shot-settings.png'), (await win.webContents.capturePage()).toPNG())
    log('截图: _docs/screenshots/shot-settings.png')
  } catch (e) { log('截图失败: ' + e.message) }

  // 截图 3：搜索加歌浮层（现场搜一次，让截图里有真实结果）
  try {
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#lxPanel').hidden = true
      window.lxApp.openSearch()
      await new Promise(r => setTimeout(r, 300))
      const kw = document.querySelector('#lxSearchKw')
      kw.value = '周杰伦'
      kw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`, true)
    await wait(3500)
    fs.writeFileSync(path.join(SHOT_DIR, 'shot-search.png'), (await win.webContents.capturePage()).toPNG())
    log('截图: _docs/screenshots/shot-search.png')
  } catch (e) { log('截图失败: ' + e.message) }

  app.exit(0)
})
