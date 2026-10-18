Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '心情', emoji: '🌤️' },
      { pagePath: '/pages/calendar/calendar', text: '日历', emoji: '📅' },
      { pagePath: '/pages/profile/profile', text: '我的', emoji: '💜' }
    ]
  },
  methods: {
    switchTab(e) {
      try {
        const { idx, path } = e.currentTarget.dataset || {}
        if (typeof idx === 'number') {
          this.setData({ selected: idx })
        }
        if (path) {
          wx.switchTab({
            url: path,
            fail: function () {
              try { wx.reLaunch({ url: path }) } catch (err) {}
            }
          })
        }
      } catch (err) {}
    }
  }
})
