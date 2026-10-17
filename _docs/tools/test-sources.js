/**
 * 通用音源实测工具（隔离环境，不碰真实数据）
 *
 * 用法：
 *   electron _probe-dir.js --dir=_sources --songs=5 --qualities=320k,128k --profile=.probe-a --out=_report-a.json
 *
 *   --dir        被测音源目录（默认 _sources）
 *   --songs      测几首歌（默认全部）
 *   --songs-file 自定义歌曲 JSON：[{source,songmid,name,singer,albumName}]
 *   --qualities  测哪些音质，逗号分隔（默认 320k,128k）
 *   --profile    隔离用的 userData 目录（默认 .source-test-data）
 *   --out        结果 JSON（默认 _source-report.json）
 *   --bail       连续失败多少首就跳过该音源剩余测试（默认 0 = 不跳）
 *   --budget     单个音源最多测多少秒，超了就跳过（默认 90）—— 防死源把整轮拖垮
 *                （主进程对每次请求有 20 秒硬超时，一个全挂的源能吃掉好几分钟）
 *   --wipe       先清空该环境里已有的音源再导入。**必须加**，否则启动时自动导入的默认源
 *                会因「脚本内容重复」被拒（踩过：qdy 就是这么没测到的）
 *   --only=a.js,b.js  只测指定文件
 *   --rounds=N   整个目录重复测 N 轮（用来看音源稳定性，默认 1）
 *
 * 关键点（踩过的坑）：
 *   1. 一次性导入全部源再逐个启用 —— 边测边导入时，启动阶段已自动导入的源会因「内容重复」被拒
 *   2. HTTP 探测要跟随 301/302（最多 5 跳）—— 播放器会跟，不跟会把好地址误判成坏的
 *   3. 失败重试一次 —— 音源侧抖动很常见
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')

const argv = {}
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=?(.*)$/.exec(a)
  if (m) argv[m[1]] = m[2]
}
const DIR = argv.dir || '_sources'
const PROFILE = argv.profile || '.source-test-data'
const OUT_JSON = argv.out || '_source-report.json'
const QUALITIES = (argv.qualities || '320k,128k').split(',').map(s => s.trim()).filter(Boolean)
const BAIL = Number(argv.bail || 0)
const BUDGET = Number(argv.budget || 90)
const WIPE = argv.wipe != null
const ONLY = (argv.only || '').split(',').map(s => s.trim()).filter(Boolean)
const ROUNDS = Math.max(1, Number(argv.rounds || 1))
// --real：拿到地址后再用 <audio> 真播一下，看播放位置走不走（HTTP 206 ≠ 能解码）
const REAL = argv.real != null
const PLAY_WAIT = Number(argv['play-wait'] || 6000)

// 本脚本在 _docs/tools/ 下，项目根在两级之上；这样从任意 cwd 调用都能找到 dist/main.js
const ROOT = path.resolve(__dirname, '../..')
app.setPath('userData', path.join(ROOT, PROFILE))
require(path.join(ROOT, 'dist', 'main.js'))

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0'
const wait = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

const ALL_SONGS = [
  { source: 'kw', songmid: '440613', name: '稻香', singer: '周杰伦', albumName: '魔杰座' },
  { source: 'kw', songmid: '228908', name: '晴天', singer: '周杰伦', albumName: '叶惠美' },
  { source: 'kw', songmid: '93157', name: '江南', singer: '林俊杰', albumName: '第二天堂' },
  { source: 'kw', songmid: '317730', name: '富士山下', singer: '陈奕迅', albumName: "What's Going On...?" },
  { source: 'kw', songmid: '5886682', name: '海阔天空', singer: 'BEYOND', albumName: '乐与怒' },
]
// --songs-file=<json>：自定义歌曲列表（[{source,songmid,name,singer,albumName}]）
// 不传则用内置的 8 首；这两处都默认测全部，--songs=N 可截断
let SONGS_ALL = ALL_SONGS
if (argv['songs-file']) {
  SONGS_ALL = JSON.parse(fs.readFileSync(path.resolve(ROOT, argv['songs-file']), 'utf8'))
}
const SONGS = SONGS_ALL.slice(0, Math.max(1, Number(argv.songs || SONGS_ALL.length)))

const probeUrl = (url, hop = 0, seen = []) => new Promise(resolve => {
  if (!url) return resolve({ ok: false, why: '没返回地址' })
  if (!/^https?:\/\//i.test(url)) return resolve({ ok: false, why: '不是 http(s) 地址' })
  if (url.length > 2048) return resolve({ ok: false, why: '地址超长' })
  const mod = url.startsWith('https') ? https : http
  let done = false
  const finish = r => { if (!done) { done = true; resolve(r) } }
  let req
  try {
    req = mod.get(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-4095', Accept: '*/*' }, timeout: 12000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hop < 5) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        if (seen.includes(next)) return finish({ ok: false, why: '跳转成环', code: res.statusCode })
        return probeUrl(next, hop + 1, seen.concat(url)).then(finish)
      }
      const chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const head = buf.slice(0, 4).toString('hex')
        const isHtml = /^3c21444f|^3c68746d|^3c3f786d/i.test(head)
        finish({ ok: res.statusCode < 400 && buf.length > 0 && !isHtml, code: res.statusCode, hops: hop, bytes: buf.length, type: res.headers['content-type'] || '' })
      })
      res.on('error', e => finish({ ok: false, why: '流错误 ' + e.message }))
    })
  } catch (e) { return finish({ ok: false, why: '请求构造失败 ' + e.message }) }
  req.on('timeout', () => { req.destroy(); finish({ ok: false, why: 'HTTP 超时' }) })
  req.on('error', e => finish({ ok: false, why: 'HTTP 错误 ' + e.message }))
})

const PROBE = `window.__probe = {
  async wipe() {
    const l = await window.lxApp.lx.refreshList()
    if (l.length) await window.lxApp.lx.remove(l.map(a => a.id))
    const after = await window.lxApp.lx.refreshList()
    const lx = window.lxApp.lx
    lx.state = 'loading'; lx.current = null
    return after.length
  },
  async importFile(p) {
    const t = require('fs').readFileSync(p, 'utf8')
    try { const info = await window.lxApp.lx.import(t); return { ok: true, id: info.id, name: info.name, version: info.version } }
    catch (e) { return { ok: false, err: (e && e.message) || String(e) } }
  },
  reset() { const lx = window.lxApp.lx; lx.state = 'loading'; lx.current = null; return true },
  async enable(id) { await window.lxApp.lx.enable(id); return true },
  async waitReady(id, ms) {
    const lx = window.lxApp.lx
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (lx.state === 'ok' && lx.current && lx.current.id === id) {
        const srcs = lx.current.sources || {}
        const platforms = {}
        for (const k of Object.keys(srcs)) platforms[k] = (srcs[k] && srcs[k].qualitys) || []
        return { ok: true, ms: Date.now() - t0, platforms: Object.keys(srcs), qualitys: platforms }
      }
      if (lx.state === 'fail') return { ok: false, ms: Date.now() - t0, why: lx.message || '初始化失败' }
      await new Promise(r => setTimeout(r, 250))
    }
    return { ok: false, ms: Date.now() - t0, why: '等待超时' }
  },
  async getUrl(song, quality) {
    try { const u = await window.lxApp.lx.url(song, quality); return { url: u || null } }
    catch (e) { return { err: (e && e.message) || String(e) } }
  },
  // 用真实的 audio 元素解码播放，currentTime 走起来才算真能播
  async playUrl(url, ms) {
    const a = new Audio()
    a.volume = 0
    a.src = url
    let playErr = null
    try { await a.play() } catch (e) { playErr = e && e.name }
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      await new Promise(r => setTimeout(r, 300))
      if (a.currentTime > 1) break
    }
    const t = a.currentTime || 0
    const code = a.error ? a.error.code : null
    try { a.pause(); a.src = ''; a.load() } catch (e) {}
    return { ok: t > 1, t: Number(t.toFixed(2)), dur: Number((a.duration || 0).toFixed(2)), code, playErr }
  }
}; true`

const run = txt => win.webContents.executeJavaScript(txt, true)
let win

app.whenReady().then(async () => {
  await wait(3000)
  const wins = BrowserWindow.getAllWindows()
  win = wins.find(w => /index\.html/.test(w.webContents.getURL())) || wins[0]
  if (!win) { log('找不到主窗口'); app.exit(1); return }
  await run(PROBE)

  const dir = path.join(ROOT, DIR)
  let files = fs.readdirSync(dir).filter(f => /\.js$/.test(f) && !/示例|模板|template/i.test(f)).sort()
  if (ONLY.length) files = files.filter(f => ONLY.includes(f))
  log('')
  log('════ 被测目录 ' + DIR + '（' + files.length + ' 个源，' + ROUNDS + ' 轮）════')
  log('  歌曲 ' + SONGS.length + ' 首：' + SONGS.map(s => s.name).join('、') + '   音质: ' + QUALITIES.join(', '))
  log('')

  const results = []

  for (let round = 1; round <= ROUNDS; round++) {
  if (ROUNDS > 1) { log(''); log('████████ 第 ' + round + '/' + ROUNDS + ' 轮 ████████') }

  if (WIPE) {
    const left = await run('window.__probe.wipe()')
    log('──── 清空已有音源（剩 ' + left + ' 个）────')
  }
  log('──── 导入 ────')
  const imported = []
  for (const file of files) {
    const r = await run('window.__probe.importFile(' + JSON.stringify(path.join(dir, file)) + ')')
    if (r.ok) { imported.push({ file, id: r.id, name: r.name, version: r.version }); log('  ✓ ' + file.padEnd(22) + r.name) }
    else { imported.push({ file, id: null, err: r.err }); log('  ✗ ' + file.padEnd(22) + r.err) }
  }

  for (const it of imported) {
    log('')
    log('▶ ' + it.file + '   ' + (it.name || ''))
    const row = { round, file: it.file, name: it.name, version: it.version, inited: false, platforms: [], ok: {}, url: {}, http: {}, real: {} }
    if (!it.id) { row.initError = it.err; results.push(row); continue }

    await run('window.__probe.reset()')
    await run('window.__probe.enable(' + JSON.stringify(it.id) + ')')
    const ready = await run('window.__probe.waitReady(' + JSON.stringify(it.id) + ', 30000)')
    if (!ready.ok) { log('  ✗ 初始化失败: ' + ready.why); row.initError = ready.why; results.push(row); continue }
    row.inited = true
    row.platforms = ready.platforms || []
    row.qualitys = ready.qualitys || {}
    log('  ✓ 初始化成功(' + (ready.ms / 1000).toFixed(1) + 's)  平台: ' + row.platforms.join(',') + (row.qualitys.kw ? ('   酷我音质: ' + row.qualitys.kw.join('/')) : ''))

    for (const quality of QUALITIES) {
      let ok = 0, streak = 0
      const tStart = Date.now()
      for (const song of SONGS) {
        if (BAIL && streak >= BAIL) { log('    .. ' + quality + ' 连挂 ' + streak + ' 首，跳过剩余'); row.timedOut = true; break }
        if ((Date.now() - tStart) / 1000 > BUDGET) { log('    .. ' + quality + ' 超过 ' + BUDGET + 's 预算，跳过剩余'); row.timedOut = true; break }
        let r = await run('window.__probe.getUrl(' + JSON.stringify(song) + ',' + JSON.stringify(quality) + ')')
        if (!r.url) { await wait(800); r = await run('window.__probe.getUrl(' + JSON.stringify(song) + ',' + JSON.stringify(quality) + ')') }
        const p = await probeUrl(r.url)
        ;(row.url[quality] ||= {})[song.name] = r.url ? r.url.slice(0, 130) : null
        ;(row.http[quality] ||= {})[song.name] = r.url ? p : { ok: false, why: r.err || '没返回地址' }
        // 真播判定：HTTP 206 只说明能拉到字节，不代表解码器能播
        let real = null
        if (REAL && p.ok) {
          real = await run('window.__probe.playUrl(' + JSON.stringify(r.url) + ',' + PLAY_WAIT + ')')
          ;(row.real[quality] ||= {})[song.name] = real
        }
        const pass = p.ok && (!REAL || (real && real.ok))
        if (pass) { ok++; streak = 0 } else { streak++ }
        let detail
        if (p.ok) {
          detail = 'HTTP ' + p.code + (p.hops ? '(跳' + p.hops + ')' : '') + ' ' + p.bytes + 'B ' + p.type
          if (REAL && real) {
            detail += real.ok
              ? '  真播✓ ' + real.t + 's/' + real.dur + 's'
              : '  真播✗ code=' + (real.code == null ? '-' : real.code) + ' ' + (real.playErr || '')
          }
        } else if (r.err) {
          detail = r.err.slice(0, 66)
        } else {
          detail = JSON.stringify(p).slice(0, 86)
        }
        log('    ' + (p.ok ? '✓' : '✗') + ' ' + quality.padEnd(6) + song.name.padEnd(6) + detail)
      }
      row.ok[quality] = ok
    }
    results.push(row)
  }
  }  // ── rounds 结束 ──

  log('')
  log('════════════════════ 汇总 ════════════════════')
  log('  音源'.padEnd(24) + (ROUNDS > 1 ? '通过轮次'.padEnd(10) : '初始化'.padEnd(7)) + QUALITIES.map(q => q.padEnd(7)).join('') + '支持平台')
  log('  ' + '─'.repeat(88))
  const total = r => QUALITIES.reduce((s, q) => s + (r.ok[q] || 0), 0)
  const perQuality = QUALITIES.length * SONGS.length * ROUNDS
  const byFile = new Map()
  for (const r of results) {
    const k = r.file
    if (!byFile.has(k)) byFile.set(k, { ...r, rounds: 0, pass: 0, sum: 0, allOk: true })
    const g = byFile.get(k)
    g.rounds++
    g.sum += total(r)
    if (total(r) === QUALITIES.length * SONGS.length) g.pass++
    else g.allOk = false
    for (const q of QUALITIES) g.ok[q] = Math.max(g.ok[q] || 0, r.ok[q] || 0)
    if (!g.inited && r.inited) g.inited = true
  }
  const sorted = [...byFile.values()].sort((a, b) => b.sum - a.sum)
  for (const r of sorted) {
    const nm = (r.name || r.file).replace(/\s+/g, ' ').slice(0, 21)
    const col = ROUNDS > 1 ? ((r.pass + '/' + r.rounds + ' 轮全过').padEnd(10)) : (r.inited ? '✓' : '✗').padEnd(7)
    log('  ' + nm.padEnd(24) + col +
      QUALITIES.map(q => ((r.ok[q] != null ? r.ok[q] + '/' + SONGS.length : '-')).padEnd(7)).join('') +
      (r.platforms.join(',') || (r.initError || '-')).slice(0, 34))
  }
  log('')
  log('  明细 → ' + OUT_JSON)
  fs.writeFileSync(path.join(ROOT, OUT_JSON), JSON.stringify({ at: new Date().toISOString(), dir: DIR, songs: SONGS, qualities: QUALITIES, only: ONLY, rounds: ROUNDS, results }, null, 2), 'utf8')
  app.exit(0)
})
