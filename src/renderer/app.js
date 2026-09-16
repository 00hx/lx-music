/* eslint-disable */
/*
 * 本文件是界面行为脚本，代码风格以「好读」为先（保留分号、逗号、中文注释排版），
 * 不套用项目 standard 风格的那批格式规则，故整体关闭 lint 检查。
 * 项目原有的 TS 源码不受影响，仍按 .eslintrc.cjs 检查。
 */
/**
 * LX Music · 界面逻辑层
 * ============================================================
 * 这是 renderer 的 webpack 入口。界面的 HTML/CSS 由 lizi 单文件提供，
 * 所有行为逻辑集中在这里。
 *
 * 四块职责：
 *   1. 音源对接   —— IPC 调主进程的自定义音源沙箱（导入 / 启用 / 取播放地址）
 *   2. 播放核心   —— <audio> + 播放队列 + 播放模式
 *                     （原本这套在 Vue 渲染层 src/renderer/core/player，随前端删除，这里重建）
 *   3. 控制条接管 —— 底部 15 个控件 + 进度条拖拽 + 键盘快捷键
 *   4. 设置面板   —— 右上角房子按钮：音源 / 队列 / 控制 / 界面 四页
 *
 * 前提：窗口是 contextIsolation:false + nodeIntegration:true，
 *      所以这里能直接 require('electron') 与操作 DOM，不需要 preload 桥。
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { ipcRenderer } = require('electron')

/**
 * 用 Node 的网络栈发 GET 请求。
 *
 * 为什么不用页面里的 fetch：酷我的接口（尤其移动端歌词接口）会校验 UA / Referer，
 * 而 Chromium 的 fetch 不允许脚本改 User-Agent 这个受限头；用 Electron 默认 UA 请求
 * 会拿到 {"data":null,"msg":"音乐查询失败"}。走 Node 栈自己带头最省心。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0'

function httpGet(url, referer, depth) {
  const d = depth || 0
  return new Promise((resolve, reject) => {
    if (d > 4) { reject(new Error('重定向次数过多')); return }
    let mod
    try {
      mod = url.startsWith('https') ? https : http
    } catch (e) { reject(e); return }
    const req = mod.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Referer: referer || '',
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        httpGet(res.headers.location, referer, d + 1).then(resolve, reject)
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error('HTTP ' + res.statusCode))
        return
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

/* ════════════════════════════════════════════════════════════
   一、常量
   ════════════════════════════════════════════════════════════ */

/** IPC 通道名，对应 src/common/ipcNames.ts 里 winMain_* 那一组 */
const CH = {
  importApi: 'winMain_import_user_api',
  removeApi: 'winMain_remove_user_api',
  setApi: 'winMain_set_user_api',
  getApiList: 'winMain_get_user_api_list',
  getApiStatus: 'winMain_get_user_api_status',
  requestApi: 'winMain_request_user_api',
  cancelApi: 'winMain_request_user_api_cancel',
  apiStatusEvent: 'winMain_user_api_status',
  selectDialog: 'winMain_show_select_dialog',
  fullscreen: 'winMain_fullscreen',
  getCacheSize: 'winMain_get_cache_size',
  clearCache: 'winMain_clear_cache',
  openDirInExplorer: 'winMain_open_dir_in_explorer',
}

/** 音质档位，键是音源契约里的取值 */
const QUALITYS = [
  { key: '128k', label: '标准' },
  { key: '320k', label: '较高' },
  { key: 'flac', label: '无损' },
  { key: 'flac24bit', label: 'Hi-Res' },
]

/** 音质按钮上显示的短标签 */
const QUALITY_SHORT = { '128k': 'STD', '320k': 'HQ', flac: 'SQ', flac24bit: 'HR' }

/** 播放模式 */
const MODES = {
  order: { label: '顺序播放', icon: 'list' },
  single: { label: '单曲循环', icon: 'single' },
  random: { label: '随机播放', icon: 'random' },
}

/** 默认播放队列。第一次启动时用，之后以本地状态为准 */
const DEFAULT_QUEUE = [
  { source: 'kw', songmid: '440613', name: '稻香', singer: '周杰伦', albumName: '魔杰座' },
  { source: 'kw', songmid: '228908', name: '晴天', singer: '周杰伦', albumName: '叶惠美' },
  { source: 'kw', songmid: '93157', name: '江南', singer: '林俊杰', albumName: '第二天堂' },
  { source: 'kw', songmid: '317730', name: '富士山下', singer: '陈奕迅', albumName: "What's Going On...?" },
  { source: 'kw', songmid: '443603', name: '突然好想你', singer: '五月天', albumName: '后青春期的诗' },
  { source: 'kw', songmid: '5886682', name: '海阔天空', singer: 'BEYOND', albumName: '乐与怒' },
  { source: 'kw', songmid: '206462064', name: '光年之外', singer: '邓紫棋', albumName: '光年之外' },
  { source: 'kw', songmid: '26445261', name: '起风了', singer: '买辣椒也用券', albumName: '起风了' },
]

/* ── 社区音源仓库 ──
   直连 raw.githubusercontent.com 在国内多数网络下不通，所以内置几个镜像，
   按顺序试，第一个通的就用。 */
const SOURCE_MIRRORS = [
  u => u,
  u => 'https://ghproxy.net/' + u,
  u => 'https://gh-proxy.com/' + u,
  u => 'https://ghfast.top/' + u,
]

/** 已知的社区音源仓库。默认仓库是 pdone，其余的要显式写 repo */
const SOURCE_REPOS = {
  pdone: ['pdone/lx-music-source', 'main'],
  guoyue: ['guoyue2010/lxmusic-', 'main'],
  wangshiyulin: ['wangshiyulin/LXmusic-source', 'main'],
  jiexiang: ['haonanren118/jiexiang-Music-Source', 'main'],
}

/**
 * 在线可拉取的音源清单。
 *   repo 缺省 = 'pdone'，此时 path 缺省为 `<id>/latest.js`（主仓库的目录约定）
 *   其他仓库要显式给 path（中文/空格会由 encodeURI 处理）
 *
 * hint 里的「实测」结论来自 2026-09-16 的批量实测（每源多轮 × 多首歌，且真去拉了音频字节），
 * 写清楚是为了免得用户点完才发现是坏的 —— 音源失效是常态，这份清单要定期复核。
 */
const ONLINE_SOURCES = [
  // ── 实测全过（推荐）──
  { id: 'changqing', label: '长青SVIP（推荐）', hint: '五平台 · 实测 3 轮全过' },
  { id: 'juhe', label: '聚合API (CF)', hint: '仅 1KB · 实测全过' },
  { id: 'lx', label: '独家音源', hint: '洛雪科技 · 实测全过 · 含本地文件' },
  { id: 'qdy', label: '全豆要聚合', hint: '聚合多链路 · 实测 4/5（个别歌没地址）' },
  { id: 'flower', label: '野花', hint: '五平台 · 只出 128k' },
  { id: 'grass', label: '野草', hint: '仅酷我 128k · 体积最小，应急用' },
  // ── 来自其他社区仓库（都是 2026-09-16 实测全过的）──
  { repo: 'guoyue', path: 'V260907/墨澜音乐源v2.3.0.js', label: '墨澜聚合', hint: '超聚合多链路 · 实测 2 轮全过' },
  { repo: 'guoyue', path: 'V260817/推荐/K×H测试 v1.7.17.js', label: 'K×H测试', hint: '实测 2 轮全过' },
  { repo: 'jiexiang', path: '杰翔音乐源.js', label: '杰翔聚合', hint: '实测 2 轮全过' },
  { repo: 'wangshiyulin', path: 'xh/xinghai-music-sourcev2.3.13.js', label: '星海音乐源', hint: '实测 2 轮全过' },
  { repo: 'guoyue', path: 'V260907/念心音源 v1.0.2.js', label: '念心音源', hint: '实测 2 轮全过' },
  { repo: 'guoyue', path: 'V260907/stellarwave-v3.2.0.js', label: '星澜聚合 (StellarWave)', hint: '实测 2 轮全过 · 支持 flac24bit' },
  { repo: 'guoyue', path: 'V260907/屿溪-终章.js', label: '屿溪-终章', hint: '实测 2 轮全过' },
  { repo: 'guoyue', path: 'V260907/lx-玉宁熙V1.2.2.js', label: 'lx-玉宁熙-Pro', hint: '实测 2 轮全过' },
  { repo: 'guoyue', path: 'V260817/推荐/HYWmusic_beta_公益测试.js', label: 'HYWmusic_beta', hint: '实测 2 轮全过' },
  { repo: 'guoyue', path: 'V260907/溯音音源_v1.js', label: '溯音音源', hint: '实测 2 轮全过' },
]

const STATE_KEY = 'lx-ui-state-v1'

/* ════════════════════════════════════════════════════════════
   二、小工具
   ════════════════════════════════════════════════════════════ */

const $ = (sel, root) => (root || document).querySelector(sel)
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel))

/** HTML 转义，往 innerHTML 里塞用户/网络数据前必须过一道 */
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 秒 → mm:ss */
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}

/** 歌曲在本地状态里的唯一键 */
function musicKey(song) {
  return song.source + ':' + song.songmid
}

/** 轻提示 */
let toastTimer = null
function toast(msg, ms) {
  let box = $('#lxToast')
  if (!box) {
    box = document.createElement('div')
    box.id = 'lxToast'
    document.body.appendChild(box)
  }
  box.textContent = msg
  box.classList.add('is-on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => box.classList.remove('is-on'), ms || 2200)
}

/* ════════════════════════════════════════════════════════════
   三、本地状态（localStorage 持久化）
   ════════════════════════════════════════════════════════════ */

const S = {
  queue: DEFAULT_QUEUE.slice(),
  index: 0,
  mode: 'order',
  quality: '320k',
  volume: 0.8,
  favorites: [],
  space: false,
  sleepEnd: 0,
  sleepMinutes: 0,
  lastApiId: '',
  ui: { blur: 0, brightness: 100, playerOpacity: 100, showTopbar: true, autoHideBar: true },

  load() {
    try {
      const raw = localStorage.getItem(STATE_KEY)
      if (!raw) return
      const o = JSON.parse(raw)
      if (Array.isArray(o.queue) && o.queue.length) this.queue = o.queue
      if (typeof o.index === 'number') this.index = o.index
      if (MODES[o.mode]) this.mode = o.mode
      if (QUALITY_SHORT[o.quality]) this.quality = o.quality
      if (typeof o.volume === 'number') this.volume = o.volume
      if (Array.isArray(o.favorites)) this.favorites = o.favorites
      if (typeof o.space === 'boolean') this.space = o.space
      if (typeof o.lastApiId === 'string') this.lastApiId = o.lastApiId
      if (o.ui) Object.assign(this.ui, o.ui)
    } catch (e) {
      console.warn('[lx] 读取本地状态失败，用默认值', e)
    }
  },

  save() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        queue: this.queue,
        index: this.index,
        mode: this.mode,
        quality: this.quality,
        volume: this.volume,
        favorites: this.favorites,
        space: this.space,
        lastApiId: this.lastApiId,
        ui: this.ui,
      }))
    } catch (e) {
      console.warn('[lx] 保存本地状态失败', e)
    }
  },
}

/* ════════════════════════════════════════════════════════════
   四、音源层
   ════════════════════════════════════════════════════════════ */

const lx = {
  list: [],
  current: null,
  state: 'idle', // idle | loading | ok | fail
  message: '',
  _waiters: [],

  /** 等音源就绪（最多等 timeout 毫秒），就绪后回调 */
  ready(timeout) {
    if (this.state === 'ok') return Promise.resolve(true)
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(false), timeout || 20000)
      this._waiters.push(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  },

  _notify() {
    this._waiters.splice(0).forEach(fn => fn())
  },

  /** 导入脚本原文，返回 apiInfo */
  async import(script) {
    const r = await ipcRenderer.invoke(CH.importApi, script)
    this.list = r.apiList || []
    return r.apiInfo
  },

  /** 启用某个源。已经是当前这个就不重复触发加载 */
  async enable(id) {
    if (this.state === 'ok' && this.current && this.current.id === id) return
    await ipcRenderer.invoke(CH.setApi, id)
    S.lastApiId = id
    S.save()
  },

  /** 删除源 */
  async remove(ids) {
    this.list = await ipcRenderer.invoke(CH.removeApi, ids)
    return this.list
  },

  async refreshList() {
    this.list = await ipcRenderer.invoke(CH.getApiList)
    return this.list
  },

  /**
   * 向当前音源要一个数据。
   * action: 'musicUrl'（在线平台只放行这一个）
   * 主进程侧有 20 秒硬超时。
   */
  async request(source, action, info) {
    const requestKey = 'r' + Math.random().toString(36).slice(2, 10)
    const res = await ipcRenderer.invoke(CH.requestApi, {
      requestKey,
      data: { source, action, info },
    })
    return res
  },

  /** 便捷方法：要播放地址 */
  async url(song, type) {
    const res = await this.request(song.source || 'kw', 'musicUrl', {
      type: type || S.quality,
      musicInfo: {
        id: musicKey(song),
        source: song.source || 'kw',
        name: song.name,
        singer: song.singer,
        songmid: song.songmid,
        albumName: song.albumName,
        meta: {
          songId: song.songmid,
          albumName: song.albumName,
        },
      },
    })
    return res && res.data ? res.data.url : null
  },

  /**
   * 保证界面能拿到一个可用音源。
   * 页面每次加载（含刷新）都要启用一次：主进程那边的音源在渲染层重载后会处于
   * 「未加载」状态，不启用的话请求会直接报 user api is not load。
   */
  async bootstrap() {
    this.state = 'loading'
    let list = []
    try {
      list = await this.refreshList()
    } catch (e) {
      console.warn('[lx] 读取音源列表失败', e)
    }

    const pick = list.find(a => a.id === S.lastApiId) || list[0]
    if (pick) {
      await this.enable(pick.id)
      return
    }

    // 一个源都没有 → 从音源目录导入默认脚本
    const { dir, files } = listSourceFiles()
    const target = pickDefaultSourceFile(files)
    if (!target) {
      this.state = 'fail'
      this.message = dir
        ? ('音源目录里没有可导入的脚本：' + dir)
        : '没找到音源目录（_sources / dist/static/sources）'
      return
    }
    try {
      const info = await importSourceFile(target.path)
      console.log('[lx] 已从 ' + target.path + ' 导入默认音源：' + info.name)
    } catch (e) {
      this.state = 'fail'
      this.message = e && e.message ? e.message : String(e)
    }
  },
}

// 主进程回传的源状态
ipcRenderer.on(CH.apiStatusEvent, (event, status) => {
  if (!status) return
  const name = status.apiInfo ? status.apiInfo.name : ''
  if (status.status) {
    lx.state = 'ok'
    lx.current = status.apiInfo || lx.current
    lx.message = '初始化成功'
    lx._notify()
  } else {
    lx.state = 'fail'
    lx.message = status.message || '初始化失败'
  }
  renderApiPage()
})

/* ════════════════════════════════════════════════════════════
   五、播放核心
   ════════════════════════════════════════════════════════════ */

const audio = new Audio()
audio.preload = 'auto'

const P = {
  lyric: [], // [{ time, text }]
  lyricIndex: -1,
  timeMode: 'total', // total | left
  _loading: false,

  current() {
    return S.queue[S.index] || null
  },

  /** 播放第 index 首 */
  async playIndex(i, autoplay) {
    if (!S.queue.length) {
      toast('播放队列是空的')
      return
    }
    S.index = ((i % S.queue.length) + S.queue.length) % S.queue.length
    S.save()
    const song = this.current()
    renderPlayingInfo()

    if (song.source !== 'local') {
      const ok = await lx.ready(15000)
      if (!ok) {
        setPlayingState(false)
        toast('音源还没就绪，稍等几秒再点')
        return
      }
    }

    let url = null
    if (song.source === 'local' && song.localPath) {
      // 本地文件不经过音源，直接读盘
      url = localFileUrl(song.localPath)
    } else {
      try {
        url = await lx.url(song, S.quality)
      } catch (e) {
        console.warn('[lx] 取地址失败', e)
      }
      if (!url && S.quality !== '128k') {
        // 高音质拿不到就退回标准音质再试一次
        const fallback = '128k'
        console.warn('[lx] ' + S.quality + ' 拿不到地址，回退 ' + fallback)
        try {
          url = await lx.url(song, fallback)
        } catch (e) { /* 忽略 */ }
        if (url) toast('该音源没有这个音质，已回退标准音质')
      }
    }

    if (!url) {
      setPlayingState(false)
      toast('这首歌拿不到播放地址，去房子按钮里换个音源试试')
      return
    }

    audio.src = url
    audio.volume = S.volume
    if (autoplay !== false) safePlay(1)

    if (song.source !== 'local') this.loadLyric(song)
    renderQueue()
  },

  /** 播放 / 暂停 */
  async toggle() {
    if (!audio.src) {
      await this.playIndex(S.index, true)
      return
    }
    if (audio.paused) {
      safePlay(1)
    } else {
      audio.pause()
    }
  },

  /** 下一首 */
  next(manual) {
    if (!S.queue.length) return
    if (S.mode === 'single' && !manual) {
      audio.currentTime = 0
      safePlay(1)
      return
    }
    if (S.mode === 'random' && S.queue.length > 1) {
      let n = S.index
      while (n === S.index) n = Math.floor(Math.random() * S.queue.length)
      this.playIndex(n, true)
      return
    }
    this.playIndex(S.index + 1, true)
  },

  /** 上一首 */
  prev() {
    if (!S.queue.length) return
    if (audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    if (S.mode === 'random' && S.queue.length > 1) {
      let n = S.index
      while (n === S.index) n = Math.floor(Math.random() * S.queue.length)
      this.playIndex(n, true)
      return
    }
    this.playIndex(S.index - 1, true)
  },

  /** 跳转到百分比位置 */
  seek(ratio) {
    if (!isFinite(audio.duration) || !audio.duration) return
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration
  },

  /**
   * 取歌词 + 封面。
   * 酷我这个接口是多节点、数据不一致：同一个 musicId 有时返回完整的 lrclist，
   * 有时返回 {"data":null,"msg":"音乐查询失败"}。所以重试几次，并给重试带上截然不同的
   * reqId 以尽量落到别的节点上。
   */
  async loadLyric(song) {
    this.lyric = []
    this.lyricIndex = -1
    renderLyric()
    if (!song || !song.songmid || song.source === 'local') return   // 本地文件没有在线歌词
    const base = 'https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=' +
      encodeURIComponent(song.songmid) + '&httpsStatus=1'
    for (let i = 0; i < 3; i++) {
      try {
        const url = i === 0 ? base : base + '&reqId=' + Math.random().toString(36).slice(2, 14)
        const txt = await httpGet(url, 'https://m.kuwo.cn/')
        const data = JSON.parse(txt.trim())
        const list = data && data.data && data.data.lrclist
        if (Array.isArray(list) && list.length) {
          this.lyric = list.map(x => ({ time: Number(x.time) || 0, text: String(x.lineLyric || '').trim() }))
          const pic = data.data.songinfo && data.data.songinfo.pic
          if (pic) {
            const cover = $('.cover')
            if (cover) {
              if (!cover.dataset.origin) cover.dataset.origin = cover.getAttribute('src')
              cover.src = pic
            }
          }
          renderLyric()
          return
        }
      } catch (e) {
        console.warn('[lx] 取歌词第 ' + (i + 1) + ' 次失败：' + (e && e.message))
      }
      await new Promise(r => setTimeout(r, 400))
    }
    console.warn('[lx] 这首歌暂时取不到歌词：' + song.name)
  },

  /** 定时器：到点暂停 */
  checkSleep() {
    if (!S.sleepEnd) return
    const left = S.sleepEnd - Date.now()
    if (left <= 0) {
      S.sleepEnd = 0
      S.sleepMinutes = 0
      S.save()
      audio.pause()
      toast('睡眠定时已到，已暂停播放')
    }
    renderTime()
  },
}

/* ── audio 事件 ── */
audio.addEventListener('timeupdate', () => {
  const ratio = isFinite(audio.duration) && audio.duration ? audio.currentTime / audio.duration : 0
  const fill = $('.progress__fill')
  if (fill) fill.style.width = (ratio * 100).toFixed(2) + '%'
  renderTime()
  syncLyricIndex()
})

audio.addEventListener('durationchange', renderTime)

/** 连续加载失败计数，用来保险丝式地避免整队列都废时无限跳歌 */
let badCount = 0
/** 冷却截止时间：连续失败到达上限后，短时间内不再自动跳歌，免得来回刷 */
let badCooldown = 0

audio.addEventListener('play', () => setPlayingState(true))
audio.addEventListener('pause', () => setPlayingState(false))
audio.addEventListener('ended', () => P.next(false))
audio.addEventListener('canplay', () => { badCount = 0 })

// 加载失败时也同步按钮状态；真正的“坏源”判定统一走 handleBadSource，
// 因为切歌时旧的加载会被中断并同样抛出 error，在事件里直接判定容易误伤。
audio.addEventListener('error', () => {
  if (!audio.src) return
  setPlayingState(false)
  if (audio.error && audio.error.code !== 1) handleBadSource()
})

/**
 * 当前地址不可用（音源给的链接失效 / 格式不支持）→ 先原地重取，再换歌。
 *
 * 判断不能急：
 *   1. 等一下再看，src 刚设上的瞬间偶发 NotSupportedError，资源其实马上就绪；
 *   2. 只认硬指标 —— audio.error 必须真的存在，否则说明是瞬时抖动；
 *   3. readyState 到了 HAVE_CURRENT_DATA 就说明能播。
 *
 * 为什么先重取而不是直接换歌：聚合音源内部有多条链路，同一次请求可能给好地址也可能
 * 给坏地址，所以重取一次命中率很高。用户点了《稻香》就该听到《稻香》，而不是被莫名
 * 换到别的歌。（踩过：只等 1.3 秒且不看 audio.error，首次播放被误判成坏源连跳两首。）
 */
function handleBadSource() {
  const srcAtFail = audio.src
  setPlayingState(false)
  setTimeout(() => {
    if (audio.src !== srcAtFail) return            // 期间已经换歌了
    const err = audio.error
    if (!err) return                               // 没有真实错误 → 刚才只是抖动
    if (err.code === 1) return                     // MEDIA_ERR_ABORTED：主动中断，不算故障
    if (audio.readyState >= 2) return              // 已经能播了

    badCount++
    const song = P.current()
    console.warn('[lx] 音频地址不可用（MediaError code=' + err.code + '），第 ' + badCount + ' 次')

    if (Date.now() < badCooldown) {
      toast('这首放不出来，手动换一首吧')
      return
    }

    // 第一次：原地重取地址，尽量把用户点的这首放出来
    if (badCount === 1 && song) {
      toast('地址失效，重新获取…')
      P.playIndex(S.index, true)
      return
    }

    // 仍然不行：自动换下一首（带保险丝，避免整队列都废时无限跳）
    if (badCount <= 3 && S.queue.length > 1) {
      toast('这首实在放不出来，自动换下一首')
      setTimeout(() => P.next(true), 300)
    } else {
      badCount = 0
      badCooldown = Date.now() + 30000
      toast('连续几首都播不了，到房子按钮里换个音源试试')
    }
  }, 2500)
}

function setPlayingState(isPlaying) {
  const btn = $('.pause')
  if (!btn) return
  btn.classList.toggle('is-play', !isPlaying)
  btn.setAttribute('aria-label', isPlaying ? '暂停' : '播放')
}

/**
 * 播放音频，被自动播放策略拦下时重试一次。
 * 正常使用中播放由点击触发，不会走到重试分支；重试是为了兜住切歌等无手势场景。
 */
function safePlay(retry) {
  audio.play().catch(err => {
    const name = err && err.name
    if (name === 'NotSupportedError') { handleBadSource(); return }
    if (name === 'AbortError') return
    console.warn('[lx] 播放被拒：' + name + ' ' + (err && err.message))
    if (retry > 0) {
      setTimeout(() => safePlay(retry - 1), 400)
      return
    }
    setPlayingState(false)
    toast('系统拦了自动播放，再点一下播放键')
  })
}

function syncLyricIndex() {
  if (!P.lyric.length) return
  const t = audio.currentTime
  let idx = -1
  for (let i = 0; i < P.lyric.length; i++) {
    if (P.lyric[i].time <= t + 0.2) idx = i
    else break
  }
  if (idx !== P.lyricIndex) {
    P.lyricIndex = idx
    renderLyric()
  }
}

/* ════════════════════════════════════════════════════════════
   六、样式注入
   ════════════════════════════════════════════════════════════ */

const CSS = `
/* ── 播放/暂停按钮：暂停态把两条竖线换成三角 ── */
.pause.is-play i{ width:0; height:0; background:transparent; border:0;
  border-left:20px solid var(--fg-strong);
  border-top:12px solid transparent; border-bottom:12px solid transparent;
  margin-left:6px; }
.pause.is-play i + i{ display:none; }

/* ── 进度条可点/可拖 ── */
.progress{ cursor:pointer; position:relative; }
.progress:hover .progress__fill{ background:#a8f3ef; }
.progress__fill{ transition: width .08s linear; }

/* ── 控制条与顶栏始终浮在最上层（歌词面板滑出时也不该盖住它们）── */
.player, .topbar{ z-index: 75; }

/* ── 控制条自动隐藏 ──
   默认沉到屏幕外，鼠标进到底部热区再滑上来。
   隐藏只用 transform，**不动 opacity** —— 那个被「控制条不透明度」设置占着
   （applyUiSettings 直接写 .player 的 inline style，两处都用 opacity 会打架）。
   出场用 ease-out（冲上来再缓停），收回用 ease-in（起步慢、越走越快）—— 这是「顺」的关键。
   注意隐藏时要带上 translateX(-50%)：这个条子本来就靠它水平居中。 */
.player{
  transition: transform .46s cubic-bezier(.16,.86,.26,1);
}
.player.is-away{
  transition: transform .3s cubic-bezier(.5,.03,.74,.4);
  transform: translateX(-50%) translateY(calc(100% + var(--capsule-bottom, 24px) + 18px));
  pointer-events: none;
}

/* ── 顶栏可拖窗口（按钮除外）── */
.topbar{ -webkit-app-region: drag; }
.topbar button, .topbar__user{ -webkit-app-region: no-drag; }
.topbar.is-hidden{ display:none; }

/* ── 轻提示 ── */
#lxToast{
  position:fixed; left:50%; top:34px; transform:translate(-50%,-14px);
  z-index:90; pointer-events:none;
  padding:10px 20px; border-radius:999px;
  background:rgba(20,20,28,.78); color:#fff;
  border:1px solid rgba(255,255,255,.14);
  -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px);
  font:13px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  opacity:0; transition:opacity .22s ease, transform .22s ease;
  box-shadow:0 10px 30px rgba(0,0,0,.45);
  max-width:70vw; text-align:center;
}
#lxToast.is-on{ opacity:1; transform:translate(-50%,0); }

/* ── 弹出小菜单（音质等）/ 音量浮层 ── */
.lxPop{
  position:fixed; z-index:80;
  min-width:132px; padding:6px;
  border-radius:14px;
  background:rgba(22,22,30,.86);
  -webkit-backdrop-filter:blur(18px) saturate(140%);
          backdrop-filter:blur(18px) saturate(140%);
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 16px 44px rgba(0,0,0,.5);
  font:13px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  color:var(--fg);
  animation:lxPopIn .16s ease;
}
@keyframes lxPopIn{ from{ opacity:0; transform:translateY(6px) } to{ opacity:1; transform:none } }
.lxPop__item{
  display:flex; align-items:center; justify-content:space-between; gap:14px;
  padding:9px 12px; border-radius:9px; cursor:pointer; white-space:nowrap;
}
.lxPop__item:hover{ background:rgba(255,255,255,.09); }
.lxPop__item.is-on{ color:var(--track-fill); }
.lxPop__item small{ color:rgba(255,255,255,.42); font-size:11px; }

/* 音量浮层（里面是一根滑块，所以比普通菜单宽一点） */
.lxPop--vol{ display:flex; align-items:center; gap:11px; min-width:0; padding:10px 12px; }
.lxPop--vol .lxRange{ width:126px; }
.lxPop--vol > span{ width:40px; text-align:right; font-size:12px; color:rgba(255,255,255,.62);
  font-variant-numeric:tabular-nums; }
.lxPop__mute{ flex:none; width:26px; height:26px; padding:0; border:0; border-radius:8px; cursor:pointer;
  background:transparent; color:rgba(255,255,255,.66); display:grid; place-items:center; }
.lxPop__mute:hover{ background:rgba(255,255,255,.1); color:#fff; }
.lxPop__mute svg{ width:17px; height:17px; }

/* 控制条喇叭按钮：静音时收掉声波、显示叉 */
.btn--vol .vol-wave, .btn--vol .vol-x{ transition:opacity .14s ease; }
.btn--vol .vol-x{ opacity:0; }
.btn--vol.is-mute .vol-x{ opacity:1; }
.btn--vol.is-mute .vol-wave{ opacity:0; }

/* ── 设置面板 ── */
.lxp{ position:fixed; inset:0; z-index:85; display:flex; align-items:center; justify-content:center;
  font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; color:var(--fg); }
.lxp[hidden]{ display:none; }
.lxp__mask{ position:absolute; inset:0; background:rgba(0,0,0,.42);
  -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); }
.lxp__box{
  position:relative; width:min(760px,92vw); height:min(560px,84vh);
  display:flex; flex-direction:column;
  border-radius:20px; overflow:hidden;
  background:rgba(18,18,26,.78);
  -webkit-backdrop-filter:blur(26px) saturate(150%);
          backdrop-filter:blur(26px) saturate(150%);
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 30px 80px rgba(0,0,0,.6);
  animation:lxpIn .2s ease;
}
@keyframes lxpIn{ from{ opacity:0; transform:scale(.97) } to{ opacity:1; transform:none } }
.lxp__head{
  display:flex; align-items:center; gap:18px;
  padding:16px 20px 12px; border-bottom:1px solid rgba(255,255,255,.08);
  -webkit-app-region:drag;
}
.lxp__title{ font-size:14px; color:#fff; letter-spacing:.5px; }
.lxp__tabs{ display:flex; gap:4px; margin-left:8px; -webkit-app-region:no-drag; }
.lxp__tabs button{
  padding:7px 14px; border:0; border-radius:9px; cursor:pointer;
  background:transparent; color:rgba(255,255,255,.6); font-size:13px;
  transition:background .16s ease, color .16s ease;
}
.lxp__tabs button:hover{ background:rgba(255,255,255,.07); color:#fff; }
.lxp__tabs button.is-on{ background:rgba(255,255,255,.13); color:#fff; }
.lxp__close{
  margin-left:auto; width:30px; height:30px; border-radius:50%;
  border:0; cursor:pointer; background:rgba(255,255,255,.08); color:var(--fg);
  font-size:14px; -webkit-app-region:no-drag;
}
.lxp__close:hover{ background:rgba(255,255,255,.16); color:#fff; }
.lxp__body{ flex:1; overflow-y:auto; padding:18px 20px 24px; }
.lxp__body::-webkit-scrollbar{ width:8px; }
.lxp__body::-webkit-scrollbar-thumb{ background:rgba(255,255,255,.16); border-radius:4px; }
.lxp__page{ display:none; }
.lxp__page.is-on{ display:block; }

.lxp__sub{ margin:20px 0 10px; font-size:12px; color:rgba(255,255,255,.45); letter-spacing:.6px; }
.lxp__sub:first-child{ margin-top:0; }

/* 行 / 按钮 */
.lxRow{ display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:11px 14px; border-radius:12px; background:rgba(255,255,255,.045); margin-bottom:8px; }
.lxRow--col{ flex-direction:column; align-items:stretch; gap:10px; }
.lxRow__label{ color:#fff; }
.lxRow__hint{ color:rgba(255,255,255,.42); font-size:12px; margin-top:3px; }
.lxBtn{
  padding:8px 14px; border-radius:9px; cursor:pointer; font-size:12.5px;
  background:rgba(255,255,255,.09); color:var(--fg);
  border:1px solid rgba(255,255,255,.12);
  transition:background .16s ease, color .16s ease;
}
.lxBtn:hover{ background:rgba(255,255,255,.17); color:#fff; }
.lxBtn--main{ background:rgba(135,226,221,.16); color:var(--track-fill); border-color:rgba(135,226,221,.32); }
.lxBtn--main:hover{ background:rgba(135,226,221,.26); color:#d6fffb; }
.lxBtn--danger:hover{ background:rgba(255,110,110,.18); color:#ffb3b3; }
.lxBtns{ display:flex; gap:8px; flex-wrap:wrap; }
.lxInput{
  flex:1; min-width:0; padding:9px 12px; border-radius:9px; font-size:13px;
  background:rgba(255,255,255,.06); color:#fff;
  border:1px solid rgba(255,255,255,.12); outline:none;
}
.lxInput::placeholder{ color:rgba(255,255,255,.32); }
.lxInput:focus{ border-color:rgba(135,226,221,.45); }

/* 徽标 */
.lxBadge{ padding:4px 10px; border-radius:999px; font-size:11.5px;
  background:rgba(255,255,255,.1); color:rgba(255,255,255,.7); }
.lxBadge--ok{ background:rgba(135,226,221,.16); color:var(--track-fill); }
.lxBadge--fail{ background:rgba(255,110,110,.16); color:#ffb3b3; }
.lxBadge--wait{ background:rgba(255,205,110,.14); color:#ffd98a; }

/* 列表 */
.lxList{ display:flex; flex-direction:column; gap:4px; }
.lxItem{
  display:flex; align-items:center; gap:12px;
  padding:9px 12px; border-radius:10px; cursor:pointer;
  transition:background .14s ease;
}
.lxItem:hover{ background:rgba(255,255,255,.07); }
.lxItem.is-on{ background:rgba(135,226,221,.12); }
.lxItem.is-on .lxItem__name{ color:var(--track-fill); }
.lxItem__idx{ width:20px; text-align:right; color:rgba(255,255,255,.32); font-size:12px; flex:0 0 auto; }
.lxItem__main{ flex:1; min-width:0; }
.lxItem__name{ color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lxItem__meta{ color:rgba(255,255,255,.4); font-size:11.5px; margin-top:2px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lxItem__act{ flex:0 0 auto; opacity:0; transition:opacity .14s ease; }
.lxItem:hover .lxItem__act{ opacity:1; }
.lxItem__act button{
  width:26px; height:26px; border-radius:50%; border:0; cursor:pointer;
  background:rgba(255,255,255,.1); color:var(--fg); font-size:13px;
}
.lxItem__act button:hover{ background:rgba(255,110,110,.24); color:#ffb3b3; }
.lxEmpty{ padding:14px; color:rgba(255,255,255,.3); font-size:12.5px; text-align:center; }

/* 滑块 */
.lxRange{ -webkit-appearance:none; width:100%; height:3px; border-radius:99px;
  background:rgba(255,255,255,.2); outline:none; }
.lxRange::-webkit-slider-thumb{ -webkit-appearance:none; width:14px; height:14px;
  border-radius:50%; background:var(--track-fill); cursor:pointer;
  box-shadow:0 0 10px rgba(135,226,221,.7); }
.lxRangeRow{ display:flex; align-items:center; gap:14px; }
.lxRangeRow .lxRange{ flex:1; }
.lxRangeRow span{ width:52px; text-align:right; font-size:12px; color:rgba(255,255,255,.55);
  font-variant-numeric:tabular-nums; }

/* 分段选择 */
.lxSeg{ display:flex; gap:6px; flex-wrap:wrap; }
.lxSeg button{ padding:7px 14px; border-radius:9px; cursor:pointer; font-size:12.5px;
  background:rgba(255,255,255,.07); color:rgba(255,255,255,.62);
  border:1px solid transparent; }
.lxSeg button:hover{ background:rgba(255,255,255,.13); color:#fff; }
.lxSeg button.is-on{ background:rgba(135,226,221,.16); color:var(--track-fill);
  border-color:rgba(135,226,221,.34); }

/* 开关 */
.lxSwitch{ width:44px; height:24px; border-radius:99px; cursor:pointer; position:relative;
  background:rgba(255,255,255,.14); transition:background .18s ease; border:0; flex:0 0 auto; }
.lxSwitch::after{ content:''; position:absolute; top:3px; left:3px; width:18px; height:18px;
  border-radius:50%; background:#fff; transition:transform .18s ease; }
.lxSwitch.is-on{ background:rgba(135,226,221,.5); }
.lxSwitch.is-on::after{ transform:translateX(20px); }

/* 歌词面板 */
.lxLyric{
  position:fixed; top:0; right:0; bottom:0; width:min(420px,42vw);
  z-index:70; padding:90px 34px 140px; box-sizing:border-box;
  overflow-y:auto; text-align:center;
  background:linear-gradient(90deg, rgba(12,12,18,0) 0%, rgba(12,12,18,.72) 32%, rgba(12,12,18,.86) 100%);
  -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px);
  color:rgba(255,255,255,.42);
  font:15px/2.1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  transform:translateX(100%); opacity:0; pointer-events:none;
  transition:transform .28s ease, opacity .28s ease;
}
.lxLyric.is-on{ transform:none; opacity:1; pointer-events:auto; }
.lxLyric::-webkit-scrollbar{ width:6px; }
.lxLyric::-webkit-scrollbar-thumb{ background:rgba(255,255,255,.14); border-radius:3px; }
.lxLyric p{ margin:0 0 6px; cursor:pointer; transition:color .2s ease, transform .2s ease; }
.lxLyric p:hover{ color:rgba(255,255,255,.8); }
.lxLyric p.is-on{ color:#fff; font-size:17.5px; text-shadow:0 0 18px rgba(135,226,221,.55); }
.lxLyric__empty{ color:rgba(255,255,255,.3); }

/* ── 搜索加歌浮层 ── */
.lxSearch{
  position:fixed; inset:0; z-index:88;
  display:flex; align-items:flex-start; justify-content:center;
  padding-top:11vh;
  font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; color:var(--fg);
}
.lxSearch[hidden]{ display:none; }
.lxSearch__mask{ position:absolute; inset:0; background:rgba(0,0,0,.45);
  -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); }
.lxSearch__box{
  position:relative; width:min(640px,92vw); max-height:72vh;
  display:flex; flex-direction:column;
  border-radius:18px; overflow:hidden;
  background:rgba(18,18,26,.84);
  -webkit-backdrop-filter:blur(26px) saturate(150%);
          backdrop-filter:blur(26px) saturate(150%);
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 30px 80px rgba(0,0,0,.6);
  animation:lxpIn .18s ease;
}
.lxSearch__head{
  display:flex; align-items:center; gap:10px;
  padding:14px 16px; border-bottom:1px solid rgba(255,255,255,.08);
  -webkit-app-region:drag;
}
.lxSearch__input{
  flex:1; padding:11px 14px; border-radius:10px; font-size:14px;
  background:rgba(255,255,255,.07); color:#fff;
  border:1px solid rgba(255,255,255,.12); outline:none;
  -webkit-app-region:no-drag;
}
.lxSearch__input::placeholder{ color:rgba(255,255,255,.32); }
.lxSearch__input:focus{ border-color:rgba(135,226,221,.5); }
.lxSearch__close{
  width:30px; height:30px; border-radius:50%; border:0; cursor:pointer;
  background:rgba(255,255,255,.08); color:var(--fg); font-size:14px;
  -webkit-app-region:no-drag;
}
.lxSearch__close:hover{ background:rgba(255,255,255,.16); color:#fff; }
.lxSearch__body{ flex:1; overflow-y:auto; padding:10px 12px; min-height:190px; }
.lxSearch__body::-webkit-scrollbar{ width:8px; }
.lxSearch__body::-webkit-scrollbar-thumb{ background:rgba(255,255,255,.16); border-radius:4px; }
.lxSearch__foot{
  display:flex; align-items:center; gap:12px;
  padding:12px 16px; border-top:1px solid rgba(255,255,255,.08);
}
.lxSearch__tip{ color:rgba(255,255,255,.38); font-size:12px; }
/* 搜索结果行里的按钮要常显（不然发现不了） */
.lxItem__act.is-always{ opacity:1; display:flex; gap:6px; }
.lxItem__act.is-always button{ font-size:12px; }
.lxItem__act.is-always button:hover{ background:rgba(135,226,221,.22); color:var(--track-fill); }
.lxItem[data-song]{ cursor:pointer; }
`

function injectStyle() {
  const st = document.createElement('style')
  st.id = 'lxStyle'
  st.textContent = CSS
  document.head.appendChild(st)
}

/* ════════════════════════════════════════════════════════════
   七、面板 DOM
   ════════════════════════════════════════════════════════════ */

const PANEL_HTML = `
<div class="lxp" id="lxPanel" hidden>
  <div class="lxp__mask" data-close="1"></div>
  <div class="lxp__box">
    <div class="lxp__head">
      <span class="lxp__title">设置</span>
      <div class="lxp__tabs">
        <button data-tab="api" class="is-on">音源</button>
        <button data-tab="queue">队列</button>
        <button data-tab="play">控制</button>
        <button data-tab="ui">界面</button>
      </div>
      <button class="lxp__close" data-close="1">✕</button>
    </div>
    <div class="lxp__body">

      <!-- ── 音源 ── -->
      <div class="lxp__page is-on" data-page="api">
        <div class="lxRow">
          <div>
            <div class="lxRow__label">当前音源</div>
            <div class="lxRow__hint" id="lxApiName">—</div>
          </div>
          <span class="lxBadge" id="lxApiState">未载入</span>
        </div>
        <div class="lxBtns" style="margin:10px 0 4px">
          <button class="lxBtn lxBtn--main" id="lxImportFile">选择文件导入</button>
          <button class="lxBtn" id="lxImportUrl">从链接导入</button>
          <button class="lxBtn" id="lxOpenDir">打开音源目录</button>
        </div>
        <div class="lxRow lxRow--col" id="lxUrlRow" style="display:none">
          <input class="lxInput" id="lxUrlInput" placeholder="粘贴音源脚本的 http(s) 链接">
          <div class="lxBtns">
            <button class="lxBtn lxBtn--main" id="lxUrlGo">导入</button>
            <button class="lxBtn" id="lxUrlCancel">取消</button>
          </div>
        </div>
        <div class="lxp__sub">已安装的音源（点击切换启用）</div>
        <div class="lxList" id="lxApiList"></div>
        <div class="lxp__sub" id="lxDirTitle">音源目录</div>
        <div class="lxList" id="lxDirList"></div>
        <div class="lxp__sub">在线音源 · 点一下就下载并导入（社区仓库，自动走镜像；已装过的再点就是更新）</div>
        <div class="lxList" id="lxOnlineList"></div>
      </div>

      <!-- ── 队列 ── -->
      <div class="lxp__page" data-page="queue">
        <div class="lxRow">
          <input class="lxInput" id="lxSearchInput" placeholder="搜索歌曲（酷我）">
          <button class="lxBtn lxBtn--main" id="lxSearchGo">搜索</button>
        </div>
        <div class="lxList" id="lxSearchRes"></div>
        <div class="lxp__sub">播放队列（<span id="lxQueueCount">0</span> 首）</div>
        <div class="lxList" id="lxQueueList"></div>
        <div class="lxp__sub">我的收藏</div>
        <div class="lxList" id="lxFavList"></div>
      </div>

      <!-- ── 控制 ── -->
      <div class="lxp__page" data-page="play">
        <div class="lxRow">
          <span class="lxRow__label">音量</span>
          <div class="lxRangeRow" style="flex:1;max-width:280px">
            <input class="lxRange" id="lxVolume" type="range" min="0" max="100">
            <span id="lxVolumeText">80%</span>
          </div>
        </div>
        <div class="lxRow">
          <div>
            <div class="lxRow__label">音质</div>
            <div class="lxRow__hint">音源不支持时会自动回退到标准音质</div>
          </div>
          <div class="lxSeg" id="lxQualitySeg"></div>
        </div>
        <div class="lxRow">
          <div>
            <div class="lxRow__label">播放模式</div>
            <div class="lxRow__hint">也可以直接点控制条上的按钮切换</div>
          </div>
          <div class="lxSeg" id="lxModeSeg"></div>
        </div>
        <div class="lxRow">
          <div>
            <div class="lxRow__label">空间音频</div>
            <div class="lxRow__hint">开启后声音更宽、低频更足</div>
          </div>
          <button class="lxSwitch" id="lxSpace"></button>
        </div>
        <div class="lxRow">
          <span class="lxRow__label">睡眠定时</span>
          <div class="lxSeg" id="lxSleepSeg"></div>
        </div>
        <div class="lxp__sub">应用信息</div>
        <div class="lxRow">
          <span class="lxRow__label">缓存占用</span>
          <div class="lxBtns">
            <span class="lxBadge" id="lxCacheSize">—</span>
            <button class="lxBtn lxBtn--danger" id="lxClearCache">清除缓存</button>
          </div>
        </div>
      </div>

      <!-- ── 界面 ── -->
      <div class="lxp__page" data-page="ui">
        <div class="lxRow">
          <span class="lxRow__label">背景模糊</span>
          <div class="lxRangeRow" style="flex:1;max-width:280px">
            <input class="lxRange" id="lxUiBlur" type="range" min="0" max="14">
            <span id="lxUiBlurText">0px</span>
          </div>
        </div>
        <div class="lxRow">
          <span class="lxRow__label">背景亮度</span>
          <div class="lxRangeRow" style="flex:1;max-width:280px">
            <input class="lxRange" id="lxUiBright" type="range" min="30" max="130">
            <span id="lxUiBrightText">100%</span>
          </div>
        </div>
        <div class="lxRow">
          <span class="lxRow__label">控制条不透明度</span>
          <div class="lxRangeRow" style="flex:1;max-width:280px">
            <input class="lxRange" id="lxUiOpacity" type="range" min="40" max="100">
            <span id="lxUiOpacityText">100%</span>
          </div>
        </div>
        <div class="lxRow">
          <span class="lxRow__label">显示右上角顶栏</span>
          <button class="lxSwitch" id="lxUiTopbar"></button>
        </div>
        <div class="lxRow">
          <div>
            <div class="lxRow__label">控制条自动隐藏</div>
            <div class="lxRow__hint">鼠标移到窗口底部时滑出来</div>
          </div>
          <button class="lxSwitch" id="lxUiAutoHide"></button>
        </div>
        <div class="lxBtns" style="margin-top:12px">
          <button class="lxBtn" id="lxUiReset">恢复默认</button>
        </div>
      </div>

    </div>
  </div>
</div>
<div class="lxLyric" id="lxLyric"></div>

<!-- ── 搜索加歌浮层（控制条 ＋ / 顶栏放大镜 / Ctrl+F 打开）── -->
<div class="lxSearch" id="lxSearch" hidden>
  <div class="lxSearch__mask" data-sclose="1"></div>
  <div class="lxSearch__box">
    <div class="lxSearch__head">
      <input class="lxSearch__input" id="lxSearchKw" placeholder="搜歌名 / 歌手 / 专辑，回车搜索">
      <button class="lxSearch__close" data-sclose="1">✕</button>
    </div>
    <div class="lxSearch__body" id="lxSearchRes2">
      <div class="lxEmpty">输入关键词搜索 —— <b>点歌名直接播放</b>，点 ＋ 只加入队列</div>
    </div>
    <div class="lxSearch__foot">
      <button class="lxBtn" id="lxAddLocal">从电脑里添加音乐文件</button>
      <span class="lxSearch__tip">支持 mp3 / flac / m4a / wav / ogg / ape</span>
    </div>
  </div>
</div>
`

function injectPanel() {
  const wrap = document.createElement('div')
  wrap.innerHTML = PANEL_HTML
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild)
}

/* ════════════════════════════════════════════════════════════
   八、渲染
   ════════════════════════════════════════════════════════════ */

/** 底部控制条：当前歌曲信息 */
function renderPlayingInfo() {
  const song = P.current()
  const time = $('.time')
  if (time) time.dataset.mode = P.timeMode
  const cover = $('.cover')
  if (cover) {
    const origin = cover.dataset.origin
    if (!song) {
      if (origin) cover.src = origin
    }
  }
  const std = $('.btn--std')
  if (std) std.textContent = QUALITY_SHORT[S.quality] || 'STD'
  updateFavIcon()
  renderTime()
}

function renderTime() {
  const el = $('.time')
  if (!el) return
  if (S.sleepEnd && S.sleepEnd > Date.now()) {
    const left = Math.ceil((S.sleepEnd - Date.now()) / 60000)
    el.textContent = '睡眠 ' + left + ' 分钟'
    return
  }
  const cur = audio.currentTime || 0
  const total = isFinite(audio.duration) ? audio.duration : 0
  el.textContent = P.timeMode === 'left'
    ? '-' + fmtTime(Math.max(0, total - cur)) + ' / ' + fmtTime(total)
    : fmtTime(cur) + ' / ' + fmtTime(total)
}

/** 收藏心形状态 */
function updateFavIcon() {
  const btn = $('.btn[aria-label="收藏"], .btn[aria-label="取消收藏"]')
  if (!btn) return
  const song = P.current()
  const on = song && S.favorites.includes(musicKey(song))
  btn.setAttribute('aria-label', on ? '取消收藏' : '收藏')
  const svgPath = btn.querySelector('path')
  if (svgPath) {
    svgPath.setAttribute('fill', on ? 'currentColor' : 'none')
    btn.style.color = on ? 'var(--track-fill)' : ''
  }
}

/** 播放模式按钮高亮 */
function renderModeIcons() {
  const single = $('.btn[aria-label="单曲循环"]')
  const random = $('.btn[aria-label="随机播放"]')
  if (single) single.style.color = S.mode === 'single' ? 'var(--track-fill)' : ''
  if (random) random.style.color = S.mode === 'random' ? 'var(--track-fill)' : ''
}

/** 歌词面板 */
function renderLyric() {
  const box = $('#lxLyric')
  if (!box) return
  if (!P.lyric.length) {
    box.innerHTML = '<p class="lxLyric__empty">暂无歌词</p>'
    return
  }
  box.innerHTML = P.lyric.map((l, i) =>
    '<p data-i="' + i + '"' + (i === P.lyricIndex ? ' class="is-on"' : '') + '>' + esc(l.text || '·') + '</p>'
  ).join('')
  const cur = box.querySelector('p.is-on')
  if (cur) {
    box.scrollTop = cur.offsetTop - box.clientHeight / 2 + cur.clientHeight / 2
  }
}

/** 音源页 */
function renderApiPage() {
  const stateEl = $('#lxApiState')
  const nameEl = $('#lxApiName')
  if (!stateEl) return

  const map = {
    ok: ['初始化成功', 'lxBadge--ok'],
    fail: ['初始化失败', 'lxBadge--fail'],
    loading: ['载入中…', 'lxBadge--wait'],
    idle: ['未载入', ''],
  }
  const cur = lx.current || lx.list.find(a => a.id === S.lastApiId)
  if (lx.state === 'ok') {
    stateEl.textContent = '初始化成功'
    stateEl.className = 'lxBadge lxBadge--ok'
  } else {
    const v = map[lx.state] || map.idle
    stateEl.textContent = lx.message && lx.state === 'fail' ? '初始化失败' : v[0]
    stateEl.className = 'lxBadge ' + v[1]
  }
  if (nameEl) {
    nameEl.textContent = cur
      ? (cur.name || '未命名') + (cur.version ? ' v' + cur.version : '') + (cur.author ? ' · ' + cur.author : '')
      : '还没有安装任何音源'
  }

  const listEl = $('#lxApiList')
  if (!listEl) return
  if (!lx.list.length) {
    listEl.innerHTML = '<div class="lxEmpty">还没有音源。点上面的「选择文件导入」挑一个 .js 脚本</div>'
    return
  }
  listEl.innerHTML = lx.list.map(a => {
    const on = (cur && a.id === cur.id)
    return '<div class="lxItem' + (on ? ' is-on' : '') + '" data-id="' + esc(a.id) + '">' +
      '<div class="lxItem__main">' +
        '<div class="lxItem__name">' + esc(a.name || '未命名') + (a.version ? ' v' + esc(a.version) : '') + '</div>' +
        '<div class="lxItem__meta">' + esc(a.author || '佚名') + (a.description ? ' · ' + esc(a.description) : '') + '</div>' +
      '</div>' +
      '<div class="lxItem__act"><button data-remove="' + esc(a.id) + '" title="删除">✕</button></div>' +
    '</div>'
  }).join('')

  renderSourceDir()
}

/** 音源页下半部分：把音源目录里的脚本列出来，点一下即导入并启用 */
function renderSourceDir() {
  const title = $('#lxDirTitle')
  const box = $('#lxDirList')
  if (!box) return

  const { dir, files } = listSourceFiles()
  if (title) {
    title.textContent = dir
      ? ('音源目录 · 点一下就导入 —— ' + dir)
      : '音源目录（没找到，可用上面的「选择文件导入」）'
  }

  if (!files.length) {
    box.innerHTML = '<div class="lxEmpty">目录里没有 .js / .txt 音源脚本</div>'
    return
  }

  box.innerHTML = files.map(f =>
    '<div class="lxItem" data-srcfile="' + esc(f.name) + '">' +
      '<div class="lxItem__main">' +
        '<div class="lxItem__name">' + esc(f.name) + '</div>' +
        '<div class="lxItem__meta">' + (f.size / 1024).toFixed(1) + ' KB</div>' +
      '</div>' +
      '<div class="lxItem__act"><button title="导入并启用">＋</button></div>' +
    '</div>'
  ).join('')
}

/** 音源页最下面：在线音源清单（来自社区仓库，点一下就从网上下载并导入） */
function renderOnlineSources() {
  const box = $('#lxOnlineList')
  if (!box) return
  box.innerHTML = ONLINE_SOURCES.map((s, i) =>
    '<div class="lxItem" data-online="' + i + '">' +
      '<div class="lxItem__main">' +
        '<div class="lxItem__name">' + esc(s.label) + '</div>' +
        '<div class="lxItem__meta">' + esc(s.hint) + '</div>' +
      '</div>' +
      '<div class="lxItem__act"><button title="下载并导入">⤓</button></div>' +
    '</div>'
  ).join('')
}

/** 队列页 */
function renderQueue() {
  const box = $('#lxQueueList')
  const cnt = $('#lxQueueCount')
  if (!box) return
  if (cnt) cnt.textContent = String(S.queue.length)
  if (!S.queue.length) {
    box.innerHTML = '<div class="lxEmpty">队列是空的，从上面搜一首加进来</div>'
  } else {
    box.innerHTML = S.queue.map((s, i) =>
      '<div class="lxItem' + (i === S.index ? ' is-on' : '') + '" data-play="' + i + '">' +
        '<span class="lxItem__idx">' + (i + 1) + '</span>' +
        '<div class="lxItem__main">' +
          '<div class="lxItem__name">' + esc(s.name) + '</div>' +
          '<div class="lxItem__meta">' + esc(s.singer || '') + (s.albumName ? ' · ' + esc(s.albumName) : '') + '</div>' +
        '</div>' +
        '<div class="lxItem__act"><button data-delqueue="' + i + '" title="移出队列">✕</button></div>' +
      '</div>'
    ).join('')
  }
  renderFav()
}

function renderFav() {
  const box = $('#lxFavList')
  if (!box) return
  const favs = S.queue.filter(s => S.favorites.includes(musicKey(s)))
  // 队列里没有的收藏也列出来（只有键，没有详情）
  const extra = S.favorites.filter(k => !S.queue.some(s => musicKey(s) === k))
  if (!favs.length && !extra.length) {
    box.innerHTML = '<div class="lxEmpty">还没收藏过歌</div>'
    return
  }
  box.innerHTML = favs.map(s =>
    '<div class="lxItem" data-play="' + S.queue.indexOf(s) + '">' +
      '<div class="lxItem__main">' +
        '<div class="lxItem__name">' + esc(s.name) + '</div>' +
        '<div class="lxItem__meta">' + esc(s.singer || '') + '</div>' +
      '</div>' +
      '<div class="lxItem__act"><button data-unfav="' + esc(musicKey(s)) + '" title="取消收藏">✕</button></div>' +
    '</div>'
  ).join('') + extra.map(k =>
    '<div class="lxItem"><div class="lxItem__main"><div class="lxItem__name">' + esc(k) + '</div>' +
    '<div class="lxItem__meta">不在当前队列</div></div>' +
    '<div class="lxItem__act"><button data-unfav="' + esc(k) + '" title="取消收藏">✕</button></div></div>'
  ).join('')
}

/** 控制页的滑块与分段 */
function renderControls() {
  syncVolumeUI()

  const qs = $('#lxQualitySeg')
  if (qs) {
    qs.innerHTML = QUALITYS.map(q =>
      '<button data-q="' + q.key + '"' + (S.quality === q.key ? ' class="is-on"' : '') + '>' + q.label + '</button>'
    ).join('')
  }

  const ms = $('#lxModeSeg')
  if (ms) {
    ms.innerHTML = Object.keys(MODES).map(k =>
      '<button data-mode="' + k + '"' + (S.mode === k ? ' class="is-on"' : '') + '>' + MODES[k].label + '</button>'
    ).join('')
  }

  const ss = $('#lxSleepSeg')
  if (ss) {
    const opts = [0, 15, 30, 60, 90]
    ss.innerHTML = opts.map(m =>
      '<button data-sleep="' + m + '"' + (S.sleepMinutes === m && S.sleepEnd ? ' class="is-on"' : '') + '>' +
      (m === 0 ? '关闭' : m + ' 分') + '</button>'
    ).join('')
  }

  const sp = $('#lxSpace')
  if (sp) sp.classList.toggle('is-on', !!S.space)

  applyUiSettings()
}

/* ════════════════════════════════════════════════════════════
   九、界面设置的生效
   ════════════════════════════════════════════════════════════ */

function applyUiSettings() {
  const canvas = $('#c')
  if (canvas) {
    const f = []
    if (S.ui.blur) f.push('blur(' + S.ui.blur + 'px)')
    if (S.ui.brightness !== 100) f.push('brightness(' + S.ui.brightness + '%)')
    canvas.style.filter = f.join(' ')
  }
  const player = $('.player')
  if (player) player.style.opacity = String(S.ui.playerOpacity / 100)
  const topbar = $('.topbar')
  if (topbar) topbar.classList.toggle('is-hidden', !S.ui.showTopbar)
  // 关掉自动隐藏时把条子强行拉回来（不能指望下一次 mousemove）
  if (player && !S.ui.autoHideBar) {
    if (barTimer) { clearTimeout(barTimer); barTimer = null }
    player.classList.remove('is-away')
    barHidden = false
  }

  const set = (id, textId, val) => {
    const el = $(id)
    if (el) el.value = String(val)
    const t = $(textId)
    if (t) t.textContent = String(val)
  }
  set('#lxUiBlur', '#lxUiBlurText', S.ui.blur)
  set('#lxUiBright', '#lxUiBrightText', S.ui.brightness)
  set('#lxUiOpacity', '#lxUiOpacityText', S.ui.playerOpacity)
  const tb = $('#lxUiTopbar')
  if (tb) tb.classList.toggle('is-on', S.ui.showTopbar)
  const ab = $('#lxUiAutoHide')
  if (ab) ab.classList.toggle('is-on', S.ui.autoHideBar)
}

/* ════════════════════════════════════════════════════════════
   十、弹出小菜单
   ════════════════════════════════════════════════════════════ */

let popEl = null

function closePopup() {
  if (popEl) {
    popEl.remove()
    popEl = null
  }
}

function openPopup(anchor, items) {
  closePopup()
  const box = document.createElement('div')
  box.className = 'lxPop'
  box.innerHTML = items.map((it, i) =>
    '<div class="lxPop__item' + (it.on ? ' is-on' : '') + '" data-i="' + i + '">' +
      '<span>' + esc(it.label) + '</span>' +
      (it.hint ? '<small>' + esc(it.hint) + '</small>' : '') +
    '</div>'
  ).join('')
  document.body.appendChild(box)

  const r = anchor.getBoundingClientRect()
  const bw = box.offsetWidth
  const bh = box.offsetHeight
  let left = r.left + r.width / 2 - bw / 2
  left = Math.max(12, Math.min(left, window.innerWidth - bw - 12))
  let top = r.top - bh - 10
  if (top < 12) top = r.bottom + 10
  box.style.left = left + 'px'
  box.style.top = top + 'px'
  popEl = box

  box.addEventListener('click', e => {
    const item = e.target.closest('.lxPop__item')
    if (!item) return
    const it = items[Number(item.dataset.i)]
    closePopup()
    if (it && it.onClick) it.onClick()
  })

  setTimeout(() => {
    document.addEventListener('pointerdown', onDocDown, true)
  }, 0)
}

function onDocDown(e) {
  if (popEl && !popEl.contains(e.target)) {
    closePopup()
    document.removeEventListener('pointerdown', onDocDown, true)
  }
}

/* ── 音量 ──
   控制条的喇叭按钮和设置面板「控制」页的滑块共用这一套逻辑，改哪边另一边都会跟着动。 */
let lastVolume = 0.8   // 静音前的音量，用于还原

/** 改音量、落到 audio、同步界面。persist=false 时不写盘 */
function setVolume(v, persist) {
  const n = Math.max(0, Math.min(1, Number(v) || 0))
  S.volume = n
  audio.volume = n
  syncVolumeUI()
  if (persist !== false) S.save()
  return n
}

/** 把音量同步到三处：控制条喇叭状态、设置面板滑块、音量浮层（没开就自动跳过） */
function syncVolumeUI() {
  if (S.volume > 0) lastVolume = S.volume
  const pct = Math.round(S.volume * 100)
  const pv = $('#lxPopVol')
  if (pv) pv.value = String(pct)
  const pt = $('#lxPopVolText')
  if (pt) pt.textContent = pct + '%'
  const btn = $('.btn--vol')
  if (btn) btn.classList.toggle('is-mute', S.volume === 0)
  const v = $('#lxVolume')
  if (v) v.value = String(pct)
  const t = $('#lxVolumeText')
  if (t) t.textContent = pct + '%'
}

/** 静音 / 还原到上次的音量 */
function toggleMute() {
  const next = S.volume > 0 ? 0 : (lastVolume || 0.8)
  setVolume(next)
  toast(next === 0 ? '已静音' : '音量 ' + Math.round(next * 100) + '%')
}

/**
 * 音量浮层：一根原生滑块 + 一个静音键。
 * 没复用 openPopup()，因为那个只支持「一行一个选项」，塞不进滑块。
 */
function openVolumePopup(anchor) {
  closePopup()
  const box = document.createElement('div')
  box.className = 'lxPop lxPop--vol'
  box.dataset.kind = 'volume'
  box.innerHTML =
    '<button class="lxPop__mute" title="静音 / 还原">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4.8 9.5h2.9L11.6 6.3v11.4l-3.9-3.2H4.8z"/>' +
        '<path d="M15.3 10.1l4.3 4.2M19.6 10.1l-4.3 4.2"/>' +
      '</svg>' +
    '</button>' +
    '<input class="lxRange" id="lxPopVol" type="range" min="0" max="100" aria-label="音量">' +
    '<span id="lxPopVolText"></span>'
  document.body.appendChild(box)
  syncVolumeUI()

  const range = box.querySelector('#lxPopVol')
  range.addEventListener('input', () => setVolume(Number(range.value) / 100))
  box.querySelector('.lxPop__mute').addEventListener('click', toggleMute)

  const r = anchor.getBoundingClientRect()
  const bw = box.offsetWidth
  const bh = box.offsetHeight
  let left = r.left + r.width / 2 - bw / 2
  left = Math.max(12, Math.min(left, window.innerWidth - bw - 12))
  let top = r.top - bh - 10
  if (top < 12) top = r.bottom + 10
  box.style.left = left + 'px'
  box.style.top = top + 'px'
  popEl = box

  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0)
}

/* ── 控制条自动隐藏 ──
   判定就一条：鼠标进了「距底部 BAR_HOT 像素」的热区就滑上来，离开热区且不在条上、没有弹层，
   延迟 400ms 再收回（给点缓冲，手一抖不至于把条子晃没了）。 */
const BAR_HOT = 96            // 比控制条本体高一点：鼠标还没碰到底就能看到它升起来
let barHidden = false
let barTimer = null

function hidePlayerBar() {
  const bar = $('.player')
  if (!bar || barHidden) return
  bar.classList.add('is-away')
  barHidden = true
}

function showPlayerBar() {
  const bar = $('.player')
  if (!bar) return
  if (barTimer) { clearTimeout(barTimer); barTimer = null }
  if (!barHidden) return
  bar.classList.remove('is-away')
  barHidden = false
}

function initAutoHideBar() {
  const bar = $('.player')
  if (!bar) return

  // 开场先露面 1.2 秒再沉下去 —— 一进来就是空屏幕，容易让人以为程序坏了
  setTimeout(() => {
    if (S.ui.autoHideBar && !bar.matches(':hover') && !popEl) hidePlayerBar()
  }, 1200)

  window.addEventListener('mousemove', e => {
    if (!S.ui.autoHideBar) return
    if (e.clientY >= window.innerHeight - BAR_HOT) {
      showPlayerBar()
      return
    }
    if (barHidden) return
    // 弹层开着（音量/音质）或鼠标还在条子上：别收，不然够不着上面的弹层
    if (popEl || bar.matches(':hover')) {
      if (barTimer) { clearTimeout(barTimer); barTimer = null }
      return
    }
    if (barTimer) return
    barTimer = setTimeout(() => { barTimer = null; hidePlayerBar() }, 400)
  })

  // 鼠标移出窗口（比如切到别的程序）：直接收起来
  document.addEventListener('mouseleave', () => {
    if (!S.ui.autoHideBar || popEl) return
    if (barTimer) { clearTimeout(barTimer); barTimer = null }
    hidePlayerBar()
  })
}

/** 睡眠定时：控制条上那个时钟按钮已换成音量，现在只被设置面板调用 */
function setSleep(m) {
  S.sleepMinutes = m
  S.sleepEnd = m ? Date.now() + m * 60000 : 0
  S.save()
  renderControls()
  renderTime()
  toast(m ? m + ' 分钟后自动暂停' : '已关闭睡眠定时')
}

/* ════════════════════════════════════════════════════════════
   十一、动作
   ════════════════════════════════════════════════════════════ */

const ACT = {
  /* 音质 */
  quality(anchor) {
    openPopup(anchor, QUALITYS.map(q => ({
      label: q.label,
      hint: q.key,
      on: S.quality === q.key,
      onClick: async () => {
        if (S.quality === q.key) return
        S.quality = q.key
        S.save()
        renderPlayingInfo()
        renderControls()
        const song = P.current()
        if (song) {
          toast('已切到' + q.label + '音质，重新获取地址…')
          await P.playIndex(S.index, !audio.paused)
        }
      },
    })))
  },

  /* 收藏 */
  favorite() {
    const song = P.current()
    if (!song) return
    const k = musicKey(song)
    const i = S.favorites.indexOf(k)
    if (i >= 0) {
      S.favorites.splice(i, 1)
      toast('已取消收藏')
    } else {
      S.favorites.push(k)
      toast('已加入收藏')
    }
    S.save()
    updateFavIcon()
    renderFav()
  },

  /* 添加歌曲 —— 打开搜索浮层（点歌名直接播，点 ＋ 只加入队列） */
  addToQueue() {
    openSearch()
  },

  /* 播放模式 */
  setMode(mode) {
    S.mode = mode
    S.save()
    renderModeIcons()
    renderControls()
    toast(MODES[mode].label)
  },

  /* 全屏 */
  async fullscreen() {
    const now = document.documentElement.dataset.fullscreen === '1'
    const next = !now
    try {
      const r = await ipcRenderer.invoke(CH.fullscreen, next)
      document.documentElement.dataset.fullscreen = r ? '1' : '0'
    } catch (e) {
      document.documentElement.dataset.fullscreen = next ? '1' : '0'
    }
  },

  /* 音量：弹出滑块（再点一次同一个按钮就收起） */
  volume(anchor) {
    if (popEl && popEl.dataset.kind === 'volume') {
      closePopup()
      return
    }
    openVolumePopup(anchor)
  },

  /* 空间音频 */
  async toggleSpace() {
    S.space = !S.space
    S.save()
    await applySpaceAudio()
    renderControls()
    toast(S.space ? '空间音频已开启' : '空间音频已关闭')
  },

  /* 歌词开关 */
  toggleLyric() {
    const box = $('#lxLyric')
    if (!box) return
    box.classList.toggle('is-on')
    if (box.classList.contains('is-on')) renderLyric()
  },

  /* 时间显示切换 */
  toggleTimeMode() {
    P.timeMode = P.timeMode === 'total' ? 'left' : 'total'
    renderTime()
  },
}

/* ── 空间音频：用 Web Audio 加宽立体声 + 抬低频 ──
   注意：createMediaElementSource() 不可逆 —— 一旦建立，audio 的输出永久经由 Web Audio 图。
   所以在接管之前必须先确认 AudioContext 真的处于 running，否则接管之后 context 若挂起，
   audio.play() 会失败、声音直接消失。（踩过：先建链路后 resume，结果播放被判坏源连跳两首。） */
let wa = null

async function applySpaceAudio() {
  // 关闭：停掉摆动与低频增益。链路本身撤不回来（API 限制），只让它保持"透明"。
  if (!S.space) {
    if (wa) {
      clearInterval(wa.timer)
      wa.timer = null
      wa.bass.gain.value = 0
      wa.pan.pan.value = 0
    }
    return
  }

  try {
    if (!wa) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) {
        toast('当前环境不支持音频增强')
        S.space = false
        S.save()
        return
      }
      const ctx = new Ctx()
      await ctx.resume().catch(() => {})
      if (ctx.state !== 'running') {
        // 拿不到 running 就绝不接管 audio 输出，宁可功能不生效
        toast('音频增强没启动起来，稍后再试')
        S.space = false
        S.save()
        return
      }
      const src = ctx.createMediaElementSource(audio)
      const bass = ctx.createBiquadFilter()
      bass.type = 'lowshelf'
      bass.frequency.value = 220
      const pan = ctx.createStereoPanner()
      src.connect(bass)
      bass.connect(pan)
      pan.connect(ctx.destination)
      wa = { ctx, bass, pan, timer: null }
    }

    if (wa.ctx.state === 'suspended') await wa.ctx.resume().catch(() => {})

    wa.bass.gain.value = 5
    let t = 0
    clearInterval(wa.timer)
    // 极缓慢左右摆动，做出包围感（周期约 12 秒，幅度很小）
    wa.timer = setInterval(() => {
      t += 0.05
      wa.pan.pan.value = Math.sin(t) * 0.15
    }, 50)
  } catch (e) {
    console.warn('[lx] 空间音频不可用', e)
    toast('音频增强启动失败')
    S.space = false
    S.save()
  }
}

// context 被系统挂起时必须拉回来，否则音频走 Web Audio 图就没声了
audio.addEventListener('play', () => {
  if (wa && wa.ctx && wa.ctx.state === 'suspended') {
    wa.ctx.resume().catch(() => {})
  }
})

/* ════════════════════════════════════════════════════════════
   十二、面板交互
   ════════════════════════════════════════════════════════════ */

function openPanel(tab) {
  const p = $('#lxPanel')
  if (!p) return
  p.hidden = false
  if (tab) switchTab(tab)
  renderApiPage()
  renderQueue()
  renderControls()
  refreshCacheSize()
}

function closePanel() {
  const p = $('#lxPanel')
  if (p) p.hidden = true
  closePopup()
}

function switchTab(tab) {
  $$('.lxp__tabs button').forEach(b => b.classList.toggle('is-on', b.dataset.tab === tab))
  $$('.lxp__page').forEach(p => p.classList.toggle('is-on', p.dataset.page === tab))
}

async function refreshCacheSize() {
  const el = $('#lxCacheSize')
  if (!el) return
  try {
    const n = await ipcRenderer.invoke(CH.getCacheSize)
    const kb = Math.round((Number(n) || 0) / 1024)
    el.textContent = kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'
  } catch (e) {
    el.textContent = '—'
  }
}

/** 打开/关闭搜索加歌浮层 */
function openSearch() {
  const el = $('#lxSearch')
  if (!el) return
  el.hidden = false
  setTimeout(() => { const i = $('#lxSearchKw'); if (i) i.focus() }, 30)
}
function closeSearch() {
  const el = $('#lxSearch')
  if (el) el.hidden = true
}

/** Windows 路径 → file:// URL（分段编码，盘符不编码） */
function localFileUrl(p) {
  const norm = String(p).replace(/\\/g, '/')
  return 'file:///' + norm.split('/')
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join('/')
}

/** 选本地音乐文件加进队列（不走音源，播放时直接读文件） */
async function addLocalFiles() {
  try {
    const r = await ipcRenderer.invoke(CH.selectDialog, {
      title: '选择音乐文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频文件', extensions: ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'wma', 'ape'] }],
    })
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return

    let n = 0
    for (const p of r.filePaths) {
      const base = path.basename(p).replace(/\.[^.]+$/, '')
      let name = base
      let singer = ''
      // 常见命名「歌手 - 歌名」拆一下
      const m = /^(.+?)\s*[-–—]\s*(.+)$/.exec(base)
      if (m) {
        singer = m[1].trim()
        name = m[2].trim()
      }
      S.queue.push({ source: 'local', localPath: p, name, singer, albumName: '' })
      n++
    }
    S.save()
    renderQueue()
    toast('已加入 ' + n + ' 首本地音乐')
    closeSearch()
  } catch (e) {
    toast('添加失败：' + (e.message || e))
  }
}

/**
 * 搜索结果点击的统一处理。
 * 点整行 = 加入队列并立即播放；点 ＋ = 只加入队列。
 * 面板里的搜索和浮层里的搜索共用它。
 */
function handleSongListClick(e, boxSel) {
  const box = $(boxSel)
  if (!box) return false
  const item = e.target.closest('[data-song]')
  if (!item || !box._songs) return false
  const song = box._songs[Number(item.dataset.song)]
  if (!song) return false
  e.stopPropagation()

  if (e.target.closest('[data-queue]')) {
    S.queue.push(Object.assign({}, song))
    S.save()
    renderQueue()
    toast('已加入队列：' + song.name + '（第 ' + S.queue.length + ' 首）')
    return true
  }

  // 立即播放：同时加进队列，否则切歌时队列里没有它、会被跳过
  S.queue.push(Object.assign({}, song))
  const idx = S.queue.length - 1
  S.save()
  renderQueue()
  P.playIndex(idx, true)
  closeSearch()
  toast('正在播放：' + song.name + '（已加入队列第 ' + (idx + 1) + ' 首）')
  return true
}

/** 顶栏加一个放大镜按钮（不动 index.html，直接插进去） */
function injectTopbarSearch() {
  const topbar = $('.topbar')
  if (!topbar || $('#lxTopSearch')) return
  const btn = document.createElement('button')
  btn.className = 'topbar__home'
  btn.id = 'lxTopSearch'
  btn.setAttribute('aria-label', '搜索加歌')
  btn.title = '搜索加歌（Ctrl+F）'
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.2"/><path d="m15.2 15.2 4.6 4.6"/></svg>'
  btn.addEventListener('click', () => openSearch())
  topbar.insertBefore(btn, topbar.firstChild)
}

/**
 * 搜索歌曲（直连酷我）。
 * boxSel 指向结果容器：浮层用 #lxSearchRes2，设置面板队列页用 #lxSearchRes。
 */
async function doSearch(kw, boxSel) {
  const box = $(boxSel || '#lxSearchRes2')
  if (!box) return
  if (!kw) {
    box.innerHTML = '<div class="lxEmpty">输入歌名或歌手，回车搜索</div>'
    return
  }
  box.innerHTML = '<div class="lxEmpty">搜索中…</div>'
  try {
    const url = 'http://search.kuwo.cn/r.s?all=' + encodeURIComponent(kw) +
      '&ft=music&itemset=web_2013&client=kt&pn=0&rn=20&rformat=json&encoding=utf8&vipver=1'
    const text = await httpGet(url, 'http://www.kuwo.cn/')
    const songs = parseKuwoSearch(text)
    if (!songs.length) {
      box.innerHTML = '<div class="lxEmpty">没搜到，换个关键词</div>'
      return
    }
    box.innerHTML = songs.map((s, i) =>
      '<div class="lxItem" data-song="' + i + '">' +
        '<span class="lxItem__idx">' + (i + 1) + '</span>' +
        '<div class="lxItem__main">' +
          '<div class="lxItem__name">' + esc(s.name) + '</div>' +
          '<div class="lxItem__meta">' + esc(s.singer) + (s.albumName ? ' · ' + esc(s.albumName) : '') + '</div>' +
        '</div>' +
        '<div class="lxItem__act is-always">' +
          '<button title="加入队列" data-queue>＋</button>' +
          '<button title="立即播放" data-play>▶</button>' +
        '</div>' +
      '</div>'
    ).join('')
    box._songs = songs
  } catch (e) {
    console.warn('[lx] 搜索失败', e)
    box.innerHTML = '<div class="lxEmpty">搜索失败：' + esc(e.message || e) + '</div>'
  }
}

/** 解析酷我搜索返回的类 JS 文本 */
function parseKuwoSearch(text) {
  const out = []
  const blocks = String(text).split('DC_TARGETID')
  for (let i = 1; i < blocks.length; i++) {
    const seg = blocks[i]
    const get = (key) => {
      const m = new RegExp("['\"]?" + key + "['\"]?\\s*[:=]\\s*['\"]([^'\"]*)", 'i').exec(seg)
      return m ? m[1] : ''
    }
    const songmid = /^['\"]?\s*[:=]\s*['\"]?(\d+)/.exec(seg)
    const name = get('SONGNAME') || get('NAME')
    const singer = get('ARTIST')
    const albumName = get('ALBUM')
    if (!songmid || !name) continue
    const album = cleanEntity(albumName)
    out.push({
      source: 'kw',
      songmid: songmid[1],
      name: cleanEntity(name).replace(/\s*-\s*《[^》]*》.*$/, ''),
      singer: cleanEntity(singer).replace(/\\\\u0026/g, '&').replace(/\s*\/\s*$/, ''),
      // 酷我对没有专辑信息的条目会返回 '0'，别让它显示成「歌手 · 0」
      albumName: (album && album !== '0') ? album : '',
    })
    if (out.length >= 20) break
  }
  return out
}

function cleanEntity(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

/* ════════════════════════════════════════════════════════════
   十三、事件绑定
   ════════════════════════════════════════════════════════════ */

function bindControlBar() {
  const on = (sel, fn) => {
    const el = $(sel)
    if (el) el.addEventListener('click', fn)
  }

  // 1 封面 → 歌词
  on('.cover', () => ACT.toggleLyric())
  // 2 音质
  on('.btn--std', e => ACT.quality(e.currentTarget))
  // 3 收藏
  on('.btn[aria-label="收藏"]', () => ACT.favorite())
  // 4 添加到队列
  on('.btn[aria-label="添加"]', () => ACT.addToQueue())
  // 5 单曲循环
  on('.btn[aria-label="单曲循环"]', () => ACT.setMode(S.mode === 'single' ? 'order' : 'single'))
  // 6 随机播放
  on('.btn[aria-label="随机播放"]', () => ACT.setMode(S.mode === 'random' ? 'order' : 'random'))
  // 7 上一曲
  on('.btn[aria-label="上一曲"]', () => P.prev())
  // 8 播放/暂停
  on('.pause', () => P.toggle())
  // 9 下一曲
  on('.btn[aria-label="下一曲"]', () => P.next(true))
  // 10 播放队列
  on('.btn[aria-label="播放队列"]', () => openPanel('queue'))
  // 11 音量
  on('.btn--vol', e => ACT.volume(e.currentTarget))
  // 12 360 空间音频
  const btn360 = $$('.btn--text').find(b => b.textContent.trim() === '360')
  if (btn360) btn360.addEventListener('click', () => ACT.toggleSpace())
  // 13 词
  on('.btn--han', () => ACT.toggleLyric())
  // 14 全屏
  on('.btn[aria-label="全屏"]', () => ACT.fullscreen())
  // 15 时间显示切换
  on('.time', () => ACT.toggleTimeMode())

  // 进度条：点击 + 拖动
  const bar = $('.progress')
  if (bar) {
    let dragging = false
    const ratioFrom = (e) => {
      const r = bar.getBoundingClientRect()
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    }
    bar.addEventListener('pointerdown', e => {
      dragging = true
      bar.setPointerCapture(e.pointerId)
      const fill = $('.progress__fill')
      if (fill) fill.style.width = (ratioFrom(e) * 100).toFixed(2) + '%'
    })
    bar.addEventListener('pointermove', e => {
      if (!dragging) return
      const fill = $('.progress__fill')
      if (fill) fill.style.width = (ratioFrom(e) * 100).toFixed(2) + '%'
    })
    bar.addEventListener('pointerup', e => {
      if (!dragging) return
      dragging = false
      P.seek(ratioFrom(e))
    })
    bar.addEventListener('pointercancel', () => { dragging = false })
  }
}

function bindTopBar() {
  const home = $('.topbar__home')
  if (home) home.addEventListener('click', () => openPanel('api'))
  const user = $('.topbar__user')
  if (user) user.addEventListener('click', () => openPanel('play'))
}

function bindPanel() {
  const panel = $('#lxPanel')
  if (!panel) return

  panel.addEventListener('click', e => {
    const close = e.target.closest('[data-close]')
    if (close) { closePanel(); return }

    const tab = e.target.closest('.lxp__tabs button')
    if (tab) { switchTab(tab.dataset.tab); return }

    // 音源列表
    const rm = e.target.closest('[data-remove]')
    if (rm) {
      e.stopPropagation()
      const id = rm.dataset.remove
      lx.remove([id]).then(() => {
        if (S.lastApiId === id) S.lastApiId = ''
        S.save()
        renderApiPage()
        toast('已删除该音源')
      })
      return
    }
    const apiItem = e.target.closest('#lxApiList .lxItem')
    if (apiItem && apiItem.dataset.id) {
      lx.enable(apiItem.dataset.id).then(() => {
        toast('已切换音源，正在初始化…')
        renderApiPage()
      })
      return
    }

    // 音源目录里的文件：点一下就导入并启用
    const sf = e.target.closest('[data-srcfile]')
    if (sf) {
      e.stopPropagation()
      const name = sf.dataset.srcfile
      const { files } = listSourceFiles()
      const target = files.find(f => f.name === name)
      if (!target) return
      importSourceFile(target.path)
        .then(info => {
          toast('已导入并启用：' + info.name)
          renderApiPage()
        })
        .catch(err => toast('导入失败：' + (err.message || err)))
      return
    }

    // 在线音源：从社区仓库下载并导入
    const on = e.target.closest('[data-online]')
    if (on) {
      e.stopPropagation()
      const idx = Number(on.dataset.online)
      const meta = ONLINE_SOURCES[idx]
      if (!meta) return
      const label = meta.label
      const btn = on.querySelector('button')
      if (on.dataset.busy === '1') return
      on.dataset.busy = '1'
      if (btn) btn.textContent = '…'
      toast('正在下载 ' + label + '…')
      importOnlineSource(meta)
        .then(info => {
          toast('已导入并启用：' + info.name)
          renderApiPage()
        })
        .catch(err => toast('下载失败：' + (err.message || err)))
        .finally(() => {
          on.dataset.busy = ''
          if (btn) btn.textContent = '⤓'
        })
      return
    }

    // 队列
    const del = e.target.closest('[data-delqueue]')
    if (del) {
      e.stopPropagation()
      const i = Number(del.dataset.delqueue)
      S.queue.splice(i, 1)
      if (S.index >= S.queue.length) S.index = 0
      S.save()
      renderQueue()
      return
    }
    const unfav = e.target.closest('[data-unfav]')
    if (unfav) {
      e.stopPropagation()
      const k = unfav.dataset.unfav
      const i = S.favorites.indexOf(k)
      if (i >= 0) S.favorites.splice(i, 1)
      S.save()
      renderFav()
      updateFavIcon()
      return
    }
    // 搜索结果：点歌名播放 / 点 ＋ 加入队列（面板里的搜索也走同一套）
    if (handleSongListClick(e, '#lxSearchRes')) return
    const playIdx = e.target.closest('[data-play]')
    if (playIdx) {
      e.stopPropagation()
      P.playIndex(Number(playIdx.dataset.play), true)
      return
    }

    // 分段选择
    const q = e.target.closest('[data-q]')
    if (q) { ACT.quality(q); return }
    const md = e.target.closest('[data-mode]')
    if (md) { ACT.setMode(md.dataset.mode); return }
    const sl = e.target.closest('[data-sleep]')
    if (sl) {
      setSleep(Number(sl.dataset.sleep))
      return
    }
  })

  // 音源导入
  $('#lxImportFile').addEventListener('click', async () => {
    try {
      const dir = findSourceDir()
      const r = await ipcRenderer.invoke(CH.selectDialog, {
        title: '选择音源脚本',
        defaultPath: dir || undefined,
        properties: ['openFile'],
        filters: [{ name: '音源脚本', extensions: ['js', 'txt'] }],
      })
      if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return
      const info = await importSourceFile(r.filePaths[0])
      toast('已导入并启用：' + info.name)
      renderApiPage()
    } catch (e) {
      toast('导入失败：' + (e.message || e))
    }
  })

  $('#lxImportUrl').addEventListener('click', () => {
    const row = $('#lxUrlRow')
    row.style.display = row.style.display === 'none' ? 'flex' : 'none'
  })
  $('#lxUrlCancel').addEventListener('click', () => { $('#lxUrlRow').style.display = 'none' })
  $('#lxUrlGo').addEventListener('click', async () => {
    const url = $('#lxUrlInput').value.trim()
    if (!url) return
    try {
      toast('正在下载脚本…')
      const text = await httpGet(url, url)
      const info = await lx.import(text)
      await lx.enable(info.id)
      $('#lxUrlRow').style.display = 'none'
      $('#lxUrlInput').value = ''
      toast('已导入并启用：' + info.name)
      renderApiPage()
    } catch (e) {
      toast('下载失败：' + (e.message || e))
    }
  })
  $('#lxOpenDir').addEventListener('click', () => {
    try {
      const dir = findSourceDir()
      if (!dir) {
        toast('没找到音源目录，用上面的「选择文件导入」选一个')
        return
      }
      ipcRenderer.send(CH.openDirInExplorer, dir)
    } catch (e) {
      toast('打不开目录')
    }
  })

  // 搜索
  const si = $('#lxSearchInput')
  si.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch(si.value.trim(), '#lxSearchRes')
  })
  $('#lxSearchGo').addEventListener('click', () => doSearch(si.value.trim(), '#lxSearchRes'))

  // 控制页
  $('#lxVolume').addEventListener('input', e => setVolume(Number(e.target.value) / 100))
  $('#lxSpace').addEventListener('click', () => ACT.toggleSpace())
  $('#lxClearCache').addEventListener('click', async () => {
    try {
      await ipcRenderer.invoke(CH.clearCache)
      toast('缓存已清除')
      refreshCacheSize()
    } catch (e) {
      toast('清除失败')
    }
  })

  // 界面页
  const bindRange = (sel, textSel, key, suffix) => {
    const el = $(sel)
    if (!el) return
    el.addEventListener('input', e => {
      const v = Number(e.target.value)
      S.ui[key] = v
      if (textSel) $(textSel).textContent = v + suffix
      S.save()
      applyUiSettings()
    })
  }
  bindRange('#lxUiBlur', '#lxUiBlurText', 'blur', 'px')
  bindRange('#lxUiBright', '#lxUiBrightText', 'brightness', '%')
  bindRange('#lxUiOpacity', '#lxUiOpacityText', 'playerOpacity', '%')
  $('#lxUiTopbar').addEventListener('click', () => {
    S.ui.showTopbar = !S.ui.showTopbar
    S.save()
    applyUiSettings()
  })
  $('#lxUiAutoHide').addEventListener('click', () => {
    S.ui.autoHideBar = !S.ui.autoHideBar
    S.save()
    applyUiSettings()
    if (S.ui.autoHideBar) toast('鼠标移到窗口底部会弹出控制条')
  })
  $('#lxUiReset').addEventListener('click', () => {
    S.ui = { blur: 0, brightness: 100, playerOpacity: 100, showTopbar: true, autoHideBar: true }
    S.save()
    applyUiSettings()
    renderControls()
    toast('界面设置已恢复默认')
  })

  // 歌词面板点击跳转
  $('#lxLyric').addEventListener('click', e => {
    const p = e.target.closest('p[data-i]')
    if (!p) return
    const l = P.lyric[Number(p.dataset.i)]
    if (l) audio.currentTime = l.time
  })
}

function bindSearch() {
  const el = $('#lxSearch')
  if (!el) return

  el.addEventListener('click', e => {
    if (e.target.closest('[data-sclose]')) { closeSearch(); return }
    handleSongListClick(e, '#lxSearchRes2')
  })

  const kw = $('#lxSearchKw')
  if (kw) {
    kw.addEventListener('keydown', e => {
      if (e.key === 'Enter') doSearch(kw.value.trim(), '#lxSearchRes2')
      if (e.key === 'Escape') { e.stopPropagation(); closeSearch() }
    })
  }

  const local = $('#lxAddLocal')
  if (local) local.addEventListener('click', () => addLocalFiles())
}

function bindKeyboard() {
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea') return

    // Ctrl+F 打开搜索加歌
    if (e.ctrlKey && e.code === 'KeyF') {
      e.preventDefault()
      openSearch()
      return
    }

    switch (e.code) {
      case 'Space':
        e.preventDefault()
        P.toggle()
        break
      case 'ArrowRight':
        if (isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5)
        break
      case 'ArrowLeft':
        audio.currentTime = Math.max(0, audio.currentTime - 5)
        break
      case 'ArrowUp':
        e.preventDefault()
        setVolume(S.volume + 0.05)
        break
      case 'ArrowDown':
        e.preventDefault()
        setVolume(S.volume - 0.05)
        break
      case 'Escape':
        if (!$('#lxSearch').hidden) closeSearch()
        else if (!$('#lxPanel').hidden) closePanel()
        else $('#lxLyric').classList.remove('is-on')
        break
      default:
        break
    }
  })
}

/* ════════════════════════════════════════════════════════════
   十四、启动
   ════════════════════════════════════════════════════════════ */

/** 应用目录（dist/）。
 *  不用 __dirname：它经过 webpack 处理后语义会变，用页面 URL 反推最稳。 */
const APP_DIR = (() => {
  try {
    const p = decodeURIComponent(location.pathname)
    return path.dirname(p.replace(/^\//, ''))
  } catch (e) {
    return __dirname
  }
})()

/**
 * 音源目录（按优先级取第一个存在的）：
 *   1. 项目根/_sources              —— 开发期首选。往这里丢 .js 就能用，不用重新编译
 *   2. %APPDATA%/lx-music-desktop/sources —— 打包后的主目录（可写，用户自己加源放这）
 *   3. dist/static/sources          —— 随包内置的兜底源（打包后是只读的 asar）
 *
 * 打包后 asar 里的目录是只读的，用户没法往里丢文件，所以第一次启动会把内置源
 * 拷一份到第 2 个目录（可写），之后「打开音源目录」也指向它。
 * 换默认音源：把文件名改成以 default 开头（或叫 qdy），启动时优先挑它。
 */
const SOURCE_DEV_DIR = path.join(APP_DIR, '..', '_sources')
const SOURCE_USER_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'lx-music-desktop', 'sources')
  : ''
const SOURCE_BUILTIN_DIR = path.join(APP_DIR, 'static', 'sources')
const SOURCE_DIRS = [SOURCE_DEV_DIR, SOURCE_USER_DIR, SOURCE_BUILTIN_DIR].filter(Boolean)

/**
 * 打包运行时（项目根没有 _sources）就把内置源补到用户目录，让用户能增删。
 * 已存在的文件不动（用户可能自己改过或替换过），只补缺的 —— 这样软件升级后
 * 新增的内置源会自动出现。
 */
function ensureUserSourceDir() {
  try {
    if (fs.existsSync(SOURCE_DEV_DIR)) return          // 开发期，不用管用户目录
    if (!SOURCE_USER_DIR) return
    let builtin = null
    for (const d of [SOURCE_BUILTIN_DIR]) {
      try { if (fs.existsSync(d)) { builtin = d; break } } catch (e) { /* 忽略 */ }
    }
    if (!builtin) return

    let created = 0
    try { fs.mkdirSync(SOURCE_USER_DIR, { recursive: true }) } catch (e) { /* 已存在 */ }
    for (const f of fs.readdirSync(builtin)) {
      if (!/\.(js|txt)$/i.test(f)) continue
      // 内置的是 .txt（躲 webpack 压缩用的），拷过去改成 .js 更顺眼
      const dest = path.join(SOURCE_USER_DIR, f.replace(/\.txt$/i, '.js'))
      if (fs.existsSync(dest)) continue
      fs.copyFileSync(path.join(builtin, f), dest)
      created++
    }
    if (created) console.log('[lx] 已向音源目录补充 ' + created + ' 个内置源：' + SOURCE_USER_DIR)
  } catch (e) {
    console.warn('[lx] 初始化音源目录失败', e)
  }
}

/** 找到第一个存在的音源目录 */
function findSourceDir() {
  for (const dir of SOURCE_DIRS) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir
    } catch (e) { /* 试下一个 */ }
  }
  return null
}

/** 列出音源目录里可导入的脚本（下划线开头的临时文件不算） */
function listSourceFiles() {
  const dir = findSourceDir()
  if (!dir) return { dir: null, files: [] }
  let files = []
  try {
    files = fs.readdirSync(dir)
      .filter(f => /\.(js|txt)$/i.test(f) && !f.startsWith('_'))
      .map(f => {
        let size = 0
        try { size = fs.statSync(path.join(dir, f)).size } catch (e) { /* 忽略 */ }
        return { name: f, size, path: path.join(dir, f) }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (e) {
    console.warn('[lx] 读不到音源目录', e)
  }
  return { dir, files }
}

/** 挑默认音源：优先 default*，其次 qdy*，再其次第一个 */
function pickDefaultSourceFile(files) {
  if (!files || !files.length) return null
  return files.find(f => /default/i.test(f.name)) ||
    files.find(f => /qdy/i.test(f.name)) ||
    files[0]
}

/** 从本地文件导入并启用一个音源 */
async function importSourceFile(filePath) {
  const info = await lx.import(fs.readFileSync(filePath, 'utf8'))
  await lx.enable(info.id)
  return info
}

/** 把清单项拼成 raw 地址（默认仓库走 `<id>/latest.js` 的目录约定） */
function onlineSourceUrl(item) {
  const [repo, branch] = SOURCE_REPOS[item.repo || 'pdone']
  const p = item.path || (item.id + '/latest.js')
  return 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + encodeURI(p)
}

/** 从社区仓库拉一个音源脚本（依次试各个镜像，第一个通的就用） */
async function fetchOnlineSource(item) {
  const raw = onlineSourceUrl(item)
  let lastErr = null
  for (const mirror of SOURCE_MIRRORS) {
    try {
      const txt = await httpGet(mirror(raw), 'https://github.com/')
      if (/@name/.test(txt)) return txt
      lastErr = new Error('拿到的不是音源脚本')
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('所有线路都不通（GitHub 直连和三个镜像都失败了）')
}

/**
 * 从在线仓库导入并启用一个音源。
 * 已经装过同名的会先删掉再装 —— 所以同一个按钮点第二次就等于「更新到最新」，
 * 不会在列表里堆出一串重复的源。
 */
async function importOnlineSource(item) {
  const txt = await fetchOnlineSource(item)
  const name = ((/@name\s+([^\n*]+)/.exec(txt) || [])[1] || '').trim()

  if (name) {
    const olds = lx.list.filter(a => a.name === name)
    if (olds.length) {
      await lx.remove(olds.map(a => a.id))
      if (olds.some(o => lx.current && o.id === lx.current.id)) {
        lx.state = 'loading'
        lx.current = null
      }
    }
  }

  const info = await lx.import(txt)
  await lx.enable(info.id)
  return info
}

async function boot() {
  S.load()
  ensureUserSourceDir()      // 打包运行时：把内置音源拷到可写的用户目录
  injectStyle()
  injectPanel()

  audio.volume = S.volume

  bindControlBar()
  bindTopBar()
  bindPanel()
  bindSearch()
  bindKeyboard()
  injectTopbarSearch()
  initAutoHideBar()

  renderPlayingInfo()
  renderModeIcons()
  renderControls()
  renderApiPage()
  renderOnlineSources()
  renderQueue()
  renderLyric()

  setInterval(() => P.checkSleep(), 5000)

  // 音源初始化（异步，不阻塞界面）
  try {
    await lx.bootstrap()
    renderApiPage()
    console.log('[lx] 音源已就绪')
  } catch (e) {
    lx.state = 'fail'
    lx.message = e && e.message ? e.message : String(e)
    renderApiPage()
    console.warn('[lx] 音源初始化失败', e)
  }

  window.lxApp = {
    S, P, lx, ACT, openPanel, closePanel, openSearch, closeSearch, addLocalFiles, audio,
    // 控制条自动隐藏的调试出口：回归测试要确定性地驱动它，
    // 不能靠合成鼠标坐标碰运气（合成事件的 :hover 和真实鼠标不一样）
    bar: { show: showPlayerBar, hide: hidePlayerBar, isHidden: () => barHidden },
  }
  console.log('[lx] 界面逻辑层已就绪。当前队列 ' + S.queue.length + ' 首')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
