/**
 * 批量把音源的「最新版」拉到本地。
 *
 * 直连 raw.githubusercontent.com 时通时不通，所以内置镜像降级：直连 → ghproxy.net → gh-proxy.com → ghfast.top。
 *
 * 用法：
 *   node _docs/tools/fetch-sources.js            拉「常用清单」（下面 LIST 里的）
 *   node _docs/tools/fetch-sources.js --dry      只看能不能拉到，不写文件
 *
 * 想加源：往 LIST 里加一行 [本地文件名, 仓库 key, 仓库内路径]。
 * 仓库 key 见 REPOS；文件路径要写仓库里的真实路径（含目录）。
 * 怎么找路径：GitHub 网页上点进文件 → Raw → 地址里 repo/分支/ 后面那段就是；
 *             或者用 GitHub API 列整个仓库的文件树（见 _docs/04 文档第五节）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.join(ROOT, '_sources')
const DRY = process.argv.includes('--dry')

const REPOS = {
  pdone: ['pdone/lx-music-source', 'main'],
  guoyue: ['guoyue2010/lxmusic-', 'main'],
  wangshiyulin: ['wangshiyulin/LXmusic-source', 'main'],
  jiexiang: ['haonanren118/jiexiang-Music-Source', 'main'],
}

const MIRRORS = [
  u => u,
  u => 'https://ghproxy.net/' + u,
  u => 'https://gh-proxy.com/' + u,
  u => 'https://ghfast.top/' + u,
]

/** [本地文件名, 仓库 key, 仓库内路径] —— 默认源排第一 */
const LIST = [
  // 默认源（文件名含 default，新建配置时优先选它）
  ['default-changqing.js', 'pdone', 'changqing/latest.js'],
  // 实测全过
  ['juhe.js', 'pdone', 'juhe/latest.js'],
  ['lx.js', 'pdone', 'lx/latest.js'],
  ['qdy.js', 'pdone', 'qdy/latest.js'],
  ['flower.js', 'pdone', 'flower/latest.js'],
  ['grass.js', 'pdone', 'grass/latest.js'],
  // 跨仓库的（2026-09-16 实测全过）
  ['molan.js', 'guoyue', 'V260907/墨澜音乐源v2.3.0.js'],
  ['kxh.js', 'guoyue', 'V260817/推荐/K×H测试 v1.7.17.js'],
  ['jiexiang.js', 'jiexiang', '杰翔音乐源.js'],
  ['xinghai.js', 'wangshiyulin', 'xh/xinghai-music-sourcev2.3.13.js'],
  ['nianxin.js', 'guoyue', 'V260907/念心音源 v1.0.2.js'],
  ['stellarwave.js', 'guoyue', 'V260907/stellarwave-v3.2.0.js'],
  ['yuxi.js', 'guoyue', 'V260907/屿溪-终章.js'],
  ['yuningxi.js', 'guoyue', 'V260907/lx-玉宁熙V1.2.2.js'],
  ['hywmusic.js', 'guoyue', 'V260817/推荐/HYWmusic_beta_公益测试.js'],
  ['suyin.js', 'guoyue', 'V260907/溯音音源_v1.js'],
]

const get = url => new Promise(resolve => {
  const https = require('https')
  let req
  try {
    req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 25000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return get(new URL(res.headers.location, url).toString()).then(resolve)
      }
      const c = []
      res.on('data', d => c.push(d))
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(c) }))
    })
  } catch (e) { return resolve({ err: e.message }) }
  req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }) })
  req.on('error', e => resolve({ err: e.message }))
})

const readInfo = text => {
  const m = /^\/\*[\S\s]+?\*\//.exec(text)
  const out = {}
  if (!m) return out
  for (const line of m[0].split(/\r?\n/)) {
    const r = /^\s?\*\s?@(\w+)\s(.+)$/.exec(line)
    if (r) out[r[1]] = r[2].trim()
  }
  return out
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  console.log('目标目录: ' + OUT + (DRY ? '（--dry 只探测，不写文件）' : ''))
  console.log('')
  let ok = 0
  const bad = []
  for (const [name, repoKey, p] of LIST) {
    const [repo, branch] = REPOS[repoKey]
    const raw = 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + encodeURI(p)
    let got = null
    let via = ''
    for (const mk of MIRRORS) {
      const r = await get(mk(raw))
      if (r.status === 200 && r.buf && r.buf.length > 300) { got = r.buf; via = mk('').slice(0, 14) || '直连'; break }
    }
    if (!got) { console.log('  ✗ ' + name.padEnd(24) + p); bad.push(name); continue }
    const text = got.toString('utf8')
    const info = readInfo(text)
    const line = '  ✓ ' + name.padEnd(24) + (got.length / 1024).toFixed(1).padStart(6) + ' KB  ' +
      String(info.name || '（无 @name）').padEnd(24) + 'v' + String(info.version || '?').padEnd(12) + ' [' + (via || '直连') + ']'
    if (!DRY) fs.writeFileSync(path.join(OUT, name), got)
    console.log(line)
    ok++
    await new Promise(r => setTimeout(r, 250))
  }
  console.log('')
  console.log('成功 ' + ok + ' / ' + LIST.length + (bad.length ? '，失败: ' + bad.join(', ') : ''))
  if (!DRY) {
    console.log('')
    console.log('⚠ 拉下来的是「最新版」，可能和上次实测的不是同一个版本 —— 换完记得重测：')
    console.log('    node _docs/tools/test-sources.js')
  }
})()
