const app = getApp()

Page({
  data: {
    loading: true,
    questions: [],
    answers: {},
    customAnswers: {},
    currentIndex: 0,
    currentQuestion: {},
    currentAnswer: '',
    customMode: false,
    customAnswer: '',
    isLast: false,
    answeredCount: 0,
    finished: false,
    needWait: false,
    score: 0,
    comment: '',
    result: [],
    tip: ''
  },

  onLoad() {
    this.loadToday()
  },

  updateComputed(dataPatch) {
    const idx = dataPatch.currentIndex !== undefined ? dataPatch.currentIndex : this.data.currentIndex
    const questions = dataPatch.questions !== undefined ? dataPatch.questions : this.data.questions
    const answers = dataPatch.answers !== undefined ? dataPatch.answers : this.data.answers
    const customAnswers = dataPatch.customAnswers !== undefined ? dataPatch.customAnswers : this.data.customAnswers
    const q = questions[idx] || {}
    dataPatch.currentQuestion = q
    const savedAnswer = q.id ? (answers[q.id] || '') : ''
    const savedCustom = q.id ? (customAnswers[q.id] || '') : ''
    // 如果已保存的答案不在选项里，说明是自定义答案
    const isCustom = !!(q.id && savedAnswer && !q.options.includes(savedAnswer))
    dataPatch.customMode = isCustom
    dataPatch.customAnswer = isCustom ? (savedCustom || savedAnswer) : ''
    dataPatch.currentAnswer = isCustom ? '' : savedAnswer
    dataPatch.isLast = idx === questions.length - 1
    dataPatch.answeredCount = Object.keys(answers).length
  },

  async loadToday() {
    this.setData({ loading: true, finished: false, needWait: false, tip: '' })
    try {
      const res = await app.request({ url: '/api/quiz/today' })
      if (!res || !res.questions) {
        this.setData({ loading: false, tip: '今日题目加载失败，请稍后重试' })
        return
      }
      const questions = res.questions || []
      if (!questions.length) {
        this.setData({ loading: false, tip: '今天暂时没有题目，稍后再来看看吧' })
        return
      }
      // 如果自己已经答完，直接看结果
      if (res.my_finished) {
        this.loadResult()
        return
      }
      const patch = { loading: false, questions, currentIndex: 0, answers: {} }
      this.updateComputed(patch)
      this.setData(patch)
    } catch (e) {
      const msg = (e && (e.msg || e.message)) || '加载失败'
      this.setData({ loading: false, tip: msg })
    }
  },

  async loadResult() {
    this.setData({ loading: true })
    try {
      const res = await app.request({ url: '/api/quiz/result' })
      if (!res) {
        this.setData({ loading: false, tip: '结果加载失败' })
        return
      }
      if (!res.finished) {
        this.setData({ loading: false, finished: false, needWait: true })
        return
      }
      this.setData({
        loading: false,
        finished: true,
        needWait: false,
        score: res.score || 0,
        comment: res.comment || '',
        result: app.toArr(res.result)
      })
    } catch (e) {
      const msg = (e && (e.msg || e.message)) || '结果加载失败'
      this.setData({ loading: false, tip: msg })
    }
  },

  selectOption(e) {
    const value = e.currentTarget.dataset.value
    const qid = this.data.currentQuestion.id
    if (!qid) return
    const patch = { [`answers.${qid}`]: value, [`customAnswers.${qid}`]: '' }
    this.updateComputed(patch)
    this.setData(patch)
  },

  toggleCustom() {
    const qid = this.data.currentQuestion.id
    if (!qid) return
    if (this.data.customMode) {
      // 取消自定义，清空答案
      const patch = { [`answers.${qid}`]: '', [`customAnswers.${qid}`]: '', customMode: false, customAnswer: '' }
      this.updateComputed(patch)
      this.setData(patch)
    } else {
      const patch = { customMode: true, customAnswer: '', [`answers.${qid}`]: '', [`customAnswers.${qid}`]: '' }
      this.updateComputed(patch)
      this.setData(patch)
    }
  },

  onCustomInput(e) {
    const value = e.detail.value.trim()
    const qid = this.data.currentQuestion.id
    if (!qid) return
    const patch = { customAnswer: value, [`answers.${qid}`]: value, [`customAnswers.${qid}`]: value }
    this.updateComputed(patch)
    this.setData(patch)
  },

  prevQuestion() {
    if (this.data.currentIndex > 0) {
      const patch = { currentIndex: this.data.currentIndex - 1 }
      this.updateComputed(patch)
      this.setData(patch)
    }
  },

  async nextQuestion() {
    const qid = this.data.currentQuestion.id
    const ans = this.data.answers[qid]
    if (!ans) {
      if (this.data.customMode) {
        wx.showToast({ title: '请输入自定义答案', icon: 'none' })
      }
      return
    }
    try {
      await app.request({
        url: '/api/quiz/answer',
        method: 'POST',
        data: { question_id: qid, answer: ans }
      })
    } catch (e) {
      wx.showToast({ title: '提交失败', icon: 'none' })
      return
    }

    if (this.data.isLast) {
      // 全部答完，检查 TA 是否也答完
      const checkRes = await app.request({ url: '/api/quiz/today' })
      if (checkRes && checkRes.ta_finished) {
        this.loadResult()
      } else {
        this.setData({ needWait: true, finished: false, loading: false })
      }
    } else {
      const patch = { currentIndex: this.data.currentIndex + 1 }
      this.updateComputed(patch)
      this.setData(patch)
    }
  },

  goHistory() {
    // 历史页面可以后续单独做，这里先 toast 提示
    wx.showToast({ title: '历史功能稍后上线', icon: 'none' })
  },

  goBack() {
    wx.switchTab({ url: '/pages/profile/profile' })
  }
})
