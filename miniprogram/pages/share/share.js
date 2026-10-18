const app = getApp()

Page({
  data: {
    dateStr: '',
    activeStyle: 0,
    togetherDays: 0,
    myWeather: '等待记录',
    taWeather: '等待记录',
    weatherName: '等待记录',
    weatherEmoji: '⛅',
    quote: '愿我们的心情，永远有彩虹。',
    myAvatar: '',
    myAvatarError: false,
    myName: '我',
    myInitial: '我',
    taAvatar: '',
    taAvatarError: false,
    taName: 'TA',
    taInitial: 'T',
    qrBase64: '',
    qrPlaceholderText: '情侣心情录',
    taRating: 0,
    tempPoster: '',
    generating: false,
    inviteCode: '',
    styles: [
      { name: '暖阳', previewEmoji: '☀️', bg1: '#FFD27A', bg2: '#FFF1C2', bg3: '#FFF8E1', ink: '#7A4A00', muted: 'rgba(122, 74, 0, 0.55)', quote: 'rgba(122, 74, 0, 0.82)', splitBg: 'rgba(122, 74, 0, 0.25)', divider: 'rgba(122, 74, 0, 0.25)', watermark: 'rgba(122, 74, 0, 0.65)', qrBg: '#7A4A00', qrText: '#FFE8A8' },
      { name: '夜空', previewEmoji: '🌙', bg1: '#2D2A45', bg2: '#53547A', bg3: '#6C5CE7', ink: '#FFFFFF', muted: 'rgba(255, 255, 255, 0.55)', quote: 'rgba(255, 255, 255, 0.92)', splitBg: 'rgba(255, 255, 255, 0.25)', divider: 'rgba(255, 255, 255, 0.22)', watermark: 'rgba(255, 255, 255, 0.7)', qrBg: '#FFFFFF', qrText: '#53547A' },
      { name: '彩虹', previewEmoji: '🌈', bg1: '#FF8FAB', bg2: '#FFD6A5', bg3: '#C8B6FF', ink: '#5A1D36', muted: 'rgba(90, 29, 54, 0.5)', quote: 'rgba(90, 29, 54, 0.85)', splitBg: 'rgba(90, 29, 54, 0.2)', divider: 'rgba(90, 29, 54, 0.22)', watermark: 'rgba(90, 29, 54, 0.6)', qrBg: '#5A1D36', qrText: '#FFD6E8' },
      { name: '薄雾', previewEmoji: '☁️', bg1: '#D6E3F0', bg2: '#EFF3F7', bg3: '#F8F6F0', ink: '#2A3A4E', muted: 'rgba(42, 58, 78, 0.5)', quote: 'rgba(42, 58, 78, 0.82)', splitBg: 'rgba(42, 58, 78, 0.2)', divider: 'rgba(42, 58, 78, 0.2)', watermark: 'rgba(42, 58, 78, 0.6)', qrBg: '#2A3A4E', qrText: '#EFF3F7' },
      { name: '樱花', previewEmoji: '🌸', bg1: '#FFE4EC', bg2: '#FFF0F5', bg3: '#F8F0FF', ink: '#8B3A62', muted: 'rgba(139, 58, 98, 0.5)', quote: 'rgba(139, 58, 98, 0.85)', splitBg: 'rgba(139, 58, 98, 0.2)', divider: 'rgba(139, 58, 98, 0.2)', watermark: 'rgba(139, 58, 98, 0.6)', qrBg: '#8B3A62', qrText: '#FFE4EC' },
      { name: '海蓝', previewEmoji: '🌊', bg1: '#A8C5E6', bg2: '#CDE0F0', bg3: '#E6F0F8', ink: '#1F3A52', muted: 'rgba(31, 58, 82, 0.5)', quote: 'rgba(31, 58, 82, 0.85)', splitBg: 'rgba(31, 58, 82, 0.2)', divider: 'rgba(31, 58, 82, 0.2)', watermark: 'rgba(31, 58, 82, 0.6)', qrBg: '#1F3A52', qrText: '#CDE0F0' }
    ]
  },

  onLoad() {
    this.refreshCardData()
  },

  onShow() {
    this.refreshCardData()
  },

  async refreshCardData() {
    const dateStr = app.formatDate(new Date(), 'MM月DD日') + ' · ' + ['周日','周一','周二','周三','周四','周五','周六'][new Date().getDay()]
    this.setData({ dateStr })

    const userInfo = wx.getStorageSync('userInfo') || {}
    const coupleInfo = wx.getStorageSync('coupleInfo') || {}
    let togetherDays = 0
    if (coupleInfo.bind_date) togetherDays = app.daysBetween(coupleInfo.bind_date, new Date()) + 1

    const weather = await app.getWeatherToday() || {}
    const couple = (await app.getBindInfo()) || {}

    const myWeather = (weather.my_mood && weather.my_mood.weather) || '等待记录'
    const taWeather = (weather.ta_mood && weather.ta_mood.weather) || '等待记录'
    const weatherName = weather.shared_name || '等待记录'
    const meta = app.getEmotionMeta(weatherName)
    const weatherEmoji = meta.emoji
    const taRating = Number(weather.ta_rating || 0) || 0
    const quotes = app.globalData.quotes || []
    const quote = weather.shared_quote || quotes[Math.floor(Math.random() * quotes.length)] || ''

    const myName = userInfo.nickname || '我'
    const taName = (couple.ta_info && couple.ta_info.nickname) || 'TA'
    const inviteCode = couple.my_code || couple.invite_code || ''
    let qrBase64 = inviteCode ? await app.getWxacode('invite=' + inviteCode, 'pages/bind/bind') : ''
    let qrPlaceholderText = '情侣心情录'
    if (inviteCode && !qrBase64) {
      // 小程序未发布时无法生成小程序码，先显示邀请码占位
      console.log('小程序码生成失败，使用邀请码占位')
      qrPlaceholderText = '邀请码\n' + inviteCode
    }
    // 头像 URL 如果是相对路径，拼接完整 URL
    const fixUrl = (u) => {
      if (!u) return ''
      if (/^https?:\/\//.test(u)) return u
      if (/^\/api\//.test(u)) return 'https://api.jdhsf.top' + u
      return u
    }
    this.setData({
      togetherDays,
      myWeather,
      taWeather,
      weatherName,
      weatherEmoji,
      taRating,
      quote,
      myAvatar: fixUrl(userInfo.avatar_url || ''),
      myName,
      myInitial: myName.slice(0, 1),
      taAvatar: fixUrl((couple.ta_info && couple.ta_info.avatar_url) || ''),
      taName,
      taInitial: taName.slice(0, 1),
      qrBase64,
      qrPlaceholderText,
      inviteCode
    })
    this.setData({ tempPoster: '' })
  },

  onAvatarError(e) {
    const side = e.currentTarget.dataset.side
    if (side === 'my' || side === 'ta') {
      this.setData({ [side + 'AvatarError']: true })
    }
  },

  base64ToTempFile(base64) {
    return new Promise((resolve, reject) => {
      if (!base64 || !base64.includes(',')) return reject(new Error('invalid base64'))
      const fs = wx.getFileSystemManager()
      const filePath = `${wx.env.USER_DATA_PATH}/wxacode_${Date.now()}.png`
      try {
        fs.writeFileSync(filePath, base64.split(',')[1], 'base64')
        resolve(filePath)
      } catch (e) { reject(e) }
    })
  },

  pickStyle(e) {
    this.setData({ activeStyle: Number(e.currentTarget.dataset.idx) || 0, tempPoster: '' })
  },

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  },

  async ensurePoster() {
    if (this.data.tempPoster && !this.data.generating) return this.data.tempPoster
    if (this.data.generating) {
      await new Promise((r) => setTimeout(r, 300))
      return this.ensurePoster()
    }
    this.setData({ generating: true })
    wx.showLoading({ title: '海报生成中…', mask: true })
    try {
      const query = wx.createSelectorQuery()
      const nodeRes = await new Promise((resolve, reject) => {
        query.select('#shareCanvas').fields({ node: true, size: true }).exec((res) => {
          if (res && res[0]) resolve(res[0])
          else reject(new Error('canvas 未就绪'))
        })
      })
      const canvas = nodeRes.node
      const ctx = canvas.getContext('2d')
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const dpr = win.pixelRatio || 2
      const W = 750, H = 1200
      canvas.width = W * dpr
      canvas.height = H * dpr
      ctx.scale(dpr, dpr)

      const s = this.data.styles[this.data.activeStyle]
      const grad = ctx.createLinearGradient(0, 0, W, H)
      grad.addColorStop(0, s.bg1)
      grad.addColorStop(0.6, s.bg2)
      grad.addColorStop(1, s.bg3)
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, W, H)

      ctx.save()
      ctx.globalAlpha = 0.28
      const r1 = ctx.createRadialGradient(W + 40, -40, 20, W + 40, -40, 320)
      r1.addColorStop(0, '#FFFFFF')
      r1.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = r1
      ctx.fillRect(0, 0, W, H)
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = 0.22
      const r2 = ctx.createRadialGradient(-40, H + 40, 20, -40, H + 40, 280)
      r2.addColorStop(0, '#FFFFFF')
      r2.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = r2
      ctx.fillRect(0, 0, W, H)
      ctx.restore()

      ctx.fillStyle = s.muted
      ctx.font = '700 22px "PingFang SC", sans-serif'
      ctx.fillText('情侣心情录 · 情侣气象站', 56, 88)

      ctx.fillStyle = s.ink
      ctx.font = '700 28px "PingFang SC", sans-serif'
      const dateText = this.data.dateStr + (this.data.togetherDays ? (' · 第 ' + this.data.togetherDays + ' 天') : '')
      const dateW = ctx.measureText(dateText).width
      ctx.fillText(dateText, W - 56 - dateW, 88)

      ctx.fillStyle = s.ink
      ctx.font = '800 44px "PingFang SC", sans-serif'
      const nameText = this.data.weatherName || '等待记录'
      const nameW = ctx.measureText(nameText).width
      ctx.fillText(nameText, (W - nameW) / 2, 230)

      ctx.font = '200px sans-serif'
      const emoji = this.data.weatherEmoji || '⛅'
      const emojiW = ctx.measureText(emoji).width
      ctx.fillText(emoji, (W - emojiW) / 2, 460)

      const quote = this.data.quote || ''
      const rawLines = (quote || '愿我们的心情，永远有彩虹').split('\n').slice(0, 3)
      ctx.fillStyle = s.quote
      ctx.font = 'italic 500 30px "PingFang SC", sans-serif'
      const qx = W / 2
      let qy = 600
      rawLines.forEach((ln) => {
        const line = ('“' + ln + '”').slice(0, 32)
        const lw = ctx.measureText(line).width
        ctx.fillText(line, qx - lw / 2, qy)
        qy += 46
      })

      ctx.save()
      ctx.globalAlpha = 0.4
      ctx.fillStyle = s.splitBg
      ctx.fillRect(120, 820, W - 240, 2)
      ctx.restore()

      const drawAvatar = (x, y, url, label, wname, sideText) => new Promise((resolve) => {
        ctx.fillStyle = s.ink
        ctx.font = '600 24px "PingFang SC", sans-serif'
        ctx.fillText(sideText, x, y - 8)

        const avR = 56
        ctx.save()
        this.roundRect(ctx, x - avR, y - avR, avR * 2, avR * 2, 20)
        ctx.clip()
        if (url) {
          const img = canvas.createImage()
          const t0 = setTimeout(() => {
            try {
              ctx.fillStyle = s.qrBg
              ctx.fillRect(x - avR, y - avR, avR * 2, avR * 2)
              ctx.fillStyle = s.qrText
              ctx.font = '700 32px sans-serif'
              const t = (label || '?').slice(0, 1)
              const tw = ctx.measureText(t).width
              ctx.fillText(t, x - tw / 2, y + 12)
            } catch (e) {}
            try { ctx.restore() } catch (e) {}
            resolve()
          }, 4000)
          img.onload = () => {
            clearTimeout(t0)
            try { ctx.drawImage(img, x - avR, y - avR, avR * 2, avR * 2) } catch (e) {}
            try { ctx.restore() } catch (e) {}
            resolve()
          }
          img.onerror = () => {
            clearTimeout(t0)
            try {
              ctx.fillStyle = s.qrBg
              ctx.fillRect(x - avR, y - avR, avR * 2, avR * 2)
              ctx.fillStyle = s.qrText
              ctx.font = '700 32px sans-serif'
              const t = (label || '?').slice(0, 1)
              const tw = ctx.measureText(t).width
              ctx.fillText(t, x - tw / 2, y + 12)
            } catch (e) {}
            try { ctx.restore() } catch (e) {}
            resolve()
          }
          try { img.src = url } catch (e) { clearTimeout(t0); try { ctx.restore() } catch (err) {}; resolve() }
        } else {
          ctx.fillStyle = s.qrBg
          ctx.fillRect(x - avR, y - avR, avR * 2, avR * 2)
          ctx.fillStyle = s.qrText
          ctx.font = '700 32px sans-serif'
          const t = (label || '?').slice(0, 1)
          const tw = ctx.measureText(t).width
          ctx.fillText(t, x - tw / 2, y + 12)
          ctx.restore()
          resolve()
          return
        }

        setTimeout(() => {
          try {
            ctx.save()
            this.roundRect(ctx, x - avR - 4, y - avR - 4, avR * 2 + 8, avR * 2 + 8, 22)
            ctx.globalAlpha = 0.3
            ctx.strokeStyle = s.qrBg
            ctx.lineWidth = 6
            ctx.stroke()
            ctx.restore()

            ctx.fillStyle = s.ink
            ctx.font = '700 26px "PingFang SC", sans-serif'
            const ww = ctx.measureText(wname || '').width
            ctx.fillText(wname || '', x - ww / 2, y + avR + 40)
          } catch (e) {}
        }, 50)
      })

      const leftX = 180, rightX = W - 180, avY = 950
      await drawAvatar(leftX, avY, this.data.myAvatar, this.data.myName, this.data.myWeather, '我 · ' + this.data.myName)
      await drawAvatar(rightX, avY, this.data.taAvatar, this.data.taName, this.data.taWeather, 'TA · ' + this.data.taName)

      ctx.save()
      ctx.globalAlpha = 0.3
      ctx.fillStyle = s.divider
      ctx.fillRect(W / 2 - 1, avY - 90, 2, 180)
      ctx.restore()

      if (this.data.taRating > 0) {
        ctx.fillStyle = s.ink
        ctx.font = '700 26px "PingFang SC", sans-serif'
        ctx.fillText('TA ⭐ x ' + this.data.taRating, 56, 1060)
      }

      ctx.fillStyle = s.watermark
      ctx.font = '600 22px "PingFang SC", sans-serif'
      ctx.fillText('情侣心情录 · 我们俩的私人心情台', 56, H - 72)

      ctx.save()
      this.roundRect(ctx, W - 56 - 140, H - 56 - 140, 140, 140, 20)
      ctx.clip()
      if (this.data.qrBase64) {
        try {
          const qrPath = await this.base64ToTempFile(this.data.qrBase64)
          const qrImg = canvas.createImage()
          await new Promise((resolve) => {
            const t0 = setTimeout(() => resolve(), 3000)
            qrImg.onload = () => { clearTimeout(t0); resolve() }
            qrImg.onerror = () => { clearTimeout(t0); resolve() }
            qrImg.src = qrPath
          })
          try { ctx.drawImage(qrImg, W - 56 - 140, H - 56 - 140, 140, 140) } catch (e) {}
        } catch (e) {
          ctx.fillStyle = s.qrBg
          ctx.fillRect(0, 0, W, H)
        }
      } else {
        ctx.fillStyle = s.qrBg
        ctx.fillRect(0, 0, W, H)
        ctx.fillStyle = s.qrText
        ctx.font = '700 24px "PingFang SC", sans-serif'
        const phLines = (this.data.qrPlaceholderText || '情侣心情录').split('\n')
        const lineY = H - 56 - 140 + (140 - phLines.length * 30) / 2 + 24
        phLines.forEach((ln, idx) => {
          const lw = ctx.measureText(ln).width
          ctx.fillText(ln, W - 56 - 140 + (140 - lw) / 2, lineY + idx * 30)
        })
      }
      ctx.restore()

      // 在二维码下方绘制邀请码文字
      if (this.data.inviteCode) {
        ctx.fillStyle = s.muted
        ctx.font = '500 16px "PingFang SC", sans-serif'
        const codeText = '邀请码 ' + this.data.inviteCode
        const codeW = ctx.measureText(codeText).width
        const qrCenterX = W - 56 - 70
        ctx.fillText(codeText, qrCenterX - codeW / 2, H - 56 + 20)
      }

      const tempFile = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas,
          fileType: 'png',
          quality: 1,
          success: (r) => resolve(r.tempFilePath),
          fail: reject
        })
      })
      this.setData({ tempPoster: tempFile, generating: false })
      wx.hideLoading()
      return tempFile
    } catch (e) {
      this.setData({ generating: false })
      wx.hideLoading()
      throw e
    }
  },

  async saveImage() {
    try {
      const tempFile = await this.ensurePoster()
      const doSave = () => {
        wx.saveImageToPhotosAlbum({
          filePath: tempFile,
          success: () => {
            wx.showToast({ title: '已保存到相册 💾', icon: 'success' })
          },
          fail: (err) => {
            const msg = String((err && err.errMsg) || '')
            if (msg.indexOf('auth') >= 0 || msg.indexOf('denied') >= 0 || msg.indexOf('authorize') >= 0) {
              wx.showModal({
                title: '需要相册权限',
                content: '保存海报需要相册写入权限，请点击「去设置」打开后再保存哦～',
                confirmText: '去设置',
                confirmColor: '#FF8FAB',
                success: (r) => { if (r.confirm) wx.openSetting() }
              })
            } else if (msg.indexOf('cancel') >= 0) {
              wx.showToast({ title: '已取消', icon: 'none' })
            } else {
              wx.showToast({ title: '保存失败，重试一下', icon: 'none' })
            }
          }
        })
      }
      const authRes = await new Promise((resolve) => wx.getSetting({ success: resolve, fail: () => resolve({ authSetting: {} }) }))
      if (authRes.authSetting && authRes.authSetting['scope.writePhotosAlbum'] === false) {
        wx.showModal({
          title: '相册权限被禁用',
          content: '请到设置里打开「保存到相册」权限后重试～',
          confirmText: '去设置',
          confirmColor: '#FF8FAB',
          success: (r) => {
            if (r.confirm) {
              wx.openSetting({
                success: (res) => {
                  if (res.authSetting && res.authSetting['scope.writePhotosAlbum']) doSave()
                }
              })
            }
          }
        })
        return
      }
      wx.authorize({
        scope: 'scope.writePhotosAlbum',
        success: () => doSave(),
        fail: () => {
          wx.showModal({
            title: '需要相册权限',
            content: '允许保存到相册，就可以把海报发给 TA 啦～',
            confirmText: '去设置',
            confirmColor: '#FF8FAB',
            success: (r) => { if (r.confirm) wx.openSetting({ success: () => doSave() }) }
          })
        }
      })
    } catch (e) {
      wx.showToast({ title: (e && (e.msg || e.message)) || '生成失败，重试一下', icon: 'none' })
    }
  },

  async onShareAppMessage(res) {
    const userInfo = wx.getStorageSync('userInfo') || {}
    const coupleInfo = wx.getStorageSync('coupleInfo') || {}
    const nick = userInfo.nickname || '有人'
    const daysText = coupleInfo.bind_date ? ('已经在一起 ' + (app.daysBetween(coupleInfo.bind_date, new Date()) + 1) + ' 天啦') : '邀请你加入情侣心情录'
    let imageUrl = ''
    try { imageUrl = await this.ensurePoster() } catch (e) {}
    return {
      title: '🌈 情侣心情录｜' + nick + '和你的私人心情台 · ' + daysText,
      path: '/pages/profile/profile',
      imageUrl: imageUrl || ''
    }
  },

  async onShareTimeline() {
    let imageUrl = ''
    try { imageUrl = await this.ensurePoster() } catch (e) {}
    return {
      title: '情侣心情录 · 把每天的心情变成属于你们的心情 🌤️',
      imageUrl: imageUrl || ''
    }
  }
})
