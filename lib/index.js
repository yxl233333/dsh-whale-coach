/**
 * dsh-whale-coach —— 旁听小助手（不替她说话）
 *
 * 干两件事：
 *   1) 陪读：每 N 轮（至少间隔 45 秒）看一眼最近的对话，判断「现在适不适合开口」。
 *      适合就往她的会话里塞一条【旁听】提示，让她自己决定要不要发语音——台词她自己写，
 *      走 qq-bridge 现成的【语音】通道。
 *   2) 记录：把每轮聊了什么滚动写进 whale-context-digest.md，每几轮压成 brief；
 *      上下文攒到阈值时递一条【满上下文提示】，让她自己跟主人说一声（不自动换会话）。
 *
 * 所有模型调用都用最便宜的 flash；失败一律静默。
 *
 * @module dsh-whale-coach
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-whale-coach'
export const inject = ['agents', 'llm', 'webServer', 'sessions']

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(HOME, 'storages', 'whale-coach')
const STATE_FILE = path.join(DIR, 'state.json')
const DIGEST_FILE = path.join(HOME, 'whale-context-digest.md')
const BRIEF_FILE = path.join(HOME, 'whale-context-brief.md')
const ROUTE = '/whale-coach'

const DEFAULTS = {
  enabled: true,
  roundsPerJudge: 5,      // 至少攒够几轮才判一次
  minGapSec: 45,          // 两次判断的最小间隔
  windowMessages: 12,     // 判断时带多少条最近消息
  voiceMinGapSec: 600,    // 两条语音之间至少隔多久
  voiceMaxPerHour: 3,     // 每小时最多提醒几次
  stickerMinGapSec: 240,  // 两次表情提醒之间至少隔多久
  stickerMaxPerHour: 6,   // 每小时最多提醒几次表情
  contextFullTokens: 800000,  // 上下文用到多少 token 算「快满了」（1M 窗口的 80%）
  provider: '',
  model: '',
  sessionId: '',   // 只盯这间会话；留空 = 自动读 qq-bridge 绑定的会话
}

/** 群里没 @ 她的那些话，qq-bridge 会拼成这种前缀；这类不计入轮次 */
const 群杂音前缀 = ['（群聊｜刚才群里在说', '（群里刚才别人在说']

function loadConfig(raw) {
  return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
}

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }) } catch { /* ignore */ }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (raw && typeof raw === 'object') return raw
  } catch { /* first run */ }
  return {}
}

function saveState(state) {
  ensureDir()
  try {
    const tmp = STATE_FILE + '.' + crypto.randomUUID() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, STATE_FILE)
  } catch { /* ignore */ }
}

function textOf(message) {
  if (!message) return ''
  const candidates = [message, message.message, message.data, message.payload].filter(Boolean)
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    const content = candidate.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (Array.isArray(content)) {
      const parts = []
      for (const block of content) {
        if (!block) continue
        if (typeof block === 'string') { parts.push(block); continue }
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      const joined = parts.join('').trim()
      if (joined) return joined
    }
    if (typeof candidate.text === 'string' && candidate.text.trim()) return candidate.text.trim()
  }
  return ''
}

function tokensOf(event) {
  try {
    const data = event && (event.data || event.payload)
    if (!data) return 0
    const candidates = [data.usage, data.message && data.message.usage]
    for (const usage of candidates) {
      if (!usage) continue
      // ⚠️ inputTokens 只是「未命中缓存」的那部分，真正的 prompt 还要加上 cacheRead/cacheWrite
      const total = Number(usage.inputTokens || 0) + Number(usage.cacheReadTokens || 0) + Number(usage.cacheWriteTokens || 0)
      if (total > 0) return total
    }
  } catch { /* ignore */ }
  return 0
}

function readEvents(agent) {
  try {
    const session = agent && agent.session
    if (!session || typeof session.snapshotEvents !== 'function') return []
    return session.snapshotEvents() || []
  } catch {
    return []
  }
}

/** 取最近 n 条「人说的话」（用户/她），跳过工具与系统事件 */
function recentMessages(events, n) {
  const out = []
  for (let i = events.length - 1; i >= 0 && out.length < n; i -= 1) {
    const event = events[i]
    const type = event && (event.type || event.kind)
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const payload = event.payload !== undefined ? event.payload : event.data
    const text = textOf(payload)
    if (!text) continue
    out.push({ role: type === 'user/message' ? '主人' : '她', text, id: (payload && (payload.id || (payload.message && payload.message.id))) })
  }
  return out.reverse()
}

function isGroupNoise(text) {
  return 群杂音前缀.some((prefix) => String(text || '').trimStart().startsWith(prefix))
}

function dayStart(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function apply(ctx, config) {
  const cfg = loadConfig(config)
  let state = loadState()
  if (typeof state !== 'object') state = {}
  state.rounds = Number(state.rounds) || 0
  state.chars = Number(state.chars) || 0
  state.promptTokens = Number(state.promptTokens) || 0
  state.voiceTimes = Array.isArray(state.voiceTimes) ? state.voiceTimes.filter((t) => Number.isFinite(t)) : []
  state.stickerTimes = Array.isArray(state.stickerTimes) ? state.stickerTimes.filter((t) => Number.isFinite(t)) : []
  state.lastStickerAt = Number(state.lastStickerAt) || 0
  state.lastJudgeAt = Number(state.lastJudgeAt) || 0
  state.lastVoiceAt = Number(state.lastVoiceAt) || 0
  state.lastAssistantId = state.lastAssistantId || ''
  state.contextFullNudgedAt = Number(state.contextFullNudgedAt || state.rebirthNudgedAt) || 0
  state.briefAt = Number(state.briefAt) || 0
  state.digestLines = Array.isArray(state.digestLines) ? state.digestLines : []
  state.briefInjected = (state.briefInjected && typeof state.briefInjected === 'object') ? state.briefInjected : {}

  // ---- 只盯 QQ 绑定的会话，不去碰 GUI 里别的会话 ----
  function watchedSessions() {
    const out = new Set()
    const pinned = String(cfg.sessionId || '').trim()
    if (pinned) { out.add(pinned); return out }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(HOME, 'qq-bridge-config.json'), 'utf8'))
      if (Array.isArray(raw['绑定'])) for (const row of raw['绑定']) if (row && row['会话']) out.add(String(row['会话']))
      if (!out.size && typeof raw['私聊会话'] === 'string' && raw['私聊会话']) out.add(raw['私聊会话'])
    } catch { /* 没有桥就什么都不盯 */ }
    return out
  }
  let watched = watchedSessions()
  setInterval(() => { try { watched = watchedSessions() } catch {} }, 60000).unref?.()

  let lastAgent = null
  let judging = false
  let digestBuffer = []

  function log(text) {
    try {
      ensureDir()
      fs.appendFileSync(path.join(DIR, 'coach.log'), `[${new Date().toISOString()}] ${text}\n`, 'utf8')
    } catch { /* ignore */ }
  }

  function remember(agent) {
    if (!agent) return
    try {
      const origin = agent.session && agent.session.header && agent.session.header.origin
      if (origin === 'subagent') return
    } catch { /* ignore */ }
    if (typeof agent.followup === 'function') lastAgent = agent
  }

  function followup(agent, text) {
    try {
      agent.followup({
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:dsh-whale-coach' },
      })
      return true
    } catch (error) {
      log('followup 失败：' + ((error && error.message) || error))
      return false
    }
  }

  // ---------- 便宜模型 ----------
  let cachedTarget = null
  async function pickTarget(agent) {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    if (cachedTarget) return cachedTarget
    try {
      const providers = (typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : []) || []
      for (const p of providers) {
        const models = (await ctx.llm.listModels(p.id)) || []
        const ids = models.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean)
        const flash = ids.find((id) => /flash/i.test(id))
        if (flash) { cachedTarget = { provider: p.id, model: flash }; return cachedTarget }
      }
      for (const p of providers) {
        const models = (await ctx.llm.listModels(p.id)) || []
        const ids = models.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean)
        if (ids.length) { cachedTarget = { provider: p.id, model: ids[0] }; return cachedTarget }
      }
    } catch (error) {
      log('拿模型失败：' + ((error && error.message) || error))
    }
    // 最后退到会话自己的模型
    try {
      const m = agent && agent.session && agent.session.header && agent.session.header.model
      if (m && m.provider && m.model) return m
    } catch { /* ignore */ }
    return null
  }

  async function askModel(agent, system, user, maxTokens = 200) {
    const target = await pickTarget(agent)
    if (!target) return ''
    const messages = [{
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: user }],
      source: { kind: 'plugin', plugin: 'dsh-whale-coach' },
    }]
    let out = ''
    try {
      for await (const chunk of ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        system,
        messages,
        maxTokens,
        temperature: 0.2,
      })) {
        if (chunk && chunk.type === 'text-delta') out += chunk.text
      }
    } catch (error) {
      log('模型调用失败：' + ((error && error.message) || error))
      return ''
    }
    return String(out || '').trim()
  }

  function parseJson(text) {
    if (!text) return null
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)) } catch { /* 可能被截断，走下面兜底 */ }
    }
    // 兜底：从被截断的输出里捞关键字段
    const hit = /提醒["“']?\s*[:：]\s*(true|false)/i.exec(text)
    if (!hit) return null
    const kind = /类型["“']?\s*[:：]\s*["“']?(语音|表情|都)/.exec(text)
    const why = /理由["“']?\s*[:：]\s*["“']?([^"”'}\n]{1,60})/.exec(text)
    return { 提醒: hit[1].toLowerCase() === 'true', 类型: kind ? kind[1] : '语音', 理由: why ? why[1].trim() : '' }
  }

  // ---------- 记录 ----------
  function appendDigest(line) {
    digestBuffer.push(line)
    if (digestBuffer.length > 40) digestBuffer = digestBuffer.slice(-40)
    state.digestLines.push(line)
    if (state.digestLines.length > 400) state.digestLines = state.digestLines.slice(-400)
  }

  function flushDigest() {
    if (!digestBuffer.length) return
    const lines = digestBuffer.slice()
    digestBuffer = []
    try {
      fs.appendFileSync(DIGEST_FILE, lines.join('\n') + '\n', 'utf8')
    } catch (error) {
      log('写 digest 失败：' + ((error && error.message) || error))
    }
  }

  async function maybeBrief(agent) {
    const now = Date.now()
    if (now - state.briefAt < 10 * 60 * 1000) return
    const recent = state.digestLines.slice(-24)
    if (recent.length < 8) return
    const summary = await askModel(
      agent,
      '你是聊天记录压缩器。把给出的对话摘成 3-6 条要点，保留：聊了什么话题、主人的情绪与偏好、她答应过的事、没做完的事。每条一行，不要客套话。',
      recent.join('\n'),
      260,
    )
    if (!summary) return
    state.briefAt = now
    try {
      fs.appendFileSync(BRIEF_FILE, `\n## ${new Date().toLocaleString('zh-CN')}\n${summary}\n`, 'utf8')
      log('已生成阶段摘要')
    } catch { /* ignore */ }
  }

  // ---------- 判断 ----------
  function gateOk(now, kind) {
    if (kind === '表情') {
      if (now - state.lastStickerAt < cfg.stickerMinGapSec * 1000) return false
      const since = now - 3600 * 1000
      return state.stickerTimes.filter((t) => t >= since).length < cfg.stickerMaxPerHour
    }
    if (now - state.lastVoiceAt < cfg.voiceMinGapSec * 1000) return false
    const since = now - 3600 * 1000
    return state.voiceTimes.filter((t) => t >= since).length < cfg.voiceMaxPerHour
  }

  async function judge(agent, messages) {
    if (judging) return
    judging = true
    try {
      const now = Date.now()
      state.lastJudgeAt = now
      saveState(state)
      const transcript = messages.map((m) => `${m.role}：${m.text.slice(0, 200)}`).join('\n')
      const verdict = await askModel(
        agent,
        [
          '你是旁听者，不是她本人，也不替她写台词。',
          '判断「现在适不适合提醒她主动做点什么」：发语音、还是配个表情/贴纸。',
          '语音只有真到了适合开口的时机才放行：聊到情绪高潮、她刚答完一个很长的回答、冷场二十几分钟后重新说起话头、主人问她问题而她只回了一两个字。',
          '表情放行门槛低得多：气氛轻松、她刚说了句俏皮话、主人发了好笑的东西、聊到情绪但不到开口说话的程度，都可以提示配个表情。',
          '闲聊寒暄、正在讨论技术细节、她刚发过语音/表情、主人在忙正事，这些不放行。',
          '只输出 JSON：{"提醒": true/false, "类型": "语音"|"表情"|"都"，"理由": "一句话"}',
        ].join('\n'),
        `最近的对话：\n${transcript}\n\n现在时间：${new Date().toLocaleString('zh-CN')}`,
        320,
      )
      const result = parseJson(verdict)
      if (!result) { log('判断没给出 JSON：' + verdict.slice(0, 80)); return }
      if (result.提醒 !== true) return
      const kind = result.类型 === '表情' ? '表情' : (result.类型 === '都' ? '都' : '语音')
      const lines = ['[旁听] 这不是主人说的。']
      let did = ''
      if ((kind === '语音' || kind === '都') && gateOk(Date.now(), '语音')) {
        lines.push('刚才那段聊得正好，你要是想开口，可以发一条语音（第一行写【语音】）。')
        state.lastVoiceAt = Date.now()
        state.voiceTimes = [...state.voiceTimes, state.lastVoiceAt].slice(-40)
        did = '语音'
      }
      if (kind === '表情' || kind === '都') {
        if (gateOk(Date.now(), '表情')) {
          lines.push('也可以配个表情/贴纸：回复末尾单独一行写 ![随便写](_stickers/文件名)，从工作区 _stickers 里挑一张。')
          state.lastStickerAt = Date.now()
          state.stickerTimes = [...state.stickerTimes, state.lastStickerAt].slice(-60)
          did = did ? did + '+表情' : '表情'
        }
      }
      if (!did) { log('闸拦住：' + (result.理由 || '')); return }
      lines.push(`旁听的理由：${String(result.理由 || '').slice(0, 60)}`, '不想做就忽略这条，别解释。')
      if (followup(agent, lines.join('\n'))) log('已递' + did + '提示：' + (result.理由 || ''))
    } finally {
      judging = false
    }
  }

  async function maybeInjectBrief(agent, sid) {
    try {
      const brief = fs.readFileSync(BRIEF_FILE, 'utf8').trim()
      if (!brief) return
      const key = sid + '|' + brief.length
      if (state.briefInjected[sid] === key) return
      state.briefInjected[sid] = key
      saveState(state)
      const tail = brief.slice(-1400)
      followup(agent, [
        '[记忆恢复] 这不是主人说的。下面是你之前聊天压出来的阶段摘要，读一遍好接得上话；如果里面没有你想知道的具体事，就正常接着聊。',
        '',
        tail,
      ].join('\n'))
      log('已注入阶段摘要给 ' + sid.slice(0, 20))
    } catch { /* 没有摘要就跳过 */ }
  }

  async function maybeContextFull(agent) {
    if (state.promptTokens < Number(cfg.contextFullTokens || 800000)) return
    const now = Date.now()
    if (now - state.contextFullNudgedAt < 6 * 3600 * 1000) return
    state.contextFullNudgedAt = now
    saveState(state)
    followup(agent, [
      '[满上下文提示] 这不是主人说的。这轮上下文快满了，你随时可能想换个新会话。',
      '如果你愿意，就跟主人说一句类似「老大，我好困」的话，语气你自己定，参考你记得的事。',
      '不要自动换会话，也不要复述这条提示。',
    ].join('\n'))
    log('已递满上下文提示，上下文约 ' + state.promptTokens + ' token')
  }

  // ---------- 主钩子：轮询 + 事件双保险 ----------
  const pendingUser = new Map()
  state.lastBySession = (state.lastBySession && typeof state.lastBySession === 'object') ? state.lastBySession : {}

  function agentOf(sid) {
    try {
      const service = ctx.agents ?? (typeof ctx.get === 'function' ? ctx.get('agents') : undefined)
      const agent = typeof service?.get === 'function' ? service.get(sid) : null
      return agent && typeof agent.followup === 'function' ? agent : null
    } catch { return null }
  }

  function sidOf(agent) {
    try { return String(agent?.id || agent?.session?.header?.id || agent?.session?.id || '') } catch { return '' }
  }

  function onAssistant(sid, agent, userText, assistantText, key, tokens) {
    if (Number.isFinite(tokens) && tokens > 0) state.promptTokens = tokens
    if (!agent || !sid) return
    if (key === state.lastBySession[sid]) return
    state.lastBySession[sid] = key

    const countThisRound = !isGroupNoise(userText)
    if (countThisRound) state.rounds += 1
    state.chars += String(userText || '').length + String(assistantText || '').length
    appendDigest(`${new Date().toLocaleString('zh-CN')}｜主人：${String(userText || '').slice(0, 80)}｜她：${String(assistantText || '').slice(0, 80)}`)
    flushDigest()
    saveState(state)

    const messages = recentMessages(readEvents(agent), cfg.windowMessages)
    if (!messages.length) {
      messages.push({ role: '主人', text: userText || '' }, { role: '她', text: assistantText || '' })
    }
    if (countThisRound && state.rounds >= cfg.roundsPerJudge && Date.now() - state.lastJudgeAt >= cfg.minGapSec * 1000) {
      void judge(agent, messages)
    }
    if (state.rounds % 10 === 0) void maybeBrief(agent)
    void maybeInjectBrief(agent, sid)
    void maybeContextFull(agent)
  }

  /** 扫一遍所有活着的 agent：找最后一条 assistant/message，前面最近的一条 user/message 当这轮的输入 */
  function scanAgents(reason) {
    if (cfg.enabled === false) return
    try {
      const service = ctx.agents ?? (typeof ctx.get === 'function' ? ctx.get('agents') : undefined)
      const list = (typeof service?.list === 'function' ? service.list() : []) || []
      for (const agent of list) {
        const sid = sidOf(agent)
        if (!sid) continue
        if (watched.size && !watched.has(sid)) continue
        let origin
        try { origin = agent?.session?.header?.origin } catch { origin = undefined }
        if (origin === 'subagent') continue
        const events = readEvents(agent)
        if (!events.length) continue
        const messages = recentMessages(events, cfg.windowMessages)
        if (!messages.length) {
          if ((state.noMsgCount = (Number(state.noMsgCount) || 0) + 1) <= 3) {
            const types = {}
            for (const e of events.slice(-40)) { const t = e && (e.type || e.kind); if (t) types[t] = (types[t] || 0) + 1 }
            log('轮询：' + sid.slice(0, 20) + ' 有 ' + events.length + ' 条事件但抽不出消息，最近类型=' + JSON.stringify(types))
          }
          continue
        }
        const last = messages[messages.length - 1]
        if (last.role !== '她') continue
        const prevUser = [...messages].reverse().find((m) => m.role === '主人')
        let tokens = 0
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const ev = events[i]
          const t = ev && (ev.type || ev.kind)
          if (t !== 'assistant/message') continue
          tokens = tokensOf(ev)
          break
        }
        onAssistant(sid, agent, prevUser ? prevUser.text : '', last.text, String(last.id || last.text.slice(0, 120)), tokens)
      }
    } catch (error) {
      const msg = String((error && error.message) || error)
      if (!msg.includes('inactive context')) log('轮询异常：' + msg)
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      if (cfg.enabled === false) return
      try {
        const type = event && event.type
        const data = event && (event.data || event.payload)
        const sid = String(session && (session.id || (session.header && session.header.id)) || '')
        if ((state.debugCount = (Number(state.debugCount) || 0) + 1) <= 8) {
          log(`事件#${state.debugCount} type=${type} sid=${sid.slice(0, 24)} dataKeys=${data ? Object.keys(data).join('/') : 'none'}`)
        }
        if (!sid || !data) return
        if (watched.size && !watched.has(sid)) return
        const text = textOf(data)
        if (!text) return
        const sourceKind = String((data.source && data.source.kind) || '')
        if (type === 'user/message') {
          if (sourceKind.startsWith('plugin:dsh-whale-coach')) return
          pendingUser.set(sid, text)
          return
        }
        if (type === 'assistant/message') {
          const agent = agentOf(sid)
          const userText = pendingUser.get(sid) || ''
          onAssistant(sid, agent, userText, text, String((event && event.id) || (data && data.id) || text.slice(0, 120)), tokensOf(event))
        }
      } catch (error) {
        log('session/event 异常：' + ((error && error.message) || error))
      }
    })
    log('已挂 session/event 监听')
  }

  // 双保险：每 12 秒扫一遍活着的 agent（事件不触发也能工作）
  const pollTimer = setInterval(() => scanAgents('tick'), 12000)
  if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref()
  log('已启动轮询兜底（12s）')

  if (typeof ctx.webServer === 'object' && ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE + '/probe',
      handler: (req, res) => {
        const describe = (obj) => {
          if (!obj) return null
          const out = {}
          for (const key of Object.keys(obj)) {
            const value = obj[key]
            out[key] = typeof value === 'function' ? 'fn/' + value.length : typeof value
          }
          return out
        }
        const agents = (() => { try { const svc = ctx.agents ?? ctx.get('agents'); return (svc?.list?.() || []).map((a) => String(a?.id || a?.session?.header?.id || '')) } catch { return [] } })()
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({
          ok: true,
          sessionController: describe(ctx.sessionController ?? (typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined)),
          sessions: describe(ctx.sessions ?? (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined)),
          agents,
        }))
      },
    })
  }

  if (typeof ctx.webServer === 'object' && ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE + '/state',
      handler: (req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({
          ok: true,
          config: cfg,
          state: {
            rounds: state.rounds,
            chars: state.chars,
            promptTokens: state.promptTokens,
            watched: [...watched],
            lastJudgeAt: state.lastJudgeAt,
            lastVoiceAt: state.lastVoiceAt,
            voiceLastHour: state.voiceTimes.filter((t) => t >= Date.now() - 3600000).length,
            contextFullNudgedAt: state.contextFullNudgedAt,
            digestLines: state.digestLines.length,
            briefAt: state.briefAt,
          },
          files: { digest: DIGEST_FILE, brief: BRIEF_FILE },
        }))
      },
    })
  }

  ensureDir()
  log(`已启动 v4（事件+轮询双保险）：每 ${cfg.roundsPerJudge} 轮判一次，间隔 ${cfg.minGapSec}s，语音闸 ${cfg.voiceMinGapSec}s/${cfg.voiceMaxPerHour}h，满上下文阈值 ${cfg.contextFullTokens} token`)
}
