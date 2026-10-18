App({
  globalData: {
    token: '',
    userInfo: null,
    coupleInfo: null,
    apiBase: 'https://api.jdhsf.top',
    apiBaseBackup: 'https://xiaoqihou-api.1655316141.workers.dev',
    requestTimeout: 15000,
    requestRetry: 2,
    locationVisible: true,
    locationUpdateTimer: null,
    // 10 种内置情绪 + 自定义
    emotionMap: {
      '心动': { emoji: '🥰', color1: '#FF8FAB', color2: '#FFD6E8', text: '#8B3A62', name: '心动', category: 'positive' },
      '开心': { emoji: '😄', color1: '#FFD27A', color2: '#FFF1C2', text: '#8B5A00', name: '开心', category: 'positive' },
      '兴奋': { emoji: '🥳', color1: '#FF6B9D', color2: '#FFC5DC', text: '#8B1A4A', name: '兴奋', category: 'positive' },
      '惊喜': { emoji: '🤩', color1: '#FFB347', color2: '#FFE5B4', text: '#8B5A2B', name: '惊喜', category: 'positive' },
      '平静': { emoji: '😌', color1: '#B0C4DE', color2: '#E6EEF8', text: '#3A4A66', name: '平静', category: 'neutral' },
      '疲惫': { emoji: '😴', color1: '#B8B8C8', color2: '#DEDEE8', text: '#4A4A5C', name: '疲惫', category: 'neutral' },
      '难过': { emoji: '😢', color1: '#7393B3', color2: '#B4C7DA', text: '#1F3A52', name: '难过', category: 'negative' },
      '生气': { emoji: '😠', color1: '#FF4444', color2: '#FFAAAA', text: '#8B0000', name: '生气', category: 'negative' },
      '委屈': { emoji: '🥺', color1: '#A8C5E6', color2: '#D6E3F0', text: '#2A3A4E', name: '委屈', category: 'negative' },
      '焦虑': { emoji: '😰', color1: '#9B8EC5', color2: '#D4CCE8', text: '#3D2E5C', name: '焦虑', category: 'negative' }
    },
    // 合成心情的展示信息
    mergeMeta: {
      '心有灵犀': { emoji: '💕', color1: '#FF8FAB', color2: '#FFD6E8', text: '#8B3A62' },
      '甜蜜时刻': { emoji: '🥰', color1: '#FF6B9D', color2: '#FFC5DC', text: '#8B1A4A' },
      '岁月静好': { emoji: '🌙', color1: '#B0C4DE', color2: '#E6EEF8', text: '#3A4A66' },
      '抱抱彼此': { emoji: '🤗', color1: '#7393B3', color2: '#B4C7DA', text: '#1F3A52' },
      '晴空万里': { emoji: '☀️', color1: '#FFD27A', color2: '#FFF1C2', text: '#8B5A00' },
      '冰火两重': { emoji: '🌦️', color1: '#A8C5E6', color2: '#FFD6A5', text: '#3A4A66' },
      '需要关怀': { emoji: '🌧️', color1: '#9B8EC5', color2: '#D4CCE8', text: '#3D2E5C' }
    },
    quotes: [
      '你的一句晚安，治愈了我一整天的疲惫。',
      '和你在一起的每一天，都值得收藏。',
      '你笑起来，我的世界就亮了。',
      '愿我们的心情，永远同频共振。',
      '风很温柔，花很浪漫，你很特别。',
      '把所有的温柔，都设置成仅你可见。',
      '你是我漫漫余生里，斩金截铁的梦想。',
      '星河滚烫，你是人间理想。'
    ]
  },

  onLaunch() {
    const token = wx.getStorageSync('token')
    if (token) this.globalData.token = token
    const userInfo = wx.getStorageSync('userInfo')
    if (userInfo) this.globalData.userInfo = userInfo
    const coupleInfo = wx.getStorageSync('coupleInfo')
    if (coupleInfo) this.globalData.coupleInfo = coupleInfo
    // 读取位置可见性缓存
    try {
      const vis = wx.getStorageSync('locationVisible')
      if (vis !== '' && vis !== undefined && vis !== null) this.globalData.locationVisible = !!vis
    } catch (_) {}
    // 登录后启动 5 分钟自动更新位置
    if (token) this.startAutoLocationUpdate()
    // 全局开启右上角「转发给朋友 / 分享到朋友圈」入口（个人主体未认证也能用）
    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage', 'shareTimeline'],
        fail: () => {}
      })
    } catch (_) {}
  },

  onShow() {
    this.stopBackgroundLocation()
    if (this.globalData.token) this.startAutoLocationUpdate()
  },

  onHide() {
    this.stopAutoLocationUpdate()
    if (this.globalData.token) this.startBackgroundLocation()
  },

  getLocationVisible() {
    return this.globalData.locationVisible !== false
  },

  setLocationVisible(v) {
    const visible = !!v
    this.globalData.locationVisible = visible
    try { wx.setStorageSync('locationVisible', visible ? 1 : 0) } catch (_) {}
  },

  startAutoLocationUpdate() {
    this.stopAutoLocationUpdate()
    if (!this.globalData.token) return
    // 每 5 分钟更新一次
    this.globalData.locationUpdateTimer = setInterval(() => {
      this.updateLocationOnce()
    }, 5 * 60 * 1000)
  },

  stopAutoLocationUpdate() {
    const t = this.globalData.locationUpdateTimer
    if (t) {
      clearInterval(t)
      this.globalData.locationUpdateTimer = null
    }
  },

  // 后台持续定位（用户授权后，切换应用或锁屏时也能更新）
  startBackgroundLocation() {
    try {
      wx.startLocationUpdateBackground({
        success: () => {
          wx.onLocationChange(this._onBackgroundLocationChange)
        },
        fail: () => {}
      })
    } catch (_) {}
  },

  stopBackgroundLocation() {
    try {
      wx.offLocationChange(this._onBackgroundLocationChange)
      wx.stopLocationUpdate({})
    } catch (_) {}
  },

  _onBackgroundLocationChange(res) {
    const app = getApp()
    if (!res || !res.latitude || !res.longitude || !app.globalData.token) return
    // 简单节流：30 秒内不重复保存
    const now = Date.now()
    if (app._lastBgSave && now - app._lastBgSave < 30 * 1000) return
    app._lastBgSave = now
    app.reverseGeocode(res.latitude, res.longitude).then((geo) => {
      return app.saveLocation({
        lat: res.latitude,
        lng: res.longitude,
        province: geo.province || '',
        city: geo.city || '',
        district: geo.district || '',
        street: geo.street || '',
        address: geo.address || geo.full_address || '',
        poi: geo.poi || '',
        visible: app.getLocationVisible()
      })
    }).catch(() => {})
  },

  async updateLocationOnce() {
    if (!this.globalData.token) return
    try {
      // 8 秒超时
      const loc = await Promise.race([
        new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('定位超时')), 8000)
          wx.getLocation({
            type: 'gcj02',
            isHighAccuracy: false,
            success: (res) => { clearTimeout(t); resolve(res) },
            fail: (err) => { clearTimeout(t); reject(err) }
          })
        })
      ])
      if (!loc || !loc.latitude || !loc.longitude) return
      const geo = await this.reverseGeocode(loc.latitude, loc.longitude)
      await this.saveLocation({
        lat: loc.latitude,
        lng: loc.longitude,
        province: geo.province || '',
        city: geo.city || '',
        district: geo.district || '',
        street: geo.street || '',
        address: geo.address || geo.full_address || '',
        poi: geo.poi || '',
        visible: this.getLocationVisible()
      })
    } catch (_) {}
  },

  // ============ 全局错误拦截：防止 [] [object Object] 报错 ============
  onError(err) {
    const msg = (typeof err === 'string') ? err : (err && err.message ? err.message : '小程序内部错误')
    try { wx.showToast({ title: String(msg).slice(0, 60), icon: 'none', duration: 2000 }) } catch (_) {}
  },
  onUnhandledRejection(res) {
    const e = res && res.reason
    const msg = (e && (e.msg || e.message)) || '操作失败，请重试'
    try { wx.showToast({ title: String(msg).slice(0, 60), icon: 'none', duration: 2000 }) } catch (_) {}
  },
  safeToast(opt) {
    try {
      const title = this.toStr(opt && opt.title, '')
      if (!title) return
      wx.showToast({ ...opt, title: title.slice(0, 80) })
    } catch (_) {}
  },

  request(options) {
    const { url, method = 'GET', data = {} } = options
    return new Promise((resolve, reject) => {
      const apiBaseBackup = this.globalData.apiBaseBackup || ''
      const timeout = this.globalData.requestTimeout || 15000
      const retry = Math.max(0, Number(this.globalData.requestRetry) || 0)
      const bases = apiBaseBackup ? [this.globalData.apiBase, apiBaseBackup] : [this.globalData.apiBase]
      let attempt = 0
      let lastErr = null
      const tryOnce = (baseOverride) => {
        const base = baseOverride || bases[0]
        const fullUrl = base + url
        const task = wx.request({
          url: fullUrl,
          method,
          data,
          timeout,
          header: {
            'Content-Type': 'application/json',
            'Authorization': this.globalData.token ? 'Bearer ' + this.globalData.token : ''
          },
          success: (res) => {
            if (res.statusCode === 200) {
              if (res.data && Number(res.data.code) === 0) {
                resolve(res.data.data)
              } else {
                const d = (res.data && typeof res.data === 'object') ? res.data : {}
                const code = Number(d.code || res.statusCode) || res.statusCode
                const msg = d.msg || d.message || (code === 401 ? '未登录或登录已过期' : '请求失败')
                const payload = { code, statusCode: res.statusCode, msg, message: msg, data: d.data || {}, raw: d, url: fullUrl }
                if (code === 401 || Number(res.statusCode) === 401) {
                  wx.removeStorageSync('token')
                  wx.removeStorageSync('userInfo')
                  wx.removeStorageSync('coupleInfo')
                  this.globalData.token = ''
                  this.globalData.userInfo = null
                  this.globalData.coupleInfo = null
                  try { wx.reLaunch({ url: '/pages/profile/profile' }) } catch (_) {}
                }
                reject(payload)
              }
            } else {
              const d = (res.data && typeof res.data === 'object') ? res.data : {}
              const code = Number(d.code) || res.statusCode
              const msg = d.msg || d.message || 'HTTP ' + res.statusCode
              // 非HTTP 200响应也需要处理 401（后端返回 HTTP 401 时进入此分支）
              if (code === 401 || res.statusCode === 401) {
                wx.removeStorageSync('token')
                wx.removeStorageSync('userInfo')
                wx.removeStorageSync('coupleInfo')
                this.globalData.token = ''
                this.globalData.userInfo = null
                this.globalData.coupleInfo = null
                try { wx.reLaunch({ url: '/pages/profile/profile' }) } catch (_) {}
              }
              reject({ code, statusCode: res.statusCode, msg, message: msg, data: d.data || {}, raw: d, url: fullUrl, httpErr: true })
            }
          },
          fail: (err) => {
            lastErr = err
            const rawMsg = (err && (err.errMsg || err.message)) + ''
            const netHint = []
            if (/dns/i.test(rawMsg) || /host/i.test(rawMsg)) netHint.push('DNS解析失败，换网络/重启WiFi')
            if (/timeout|timedout|ETIMEDOUT/i.test(rawMsg)) netHint.push('连接超时，换4G/切代理/确认域名可访问')
            if (/tls|ssl|certificate/i.test(rawMsg)) netHint.push('TLS握手失败，真机调试勾选「不校验TLS」')
            if (/refused|ECONNREFUSED/i.test(rawMsg)) netHint.push('后端端口不通/服务未启')
            if (/connection.*(reset|close)|econnreset|EOF/i.test(rawMsg)) netHint.push('链路被重置，运营商拦截workers.dev')
            netHint.push('临时：真机调试扫码前勾选「不校验域名/TLS」')
            const shouldRetry = attempt < retry
            const nextBase = shouldRetry && baseOverride !== bases[bases.length - 1]
              ? bases[(bases.indexOf(baseOverride) + 1) % bases.length]
              : bases[attempt % bases.length]
            if (shouldRetry) {
              attempt += 1
              setTimeout(() => tryOnce(nextBase), 500)
            } else {
              const title = netHint[0] || '网络连接失败'
              try {
                wx.showModal({
                  title: '网络错误',
                  content: [
                    '请求：' + fullUrl,
                    '错误：' + rawMsg,
                    '',
                    '建议：',
                    ...netHint.map(h => '· ' + h)
                  ].filter(Boolean).join('\n'),
                  showCancel: false,
                  confirmText: '知道了'
                })
              } catch (_) {}
              reject({ code: 0, statusCode: 0, msg: title, message: rawMsg || title, errMsg: rawMsg, network: true, url: fullUrl, raw: err })
            }
          }
        })
        return task
      }
      tryOnce(bases[0])
    })
  },

  // ============ 安全工具：防止 wx:for / {{}} 渲染成 [object Object] ============
  toArr(x) {
    if (Array.isArray(x)) return x
    if (!x) return []
    if (typeof x === 'object' && typeof x.length === 'number') {
      try { return Array.prototype.slice.call(x) } catch (_) {}
    }
    if (typeof x[Symbol.iterator] === 'function') {
      try { return Array.from(x) } catch (_) { return [] }
    }
    return []
  },
  toStr(v, fallback = '') {
    if (v === null || v === undefined || v !== v) return fallback  // v!==v 检测 NaN
    const t = typeof v
    if (t === 'string') return v
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v)
    if (t === 'symbol') return fallback
    try {
      if (t === 'object') {
        if (v instanceof Date) return isNaN(v.getTime()) ? fallback : v.toISOString().slice(0,10)
        if (typeof v.toString === 'function' && Object.prototype.toString.call(v) !== '[object Object]') return v.toString() || fallback
        return fallback
      }
    } catch (_) {}
    return fallback
  },

  daysBetween(date1, date2) {
    const d1 = new Date(date1)
    const d2 = new Date(date2)
    return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24))
  },

  formatDate(date, fmt = 'YYYY-MM-DD') {
    const d = new Date(date)
    const o = {
      'YYYY': d.getFullYear(),
      'MM': String(d.getMonth() + 1).padStart(2, '0'),
      'DD': String(d.getDate()).padStart(2, '0'),
      'HH': String(d.getHours()).padStart(2, '0'),
      'mm': String(d.getMinutes()).padStart(2, '0')
    }
    return fmt.replace(/YYYY|MM|DD|HH|mm/g, (k) => o[k])
  },

  // 获取情绪的颜色（单个情绪或合成心情）
  getEmotionColors(name) {
    const n = String(name || '')
    const e = this.globalData.emotionMap[n]
    if (e) return [e.color1, e.color2]
    const m = this.globalData.mergeMeta[n]
    if (m) return [m.color1, m.color2]
    return ['#B0C4DE', '#E6EEF8']
  },

  // 获取情绪/合成心情的展示信息（emoji/text/colors）
  getEmotionMeta(name) {
    const n = String(name || '')
    const e = this.globalData.emotionMap[n]
    if (e) {
      return { name: n, emoji: e.emoji, text: e.text, colors: [e.color1, e.color2], category: e.category }
    }
    const m = this.globalData.mergeMeta[n]
    if (m) {
      return { name: n, emoji: m.emoji, text: m.text, colors: [m.color1, m.color2] }
    }
    // 未知情绪，返回默认
    return { name: n || '等待记录', emoji: '🌤️', text: '#3A4A66', colors: ['#B0C4DE', '#E6EEF8'] }
  },

  // 获取情绪分类
  getEmotionCategory(emotion) {
    const e = this.globalData.emotionMap[emotion]
    return e ? e.category : 'neutral'
  },

  // 合成双方心情
  getMergeMood(a, b) {
    if (!a && !b) return { name: '等待记录', emoji: '🌤️', text: '#3A4A66', colors: ['#B0C4DE', '#E6EEF8'] }
    if (!a || !b) return { name: '等待另一半', emoji: '⏳', text: '#3A4A66', colors: ['#B0C4DE', '#E6EEF8'] }
    let mergeName
    if (a === b) {
      mergeName = '心有灵犀'
    } else {
      const catA = this.getEmotionCategory(a)
      const catB = this.getEmotionCategory(b)
      const key = [catA, catB].sort().join('+')
      const MERGE_MAP = {
        'positive+positive': '甜蜜时刻',
        'neutral+neutral': '岁月静好',
        'negative+negative': '抱抱彼此',
        'neutral+positive': '晴空万里',
        'negative+positive': '冰火两重',
        'negative+neutral': '需要关怀'
      }
      mergeName = MERGE_MAP[key] || '岁月静好'
    }
    const meta = this.globalData.mergeMeta[mergeName]
    return { name: mergeName, emoji: meta.emoji, text: meta.text, colors: [meta.color1, meta.color2] }
  },

  async wxLogin(profileInfo) {
    try {
      const login = await new Promise((resolve, reject) => {
        wx.login({
          success: (r) => r.code ? resolve(r) : reject(new Error('微信登录失败')),
          fail: reject
        })
      })
      const payload = { code: login.code || 'mock-code-' + Date.now() }
      if (profileInfo) {
        payload.nickname = profileInfo.nickName || profileInfo.nickname || ''
        payload.avatar_url = profileInfo.avatarUrl || profileInfo.avatar_url || ''
      }
      const data = await this.request({
        url: '/api/auth/login',
        method: 'POST',
        data: payload
      })
      if (data && data.token) {
        wx.setStorageSync('token', data.token)
        this.globalData.token = data.token
      }
      if (data && data.user) {
        wx.setStorageSync('userInfo', data.user)
        this.globalData.userInfo = data.user
      }
      return data
    } catch (e) {
      throw e
    }
  },

  async updateProfileApi(patch) {
    return await this.request({
      url: '/api/user/update',
      method: 'POST',
      data: patch || {}
    })
  },

  // 把微信临时头像文件转成 base64
  avatarToBase64(tempPath) {
    return new Promise((resolve, reject) => {
      try {
        const fs = wx.getFileSystemManager()
        fs.readFile({
          filePath: tempPath,
          encoding: 'base64',
          success: (r) => resolve('data:image/jpeg;base64,' + r.data),
          fail: reject
        })
      } catch (e) { reject(e) }
    })
  },

  async getWeatherToday() {
    try { return await this.request({ url: '/api/weather/today' }) }
    catch (e) { return null }
  },

  // 真实天气（Open-Meteo 代理）
  async getRealWeather(lat, lon) {
    try {
      return await this.request({ url: '/api/weather/real?lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon) })
    } catch (e) { return null }
  },

  async getCalendar(year, month) {
    try { return await this.request({ url: '/api/calendar/list', data: { year, month } }) }
    catch (e) { return null }
  },

  async getWeatherWeek() {
    try { return await this.request({ url: '/api/weather/week' }) }
    catch (e) { return null }
  },

  async submitMood(payload) {
    return await this.request({
      url: '/api/mood/submit',
      method: 'POST',
      data: payload
    })
  },

  async getMonthlyReport(yyyymm) {
    try {
      let s = String(yyyymm || '').replace(/\D/g, '')
      let qs
      if (s.length >= 6) qs = '?yyyymm=' + encodeURIComponent(s.slice(0, 6))
      else qs = ''
      return await this.request({ url: '/api/report/monthly' + qs })
    }
    catch (e) { return null }
  },

  async getAlertList() {
    try {
      const res = await this.request({ url: '/api/alerts/list' })
      if (Array.isArray(res)) return res
      if (res && Array.isArray(res.list)) return res.list
      return []
    }
    catch (e) { return null }
  },

  // AI 心情日报
  async getAIMoodReport() {
    try { return await this.request({ url: '/api/ai/mood-report' }) }
    catch (e) { return null }
  },

  // AI 情感洞察（最近 7 天）
  async getAIInsight() {
    try { return await this.request({ url: '/api/ai/insight' }) }
    catch (e) { return null }
  },

  async createAlert(payload) {
    return await this.request({ url: '/api/alerts/create', method: 'POST', data: payload })
  },

  async deleteAlert(id) {
    return await this.request({ url: '/api/alerts/delete', method: 'POST', data: { id } })
  },

  async getWishList() {
    try {
      const res = await this.request({ url: '/api/wish/list' })
      if (Array.isArray(res)) return res
      if (res && Array.isArray(res.list)) return res.list
      return []
    }
    catch (e) { return null }
  },

  async saveWish(payload) {
    const p = payload || {}
    const wish_weather = p.wish_weather || p.weather || p.wish || ''
    const reason = p.reason || p.content || p.note || ''
    return await this.request({ url: '/api/wish/save', method: 'POST', data: { wish_weather, reason, status: p.status } })
  },

  async saveLocation(payload) {
    const p = payload || {}
    const lng = p.lng != null ? p.lng : (p.longitude != null ? p.longitude : null)
    const lat = p.lat != null ? p.lat : (p.latitude != null ? p.latitude : null)
    const visible = p.visible != null ? p.visible : p.visible_to_ta
    return await this.request({
      url: '/api/location/update',
      method: 'POST',
      data: {
        lng, lat,
        longitude: lng,
        latitude: lat,
        province: p.province || '',
        city: p.city || '',
        district: p.district || '',
        street: p.street || '',
        address: p.address || p.full_address || '',
        poi: p.poi || '',
        visible,
        visible_to_ta: visible
      }
    })
  },

  async getLocationSnap() {
    try { return await this.request({ url: '/api/location/latest' }) }
    catch (e) { return null }
  },

  // 获取情侣双方位置
  async getCoupleLocation() {
    try { return await this.request({ url: '/api/location/couple' }) }
    catch (e) { return { me: null, ta: null } }
  },

  // 尝试获取真实天气：先读已有位置快照，没有就尝试 wx.getLocation
  async fetchRealWeather() {
    try {
      const snap = await this.getLocationSnap()
      if (snap && snap.lat && snap.lng) {
        const rw = await this.getRealWeather(snap.lat, snap.lng)
        if (rw) return { ...rw, source: 'snapshot' }
      }
    } catch (_) {}

    // 没有位置快照时尝试获取当前位置
    try {
      const loc = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 8000)
        wx.getLocation({
          type: 'gcj02',
          success: (res) => { clearTimeout(t); resolve(res) },
          fail: (err) => { clearTimeout(t); reject(err) }
        })
      })
      if (loc && loc.latitude && loc.longitude) {
        const rw = await this.getRealWeather(loc.latitude, loc.longitude)
        // 顺手把位置保存到后端
        try { await this.saveLocation({ lat: loc.latitude, lng: loc.longitude, visible: true }) } catch (_) {}
        if (rw) return { ...rw, source: 'gps' }
      }
    } catch (_) {}

    return null
  },

  // 从地址中解析出区/县级别名称
  getDistrictLabel(item) {
    if (!item) return ''
    const d = this.toStr(item.district, '')
    if (/^.+[区县]$/.test(d) && !/小区$/.test(d)) return d
    const city = this.toStr(item.city, '')
    if (/^.+[区县]$/.test(city) && !/小区$/.test(city)) return city
    const addr = this.toStr(item.address || item.full_address, '')
    if (addr) {
      const parts = addr.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      for (let i = parts.length - 1; i >= 0; i--) {
        const s = parts[i]
        if (/^.+[区县]$/.test(s) && !/小区$/.test(s)) return s
      }
    }
    return d || city || '位置'
  },

  // 获取双方真实天气
  async fetchCoupleWeather() {
    try {
      const loc = await this.getCoupleLocation()
      const meLoc = loc && loc.me
      const taLoc = loc && loc.ta
      if (!meLoc && !taLoc) return null

      const load = async (l) => {
        if (!l || !l.lat || !l.lng) return null
        const w = await this.getRealWeather(l.lat, l.lng)
        if (!w) return null
        let address = l.address || l.full_address || ''
        let city = l.city || ''
        let district = l.district || ''
        let province = l.province || ''
        let street = l.street || ''
        let poi = l.poi || ''
        // 若坐标存在但地址文本缺失，自动反解析并补存
        if (!city && !district && !address) {
          try {
            const geo = await this.reverseGeocode(l.lat, l.lng)
            province = geo.province || ''
            city = geo.city || ''
            district = geo.district || ''
            street = geo.street || ''
            poi = geo.poi || ''
            address = geo.address || geo.full_address || ''
            // 顺手补存后端，下次不用反解析
            this.saveLocation({ lat: l.lat, lng: l.lng, province, city, district, street, poi, address, visible: l.visible !== false }).catch(() => {})
          } catch (_) {}
        }
        const item = { ...w, lat: l.lat, lng: l.lng, address, city, district, province, street, poi }
        item.displayDistrict = this.getDistrictLabel(item)
        return item
      }

      const [me, ta] = await Promise.all([load(meLoc), load(taLoc)])
      return { me, ta }
    } catch (e) { return null }
  },

  // 获取预报详情（24小时+7天）
  async getWeatherForecast(lat, lon) {
    try {
      return await this.request({ url: '/api/weather/real/forecast?lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon) })
    } catch (e) { return null }
  },

  async reverseGeocode(lat, lng) {
    try {
      const url = '/api/location/reverse?lat=' + encodeURIComponent(lat) + '&lng=' + encodeURIComponent(lng)
      const res = await this.request({ url })
      return res || { province: '', city: '', district: '', street: '', address: '', full_address: '' }
    }
    catch (e) {
      return { province: '', city: '', district: '', street: '', address: '', full_address: '' }
    }
  },

  // 地址 → 经纬度（用户手动输入城市/地址）
  async searchLocation(address) {
    return await this.request({
      url: '/api/location/search',
      method: 'POST',
      data: { address }
    })
  },

  // 静态地图图片地址（后端生成 SVG）
  getMapImageUrl(ts) {
    const base = this.globalData.apiBase || ''
    const token = wx.getStorageSync('token') || ''
    return base + '/api/location/map?_t=' + (ts || Date.now()) + '&token=' + encodeURIComponent(token)
  },

  async getMonthlyReport(yyyymm) {
    try {
      let s = String(yyyymm || '').replace(/\D/g, '')
      let qs
      if (s.length >= 6) qs = '?yyyymm=' + encodeURIComponent(s.slice(0, 6))
      else qs = ''
      return await this.request({ url: '/api/report/monthly' + qs })
    }
    catch (e) { return null }
  },
  async getBindInfo() {
    try { return await this.request({ url: '/api/couple/info' }) }
    catch (e) { return null }
  },

  async bindInviteCode(code) {
    return await this.request({ url: '/api/couple/bind', method: 'POST', data: { invite_code: code } })
  },

  async respondBind(action) {
    return await this.request({ url: '/api/couple/respond', method: 'POST', data: { action } })
  },

  async unbindCouple() {
    return await this.request({ url: '/api/couple/unbind', method: 'POST', data: {} })
  },

  async getProfileKpi() {
    try { return await this.request({ url: '/api/user/kpi' }) }
    catch (e) { return null }
  },

  async getWxacode(scene, page) {
    try {
      let qs = ''
      if (scene) qs += '?scene=' + encodeURIComponent(scene)
      if (page) qs += (qs ? '&' : '?') + 'page=' + encodeURIComponent(page)
      const res = await this.request({ url: '/api/wxacode' + qs })
      return res && res.base64 ? res.base64 : null
    } catch (e) { return null }
  },

  // ============ 心动会员 · 虚拟支付（个人主体 · 道具直购） ============
  // 会员状态 + 套餐 + 支付模式（sandbox=沙盒模拟支付 / wechat=微信虚拟支付）
  async getVipInfo() {
    try { return await this.request({ url: '/api/vip/info' }) }
    catch (e) { return null }
  },

  // 创建会员订单（code 为 wx.login 新 code，真实模式下后端用它刷新 session_key 做用户态签名）
  async createPayOrder(tier, code) {
    return await this.request({ url: '/api/pay/create', method: 'POST', data: { tier, code: code || '' } })
  },

  // 沙盒模拟支付完成确认
  async confirmPay(outTradeNo) {
    return await this.request({ url: '/api/pay/confirm', method: 'POST', data: { out_trade_no: outTradeNo } })
  },

  // 真实支付兜底查单：支付 success 回调后调用，服务端向微信 query_order 查证并发货
  async queryPayOrder(outTradeNo) {
    return await this.request({ url: '/api/pay/query', method: 'POST', data: { out_trade_no: outTradeNo } })
  },

  // 购买记录
  async getVipOrders() {
    try { return await this.request({ url: '/api/vip/orders' }) }
    catch (e) { return null }
  },
})
