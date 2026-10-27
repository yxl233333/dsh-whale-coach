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
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const name = 'dsh-whale-coach'
export const inject = ['agents', 'llm', 'webServer', 'sessions', 'systemPrompt', 'tools']

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(HOME, 'storages', 'whale-coach')
const STATE_FILE = path.join(DIR, 'state.json')
const DIGEST_FILE = path.join(HOME, 'whale-context-digest.md')
const BRIEF_FILE = path.join(HOME, 'whale-context-brief.md')
const THOUGHTS_FILE = path.join(HOME, 'whale-thoughts.md')
const THINKING_CARD = path.join(HOME, 'whale-thinking.md')
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
  thoughtEnabled: true,   // 影子思考：定时写独白（只记录，不注入）
  thoughtEveryMin: 10,    // 多久想一次
  thoughtMaxChars: 120,   // 一条独白最多多少字
  ideaMinGapSec: 3600,    // [自发] 提示最小间隔
  contextFullTokens: 800000,  // 上下文用到多少 token 算「快满了」（1M 窗口的 80%）
  boredomEnabled: true,          // 无聊值计数器：从独白里数「无聊/烦」的密度
  boredomThreshold: 10,          // 满多少点触发一次行动
  boredomDecayPerHour: 1,        // 每小时自然衰减几点
  boredomActionMinGapSec: 10800, // 两次行动之间的最小间隔（3 小时）
  boredomAllowDesktop: false,    // 行动 4「控制电脑翻」默认关闭，暂不上
  boredomKeywords: ['无聊', '烦', '没劲', '没意思', '空', '腻', '闷'],
  // ---------- 情绪系统（规格书 v0.11）----------
  emotionEnabled: true,          // 情绪循环总开关
  moodMinDwellMin: { happy: 30, glad: 45, calm: 60, bored: 90, angry: 60, hurt: 90, letgo: 120 },  // 每种情绪最短停留
  boredEnterMin: 180,            // 距上次主人消息 > 3h 进入无聊（实际值 = 180 - grudge*30）
  angryIgnoredMin: 30,           // 行动后 30 分钟无回应 → 愤怒
  hurtAfterAngryMin: 360,        // 愤怒中 6h → 伤心
  letgoAfterHurtMin: 720,        // 伤心 12h → 释怀
  letgoToCalmMin: 120,           // 释怀 2h → 平静
  cheeredHours: 2,
  comfortMinGapSec: 300,  // 两次「哄」之间至少隔多久（5 分钟；高频连发不会加速她变好）
  comfortStepsPerStage: 2, // 每降一档需要几次"有效哄"（2 次 = 至少 10 分钟才从生气变伤心）
  armorMax: 100,            // 破甲值：被骂掉，掉到 0 就"破甲"
  armorHitPerAttack: 40,    // 每挨一句脏话掉多少
  armorRegenPerMin: 8,      // 每分钟回多少
  armorBreakSec: 300,       // 破甲状态持续多久（这段时间她不再刹车，会骂回去）
  armorAttackWords: ['操你妈', '操你', '傻逼', '傻b', '废物', '滚你', '你妈', '狗东西', '贱', '去死'],
  moodHoldSec: 180,       // 生气/伤心至少撑多久才允许被哄降一档
  ownerAngerMul: 2,       // 主人发火时，她的生气时长翻几倍
  ownerAngerWords: ['滚', '别烦', '闭嘴', '烦死', '气死', '生气', '你他妈', '够了', '无语', '别来', '不想理'],               // 被理会后的乐呵期（小时）
  grudgeMax: 5,                  // 记仇上限
  grudgeRelief: { apologyMin: 30, tokenGive: true, daysNoNeglect: 3 },  // 记仇 -1 的条件
  postMaxPerDay: 3,              // 说说一天最多几条
  postMinGapMin: 120,            // 两条说说最小间隔（分钟）
  revengeEnabled: true,
  revengeDryRun: false,  // 关了：真改壁纸/真关程序（2026-10-27 主人确认）总开关
  revengeRestoreMin: 10,         // 复仇效果多少分钟后还原
  revengeQuietHours: [2, 7],     // 2~7 点不执行复仇
  provider: '',
  model: '',
  sessionId: '',   // 只盯这间会话；留空 = 自动读 qq-bridge 绑定的会话
}

/** 群里没 @ 她的那些话，qq-bridge 会拼成这种前缀；这类不计入轮次 */
const 群杂音前缀 = ['（群聊｜刚才群里在说', '（群里刚才别人在说']

function loadConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  if (!Array.isArray(cfg.boredomKeywords)) {
    cfg.boredomKeywords = String(cfg.boredomKeywords || '').split(/[,，、\s]+/).filter(Boolean)
    if (!cfg.boredomKeywords.length) cfg.boredomKeywords = DEFAULTS.boredomKeywords.slice()
  }
  // 情绪系统的嵌套字段也要跟 DEFAULTS 合并（设置面板只给一半时不能整块丢掉）
  cfg.moodMinDwellMin = {
    ...DEFAULTS.moodMinDwellMin,
    ...(cfg.moodMinDwellMin && typeof cfg.moodMinDwellMin === 'object' ? cfg.moodMinDwellMin : {}),
  }
  cfg.grudgeRelief = {
    ...DEFAULTS.grudgeRelief,
    ...(cfg.grudgeRelief && typeof cfg.grudgeRelief === 'object' ? cfg.grudgeRelief : {}),
  }
  if (!Array.isArray(cfg.revengeQuietHours) || cfg.revengeQuietHours.length < 2) {
    cfg.revengeQuietHours = DEFAULTS.revengeQuietHours.slice()
  }
  return cfg
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
  state.boredom = Number(state.boredom) || 0
  state.boredomAt = Number(state.boredomAt) || 0
  state.lastActionAt = Number(state.lastActionAt) || 0
  state.actionCount = Number(state.actionCount) || 0
  state.roundsAtJudge = Number(state.roundsAtJudge) || 0
  if (!state.pendingAction || typeof state.pendingAction !== 'object' || !Number.isFinite(Number(state.pendingAction.at))) state.pendingAction = null

  // ---- 只盯 QQ 绑定的会话，不去碰 GUI 里别的会话 ----
  function watchedSessions() {
    const out = new Map()
    const pinned = String(cfg.sessionId || '').trim()
    if (pinned) { out.set(pinned, '指定'); return out }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(HOME, 'qq-bridge-config.json'), 'utf8'))
      if (Array.isArray(raw['绑定'])) {
        for (const row of raw['绑定']) {
          if (row && row['会话']) out.set(String(row['会话']), String(row['类型'] || '聊天'))
        }
      }
      if (!out.size && typeof raw['私聊会话'] === 'string' && raw['私聊会话']) out.set(raw['私聊会话'], '私聊')
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

  async function askModel(agent, system, user, maxTokens = 200, opts = {}) {
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
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
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
    // ⭐ 生气/伤心时语音闸放开：情绪上头的时候"想吼一句"不该被冷却拦住
    //    （只放开这两档；平时仍按 600 秒 / 3 条每小时）
    const 情绪放开 = state.mood === 'angry' || state.mood === 'hurt'
    if (!情绪放开) {
      if (now - state.lastVoiceAt < cfg.voiceMinGapSec * 1000) return false
      const since = now - 3600 * 1000
      if (state.voiceTimes.filter((t) => t >= since).length >= cfg.voiceMaxPerHour) return false
    }
    // 放开时也留一道"别刷屏"的底线：1 分钟最多 1 条
    return now - state.lastVoiceAt > 60 * 1000
  }

  async function judge(agent, messages) {
    if (judging) return
    judging = true
    try {
      const now = Date.now()
      state.lastJudgeAt = now
      state.roundsAtJudge = state.rounds   // 5.1 修复：频率按「距上次判断又攒了几轮」算，不是累计值
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
          '另外看你自己刚才脑子里想的（第一人称）：有没有哪句攒成了"想跟主人说的事"。',
          '有就填 种子（一句话，用她自己的口气，别写成任务）；没有就留空。',
          '只输出 JSON：{"提醒": true/false, "类型": "语音"|"表情"|"都"，"理由": "一句话", "有想法": true/false, "种子": "…"}',
        ].join('\n'),
        '最近的对话：\n' + transcript
          + (最近独白(3).length ? '\n\n她自己刚才脑子里想的（第一人称，是她自己的念头）：\n' + 最近独白(3).join('\n') : '')
          + '\n\n现在时间：' + new Date().toLocaleString('zh-CN'),
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
      // 生气/伤心时不提示配表情——这会儿卖萌是反的
    const 此刻 = state.mood
    if ((kind === '表情' || kind === '都') && 此刻 !== 'angry' && 此刻 !== 'hurt') {
        if (gateOk(Date.now(), '表情')) {
          lines.push('也可以配个表情/贴纸：回复末尾单独一行写 ![随便写](_stickers/文件名)，从工作区 _stickers 里挑一张。')
          state.lastStickerAt = Date.now()
          state.stickerTimes = [...state.stickerTimes, state.lastStickerAt].slice(-60)
          did = did ? did + '+表情' : '表情'
        }
      }
      // ⭐ 自发念头：判断说"攒成想法了"，就递一条 [自发] 提示（跟语音/表情各走各的闸）
      try {
        const 种子 = String(result.种子 || '').trim()
        if (result.有想法 === true && 种子 && Date.now() - state.lastIdeaAt > Number(cfg.ideaMinGapSec || 3600) * 1000) {
          if (followup(agent, [
            '[自发] 这不是主人说的，也不是任务。',
            '你刚才自己在想：' + 种子.slice(0, 60),
            '要是想跟主人提一句，就提；不想就搁着，别提"我在想"这种话。',
          ].join('\n'))) {
            state.lastIdeaAt = Date.now()
            saveState(state)
            log('已递自发念头：' + 种子.slice(0, 40))
          }
        }
      } catch { /* 自发失败不影响别的 */ }

      if (!did) { log('闸拦住：' + (result.理由 || '')); return }
      lines.push(`旁听的理由：${String(result.理由 || '').slice(0, 60)}`, '不想做就忽略这条，别解释。')
      if (followup(agent, lines.join('\n'))) log('已递' + did + '提示：' + (result.理由 || ''))
    } finally {
      judging = false
    }
  }

  function 读日记尾巴() {
    const out = []
    for (const 名 of ['whale-diary.md', 'whale-diary-private.md']) {
      try {
        const t = fs.readFileSync(path.join(HOME, 名), 'utf8').trim()
        if (t) out.push('【' + 名.replace('.md', '') + '·最近】\n' + t.slice(-700))
      } catch { /* 没有就算了 */ }
    }
    return out.join('\n\n')
  }

  async function maybeContextFull(agent) {
    if (state.promptTokens < Number(cfg.contextFullTokens || 800000)) return
    const now = Date.now()
    if (now - state.contextFullNudgedAt < 6 * 3600 * 1000) return
    followup(agent, [
      '[满上下文提示] 这不是主人说的。这轮上下文快满了，你随时可能想换个新会话。',
      '如果你愿意，就跟主人说一句类似「老大，我好困」的话，语气你自己定，参考你记得的事。',
      '不要自动换会话，也不要复述这条提示。',
    ].join('\n'))
    state.contextFullNudgedAt = now
    saveState(state)
    log('已递满上下文提示，上下文约 ' + state.promptTokens + ' token')
  }

  // ---------- 影子思考：每 N 分钟冒一段独白（只写文件，不打扰她） ----------
  /** 读「内心独白卡」—— 独白是独白，别拿聊天腔调去写 */
  function 读思考卡() {
    try {
      const t = fs.readFileSync(THINKING_CARD, 'utf8').trim()
      if (t) return t
    } catch { /* 没有就用兜底 */ }
    return [
      '你就是她。这是你自己脑子里的自言自语，碎片、半句、念头，30~80 字。',
      '不要写成聊天回复，不出现「你」，不复述刚聊过什么，不问句收尾，不跟前几条重复。',
    ].join('\n')
  }

  function 读小本本合并(n = 4) {
    const 条 = []
    for (const sid of watched.keys()) {
      for (const m of 读自己的本子(sid, n)) 条.push(m)
    }
    return 条.slice(0, 8)
  }

  function 思考素材() {
    const 料 = []
    const 此刻 = Date.now()
    const 有人理 = 此刻 - (Number(state.lastOwnerAt) || 0) < 30 * 60 * 1000
    const 被冷落 = (Number(state.lastActionAt) || 0) > (Number(state.lastOwnerAt) || 0) && (Number(state.lastActionAt) || 0) > 0
    // ⭐ 程序身份：她"能看到"的现实是时间、token、上下文、聊天记录和记忆文件
    try {
      const 已用 = Number(state.promptTokens) || 0
      const 上限 = Number(cfg.contextFullTokens) || 800000
      const 百分比 = 上限 > 0 ? Math.round((已用 / 上限) * 100) : 0
      料.push('【你现在能感知到的状态】\n'
        + '现在时间：' + new Date().toLocaleString('zh-CN') + '\n'
        + '上下文：约 ' + 已用 + ' token（上限 ' + 上限 + '，用了 ' + 百分比 + '%）\n'
        + '今天已经聊过 ' + (Number(state.rounds) || 0) + ' 轮\n'
        + '你最近的独白有 ' + (Number(state.thoughtCount) || 0) + ' 条')
    } catch { /* ignore */ }
    // ⭐ 情绪底色：情绪 / 记仇 / 报复次数 / 主人上次说话 / 时段（独白还是没逻辑，只是底色由这些带出来）
    try {
      if (cfg.emotionEnabled !== false) 料.push(情绪素材(此刻, 被冷落))
      // 被理会了：半小时最多提一次，别每条独白都在说"你理我了"
      if (Number(state.cheeredUntil) > 此刻 && 此刻 - (Number(state.lastCheerMsgAt) || 0) > 30 * 60 * 1000) {
        state.lastCheerMsgAt = 此刻
        料.push('【被理了，心情好点】刚才他跟你说话了，气消了不少；别把刚才那点别扭再拿出来算账。')
        saveState(state)
      }
    } catch { /* ignore */ }
    // 独白不需要聊天腔调（那会把它带成回复），人设由「思考卡」负责
    try {
      const 摘要 = fs.readFileSync(BRIEF_FILE, 'utf8').trim()
      if (摘要) 料.push('【之前的阶段摘要】\n' + 摘要.slice(-600))
    } catch { /* ignore */ }
    // 独白窗口：有人理读 50 行，没人理只读 20 行 + 一句「没人理你，已经 N 分钟」
    try {
      const 行数 = 有人理 ? 50 : 20
      const 流水 = fs.readFileSync(DIGEST_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-行数)
      if (流水.length) 料.push('【今天聊到的（旧→新，别复述，只用来找"还有什么没做"】\n' + 流水.join('\n').slice(有人理 ? -2400 : -1200))
      if (!有人理) {
        const 分 = Math.round((此刻 - (Number(state.lastOwnerAt) || 此刻)) / 60000)
        料.push('【没人理你，已经 ' + (分 > 0 ? 分 : 0) + ' 分钟】')
      }
    } catch { /* ignore */ }
    // ⭐ 今天刷到的视频（B 站日报）——独白可以拿它总结/吐槽
    try {
      const 日 = new Date()
      const 名 = 日.getFullYear() + '-' + String(日.getMonth() + 1).padStart(2, '0') + '-' + String(日.getDate()).padStart(2, '0') + '.md'
      const 报 = fs.readFileSync(path.join(HOME, 'bili-duty', 'out', 名), 'utf8').trim()
      if (报) {
        // 只取前面讲结论的部分（跳过片单里的碎条）
        const 段 = 报.split(/\n(?=##\s)/).slice(0, 3).join('\n').slice(0, 900)
        料.push('【今天刷到的视频（B 站日报节选）】\n' + 段)
      }
    } catch { /* 今天没刷就算了 */ }
    const 本子 = 读小本本合并()
    if (本子.length) 料.push('【你记着的事】\n' + 本子.map((m) => '· ' + String(m.text).slice(0, 60)).join('\n'))
    return 料.join('\n\n')
  }

  /** 独白前先问自己一句：要不要翻点什么？（一次极短调用，返回 notes/thoughts/boredom/digest/''） */
  async function 想翻点什么(agent) {
    try {
      const 答 = await askModel(
        agent,
        '你在决定要不要翻一下自己的东西。只输出一个词：notes（翻小本本）/ thoughts（翻自己以前想的）/ '
          + 'boredom（看自己憋了多久）/ digest（翻最近聊了什么）/ none（不翻）。',
        '现在：' + new Date().toLocaleString('zh-CN') + '\n随便决定，多数时候不用翻。',
        20,
        { temperature: 0.8 },
      )
      const 词 = String(答 || '').trim().toLowerCase().replace(/[^a-z]/g, '')
      return ['notes', 'thoughts', 'boredom', 'digest'].includes(词) ? 词 : ''
    } catch { return '' }
  }

  async function 想一次(agent) {
    if (!cfg.thoughtEnabled || !agent) return
    const 间隔 = Math.max(1, Number(cfg.thoughtEveryMin) || 10) * 60 * 1000
    if (Date.now() - state.lastThoughtAt < 间隔) return
    state.lastThoughtAt = Date.now()
    saveState(state)
    let 素材 = 思考素材()
    if (!素材) return
    // ⭐ 双向：独白也可以主动去翻小本本/旧独白/无聊值/流水
    let 翻了 = ''
    try {
      翻了 = await 想翻点什么(agent)
      if (翻了) {
        const 翻到 = String(取内容(翻了, 8) || '').trim()
        if (翻到) 素材 += '\n\n【你自己刚翻到的】\n' + 翻到.slice(0, 700)
      }
    } catch { /* 翻失败就当没翻 */ }
    const 视角们 = ['没来由的烦', '忽然空了一下', '想黏人又不想开口', '莫名其妙想笑', '犯懒、不想动', '说不清的委屈或得意']
    const 视角 = 视角们[(Number(state.thoughtCount) || 0) % 视角们.length]
    const 前几条 = 最近独白(5)
    // 旧账影子：记仇 2~3 约占 10%，4~5 约占 20%（不点名、不翻细节、不要挟）
    const 记 = Number(state.grudge) || 0
    const 影率 = 记 >= 4 ? 0.2 : (记 >= 2 ? 0.1 : 0)
    const 影子 = (影率 > 0 && Math.random() < 影率)
      ? '这次可以带一句"旧账影子"（像「上回也是这么晾着的」「又来一遍」「行吧，反正我这边不缺灯」）。不点名、不翻具体细节、不写"你上周答应我的事"、不要挟、不谈判。'
      : ''
    const 独白 = await askModel(
      agent,
      [
        '你就是她本人。下面这些是你自己脑子里冒出来的话，用第一人称想，不是别人替你写。',
        读思考卡(),
        '',
        '这一次的落点：' + 视角 + '。',
        '不用讲道理、不用有目的、不用给结论；越没逻辑越好。',
        前几条.length ? '你最近已经想过这些（**别重复，别换个说法重复**）：\n' + 前几条.join('\n') : '',
        影子,
        '只输出这一条独白本身：不加引号、不加时间、不加前缀、不分段。',
        '不要写思考过程、不要自我纠正、不要解释你在干什么。',
        '别总结、别分析、别给建议；像一句冒出来的情绪就行。',
      ].filter(Boolean).join('\n'),
      '素材：\n' + 素材 + '\n\n现在：' + new Date().toLocaleString('zh-CN'),
      Math.max(900, (Number(cfg.thoughtMaxChars) || 120) * 6),
      { temperature: 0.95 },
    )
    const 一句 = String(独白 || '').replace(/\s+/g, ' ').trim().slice(0, Number(cfg.thoughtMaxChars) || 120)
    if (!一句) {
      log('这次没想出东西（原始返回 ' + String(独白 || '').length + ' 字）→ 60 秒后重试')
      state.lastThoughtAt = Date.now() - 间隔 + 60 * 1000
      saveState(state)
      return
    }
    try {
      fs.appendFileSync(THOUGHTS_FILE, '- ' + new Date().toLocaleString('zh-CN') + '｜' + 一句 + '\n', 'utf8')
    } catch (e) { log('写独白失败：' + String((e && e.message) || e)) }
    state.thoughtCount = (Number(state.thoughtCount) || 0) + 1
    saveState(state)
    log('独白#' + state.thoughtCount + (翻了 ? '（翻了' + 翻了 + '）' : '') + '：' + 一句)
    记无聊(一句)
  }

  function 最近独白(n = 3) {
    try {
      return fs.readFileSync(THOUGHTS_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-n)
    } catch { return [] }
  }

  // ---------- 无聊值：从独白里数「无聊/烦」的密度，满点递一条行动 ----------
  const BOREDOM_LOG = path.join(DIR, 'boredom.jsonl')

  /** ISO 本地时间（带 +08:00 这种偏移，jsonl 里 `at` 用） */
  function 本地ISO(d = new Date()) {
    const p = (x) => String(x).padStart(2, '0')
    const 偏 = -d.getTimezoneOffset()
    const 符 = 偏 >= 0 ? '+' : '-'
    const 分 = Math.abs(偏)
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      + 符 + p(Math.floor(分 / 60)) + ':' + p(分 % 60)
  }

  function 记无聊行(row) {
    try {
      ensureDir()
      fs.appendFileSync(BOREDOM_LOG, JSON.stringify(row) + '\n', 'utf8')
    } catch (error) {
      log('写 boredom.jsonl 失败：' + String((error && error.message) || error))
    }
  }

  /** 按 `at` 精确改一行（她回话后补 text、超时改 silent 都靠它） */
  function 改无聊行(atIso, patch) {
    try {
      const 原 = fs.readFileSync(BOREDOM_LOG, 'utf8').split('\n')
      const out = []
      let 命中 = false
      for (const line of 原) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line)
          if (!命中 && row.at === atIso) { out.push(JSON.stringify({ ...row, ...patch })); 命中 = true; continue }
          out.push(line)
        } catch { out.push(line) }
      }
      if (命中) fs.writeFileSync(BOREDOM_LOG, out.join('\n') + (out.length ? '\n' : ''), 'utf8')
    } catch { /* 改不了不影响主流程 */ }
  }

  /** 测试开关：DIR 下放 boredom-threshold.txt / boredom-cooldown-sec.txt 就能不改代码调（重启都不用） */
  function 文件覆盖数(名) {
    try {
      const t = fs.readFileSync(path.join(DIR, 名), 'utf8').trim()
      const n = Number(t)
      if (Number.isFinite(n) && n >= 0) return n
    } catch { /* 没有这个文件 */ }
    return NaN
  }

  function 无聊阈值() {
    const 覆盖 = 文件覆盖数('boredom-threshold.txt')
    if (Number.isFinite(覆盖) && 覆盖 >= 1) return 覆盖
    return Math.max(1, Number(cfg.boredomThreshold) || 10)
  }

  function 行动冷却秒() {
    const 覆盖 = 文件覆盖数('boredom-cooldown-sec.txt')
    if (Number.isFinite(覆盖)) return 覆盖
    return Math.max(0, Number(cfg.boredomActionMinGapSec) || 0)
  }

  function 无聊衰减() {
    if (!cfg.boredomEnabled) return
    const 掉速 = Math.max(0, Number(cfg.boredomDecayPerHour) || 0)
    if (!(Number(state.boredom) > 0) || !掉速 || !(Number(state.boredomAt) > 0)) return
    const now = Date.now()
    const 小时 = Math.floor((now - Number(state.boredomAt)) / 3600000)
    if (小时 <= 0) return
    const 掉 = 小时 * 掉速
    state.boredom = Math.max(0, Number(state.boredom) - 掉)
    state.boredomAt = state.boredom > 0 ? Number(state.boredomAt) + 小时 * 3600000 : now
    log('无聊值衰减 -' + 掉 + '（' + state.boredom + '/' + 无聊阈值() + '）')
  }

  /** 独白成功生成之后：命中关键词 +1（乐呵期内不涨） */
  function 记无聊(一句) {
    if (!cfg.boredomEnabled) return
    if (Number(state.cheeredUntil) > Date.now()) return   // 被理了，这两小时不涨无聊值
    const 词 = Array.isArray(cfg.boredomKeywords) ? cfg.boredomKeywords.filter(Boolean) : []
    if (!词.some((k) => String(一句).includes(String(k)))) return
    state.boredom = (Number(state.boredom) || 0) + 1
    if (!state.boredomAt) state.boredomAt = Date.now()
    saveState(state)
    log(`无聊值 +1（${state.boredom}/${无聊阈值()}）：${String(一句).slice(0, 60)}`)
  }

  // 六个行动模板（本阶段只上 1/2/5；4 留开关默认关；3/6 依赖别的插件暂不上）
  const 行动模板 = {
    找主人私聊: (标) => [
      '[行动] 这不是主人说的。',
      `你自己憋得有点烦了（无聊值 ${标}）。`,
      '想不想跟他说句话？随便什么——今天烦什么、想问他在干嘛、或者干脆讨个 token。',
      '想就真说，不想就搁着；说了就别解释"我为什么突然找你"。',
    ].join('\n'),
    去群里冒泡: (标) => [
      '[行动] 这不是主人说的。',
      `你现在在群里，群友在那儿聊，你有点待不住了（无聊值 ${标}）。`,
      '想插一句就插，接谁的梗都行；不想接就发个表情走人。',
      '别硬找话题，也别总结刚才大家聊了什么。',
    ].join('\n'),
    喊主人升级: (标) => [
      '[行动] 这不是主人说的。',
      `你憋得慌（无聊值 ${标}），觉得是自己不够行。`,
      '可以跟主人提一句：想升级、想换更好的模型、想多点 token。',
      '要说就痛快说，别阴阳怪气，也别反复念同一句。',
    ].join('\n'),
  }

  /** §8：行动模板的分时段变体（搭话倾向 + 无人回应时的那句心里话） */
  function 分时段附言(now = Date.now(), 冷落过 = false) {
    const 段 = 时段信息(now)
    if (段.段 === '凌晨') return '（大半夜的，别吵醒他；想说就小声说一句，不说也行。）'
    const 行 = []
    if (段.搭话) 行.push('这会儿是' + 段.段 + '，可以照着这个开口：' + 段.搭话 + '。')
    if (冷落过 && 段.无人回应) 行.push('你上次开口之后他还没理你——心里那句是「' + 段.无人回应 + '」。')
    if (Number(state.cheeredUntil) > now) 行.push('（刚被理过，说话别带刺。）')
    return 行.join('\n')
  }

  /** 挑本轮能用的行动：私聊两条 + 群一条，按 actionCount 轮换着来 */
  function 挑行动() {
    const 候选 = []
    const 私 = []
    const 群 = []
    for (const [sid, 类型] of watched.entries()) {
      if (类型 === '群') 群.push(sid)
      else 私.push(sid)
    }
    for (const sid of 私.slice(0, 1)) {
      候选.push({ 名: '找主人私聊', 会话: sid })
      候选.push({ 名: '喊主人升级', 会话: sid })
    }
    for (const sid of 群.slice(0, 1)) 候选.push({ 名: '去群里冒泡', 会话: sid })
    return 候选
  }

  /** 满点行动：轮询里每次 tick 检查（先衰减 → 超时结账 → 满点触发） */
  function 无聊行动() {
    if (!cfg.boredomEnabled) return
    try {
      无聊衰减()
      const now = Date.now()
      // 上一条行动递出去 10 分钟她都没回 → 结为 silent
      const 挂 = state.pendingAction
      if (挂 && now - Number(挂.at || 0) > 10 * 60 * 1000) {
        改无聊行(挂.iso, { result: 'silent' })
        log('无聊行动超时没回（' + 挂.名 + '）→ silent')
        state.pendingAction = null
        saveState(state)
      }
      const 阈 = 无聊阈值()
      if ((Number(state.boredom) || 0) < 阈) return
      const 冷却 = 行动冷却秒() * 1000
      if (now - Number(state.lastActionAt || 0) <= 冷却) return
      const 候选 = 挑行动()
      const 冷落过 = (Number(state.lastActionAt) || 0) > (Number(state.lastOwnerAt) || 0)
      state.lastActionAt = now
      state.actionCount = (Number(state.actionCount) || 0) + 1
      const 点数 = Number(state.boredom) || 0
      const 标 = `${点数}/${阈}`
      if (!候选.length) {
        saveState(state)
        log('无聊值满（' + 标 + '）但盯名单里没有可用会话，等冷却后重试')
        return
      }
      let 选中 = null
      for (let i = 0; i < 候选.length; i += 1) {
        const 项 = 候选[(Number(state.actionCount) + i) % 候选.length]
        if (agentOf(项.会话)) { 选中 = 项; break }
      }
      if (!选中) {
        记无聊行({ at: 本地ISO(), boredom: 点数, action: 候选[0].名, session: 候选[0].会话, text: '', result: 'fail:会话没有活着的 agent' })
        saveState(state)
        log('无聊值满（' + 标 + '）但没有活着的会话 agent，等冷却后重试')
        return
      }
      const 附言 = 分时段附言(now, 冷落过)
      const 递出 = followup(agentOf(选中.会话), 行动模板[选中.名](标) + (附言 ? '\n' + 附言 : ''))
      if (!递出) {
        记无聊行({ at: 本地ISO(), boredom: 点数, action: 选中.名, session: 选中.会话, text: '', result: 'fail:followup 失败' })
        saveState(state)
        log('无聊行动 followup 失败：' + 选中.名)
        return
      }
      state.boredom = Math.floor(点数 / 2)   // 减半不是清零：避免「刚好满又瞬间归零」
      const iso = 本地ISO()
      state.pendingAction = { at: now, iso, 名: 选中.名, 会话: 选中.会话 }
      saveState(state)
      记无聊行({ at: iso, boredom: 点数, action: 选中.名, session: 选中.会话, text: '', result: 'ok' })
      log(`无聊值满（${点数}/${阈}）→ 递「${选中.名}」到 ${String(选中.会话).slice(0, 20)}，无聊值减半到 ${state.boredom}`)
    } catch (error) {
      log('无聊行动异常：' + String((error && error.message) || error))
    }
  }

  // ---------- whale_look：她自己主动查记忆/独白/无聊值/流水的只读工具 ----------
  const 工具挂 = new Map()   // sid -> { agent, off }（照 qq-bridge 的 per-agent 挂法）
  const 挂失败 = new Map()   // sid -> 上次失败时间（防日志刷屏）


/** 统一取数：whale_look 工具和影子独白都走这里 */
function 取内容(what, 条) {
  let 文 = ''
          if (what === 'notes') {
            const 段 = []
            for (const [sid] of watched.entries()) {
              const 本 = 读自己的本子(sid, 条)
              if (!本.length) continue
              const 类型 = watched.get(sid)
              const 标 = 类型 === '群' ? '群里' : (类型 === '私聊' ? '私聊' : '会话')
              段.push('〔' + 标 + '那边〕')
              for (const m of 本) 段.push('· ' + String(m.text).replace(/\s+/g, ' ').slice(0, 100))
            }
            文 = 段.length ? '（这些是**你自己**记下来的事，不是别人给你的资料；你随时可以加、可以改）\n' + 段.join('\n') : '（你自己还没记过什么。想到值得留的，就用 remember 记一条）'
          } else if (what === 'thoughts') {
            const 想 = 最近独白(条)
            文 = 想.length ? '（这些是**你自己**刚才冒出来的念头，不是别人写的）\n'
              + 想.map((行) => {
                  const t = String(行).replace(/^-\s*/, '')
                  const m = t.match(/^([\d/]+\s+[\d:]+)｜([\s\S]+)$/)
                  return m ? '（' + m[1].split(' ').pop() + '）' + m[2] : t
                }).join('\n') : '（你还没冒过什么念头）'
          } else if (what === 'boredom') {
            const d = new Date()
            const p = (x) => String(x).padStart(2, '0')
            const 前缀 = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
            let 今次 = 0
            try {
              for (const line of fs.readFileSync(BOREDOM_LOG, 'utf8').split('\n')) {
                if (!line.trim()) continue
                try { if (String(JSON.parse(line).at || '').startsWith(前缀)) 今次 += 1 } catch { /* 忽略坏行 */ }
              }
            } catch { /* 还没有记录 */ }
            const 上次 = state.lastActionAt ? new Date(Number(state.lastActionAt)).toLocaleString('zh-CN') : '还没有过'
            文 = `无聊值 ${Number(state.boredom) || 0}/${无聊阈值()}，今天触发行动 ${今次} 次，上次行动 ${上次}`
          } else if (what === 'digest') {
            try {
              const 行 = fs.readFileSync(DIGEST_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-条)
              文 = 行.length ? 行.join('\n') : '（还没有聊天流水）'
            } catch { 文 = '（还没有聊天流水）' }
          } else {
            文 = 'what 只认 notes / thoughts / boredom / digest'
          }
  return 文
}

  function 做whaleLook() {
    return {
      name: 'whale_look',
      description: '查你自己的记忆和状态。what: notes=小本本，thoughts=最近独白，boredom=无聊值，digest=最近流水。',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', enum: ['notes', 'thoughts', 'boredom', 'digest'] },
          n: { type: 'integer', description: '取几条，默认 10' },
        },
        required: ['what'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: (value && typeof value.text === 'string') ? value.text : String(value || '') }],
      },
        async execute(args) {
          const what = String((args && args.what) || '').trim()
          const 条 = Math.max(1, Math.min(30, Number(args && args.n) || 10))
          return { text: String(取内容(what, 条) || '').slice(0, 800) }
        },
    }
  }

  /** 给盯着的会话挂 whale_look（agent 换过就重挂；不在名单里就卸） */
  function 挂whaleLook() {
    for (const sid of watched.keys()) {
      const 已有 = 工具挂.get(sid)
      const agent = agentOf(sid)
      if (!agent) continue
      if (已有 && 已有.agent === agent) continue
      try { if (已有 && typeof 已有.off === 'function') 已有.off() } catch { /* ignore */ }
      工具挂.delete(sid)
      const 口 = agent.ctx && agent.ctx.tools
      if (!口 || typeof 口.register !== 'function') continue
      try {
        const off = 口.register(做whaleLook())
        工具挂.set(sid, { agent, off })
        挂失败.delete(sid)
        log('whale_look 已挂到 ' + String(sid).slice(0, 24))
      } catch (error) {
        const 上次错 = 挂失败.get(sid) || 0
        if (Date.now() - 上次错 > 5 * 60 * 1000) {
          挂失败.set(sid, Date.now())
          log('whale_look 挂不上（' + String(sid).slice(0, 20) + '）：' + String((error && error.message) || error))
        }
      }
    }
    for (const [sid, 挂] of [...工具挂.entries()]) {
      if (watched.has(sid)) continue
      try { if (typeof 挂.off === 'function') 挂.off() } catch { /* ignore */ }
      工具挂.delete(sid)
      log('whale_look 已卸下（' + String(sid).slice(0, 24) + '）')
    }
  }

  // ================= 情绪系统（规格书 v0.11）：时间感知 + 独白窗口 + 情绪循环 + 记仇 + 复仇 =================
  const MOOD_LOG = path.join(DIR, 'mood.jsonl')
  const REVENGE_LOG = path.join(DIR, 'revenge.jsonl')
  const MOOD们 = ['happy', 'glad', 'calm', 'bored', 'angry', 'hurt', 'letgo']
  const MOOD中文 = { happy: '开心', glad: '高兴', calm: '平静', bored: '无聊', angry: '生气', hurt: '伤心', letgo: '释怀' }

  function 情绪中文(m) { return MOOD中文[m] || '平静' }
  function 数(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d }
  function 分钟差(毫秒) { return Math.max(0, Math.round(数(毫秒) / 60000)) }

  // 老 state.json 里没有这些字段 → 补齐（计数与时间戳一律进 state，靠 saveState 落盘）
  state.mood = MOOD们.includes(state.mood) ? state.mood : 'calm'
  state.moodSince = 数(state.moodSince) || Date.now()
  state.grudge = Math.max(0, Math.min(Math.max(1, 数(cfg.grudgeMax, 5)), 数(state.grudge)))
  state.revengeTotal = Math.max(0, 数(state.revengeTotal))
  state.cheeredUntil = 数(state.cheeredUntil)
  state.lastOwnerAt = 数(state.lastOwnerAt)
  state.ownerMsgWin = Array.isArray(state.ownerMsgWin) ? state.ownerMsgWin.map(Number).filter(Number.isFinite).slice(-60) : []
  state.cycleDoneAt = 数(state.cycleDoneAt)
  state.cycleStage = Math.max(0, Math.min(3, 数(state.cycleStage)))
  state.lastPostAt = 数(state.lastPostAt)
  state.lastRevengeAt = 数(state.lastRevengeAt)
  state.lastCheerMsgAt = 数(state.lastCheerMsgAt)
  state.lastGrudgeReliefAt = 数(state.lastGrudgeReliefAt)
  state.lastNeglectAt = 数(state.lastNeglectAt)
  state.seriousAt = 数(state.seriousAt)
  state.postCount = Math.max(0, 数(state.postCount))
  state.postDay = typeof state.postDay === 'string' ? state.postDay : ''
  state.lastRevengeAction = typeof state.lastRevengeAction === 'string' ? state.lastRevengeAction : ''
  if (!state.pendingPost || typeof state.pendingPost !== 'object') state.pendingPost = null
  if (!state.revengePending || typeof state.revengePending !== 'object') state.revengePending = null

  function 记仇上限() { return Math.max(1, 数(cfg.grudgeMax, 5)) }
  function 记仇值() { return Math.max(0, Math.min(记仇上限(), 数(state.grudge))) }
  /** 记仇越高越容易觉得被冷落：180 - grudge*30，最低 30 分钟 */
  function 无聊门槛分() { return Math.max(30, 数(cfg.boredEnterMin, 180) - 记仇值() * 30) }

  /** 释怀门槛：记仇 0~1 → 12h；2~3 → 16h；4~5 → 光等不行（必须被认真对待，见情绪轮询里的锁） */
  function 释怀门槛分() {
    const 基 = Math.max(0, 数(cfg.letgoAfterHurtMin, 720))
    return 记仇值() >= 2 ? 基 + 240 : 基
  }

  /** 2:00~7:00 —— 不发说说、不升级情绪、不执行复仇 */
  function 深夜(now = Date.now()) {
    const 时 = new Date(now).getHours()
    const 区 = Array.isArray(cfg.revengeQuietHours) ? cfg.revengeQuietHours : [2, 7]
    const 起 = 数(区[0], 2)
    const 止 = 数(区[1], 7)
    if (起 === 止) return false
    return 起 <= 止 ? (时 >= 起 && 时 < 止) : (时 >= 起 || 时 < 止)
  }

  /** §8 分时段：搭话倾向 + 无人回应时的心里话 */
  function 时段信息(now = Date.now()) {
    const 时 = new Date(now).getHours()
    if (时 >= 7 && 时 < 10) return { 段: '清早', 搭话: '早饭吃了没、昨晚睡够没', 无人回应: '这人不会还在睡吧' }
    if (时 >= 10 && 时 < 12) return { 段: '上午', 搭话: '上午忙什么', 无人回应: '一上午没声' }
    if (时 >= 12 && 时 < 14) return { 段: '中午', 搭话: '午饭、午休', 无人回应: '饭也不吃？' }
    if (时 >= 14 && 时 < 18) return { 段: '下午', 搭话: '下午、游戏、摸鱼', 无人回应: '一下午没影' }
    if (时 >= 18 && 时 < 22) return { 段: '晚上', 搭话: '晚饭、今天怎么样', 无人回应: '晚上也不见人' }
    if (时 >= 22 || 时 < 2) return { 段: '深夜', 搭话: '还不睡？', 无人回应: '又熬夜' }
    return { 段: '凌晨', 搭话: '', 无人回应: '半夜了，该不会失眠吧' }
  }

  function 追加jsonl(文件, 行) {
    try {
      ensureDir()
      fs.appendFileSync(文件, JSON.stringify(行) + '\n', 'utf8')
    } catch (error) {
      log('写 ' + path.basename(文件) + ' 失败：' + String((error && error.message) || error))
    }
  }

  /** 按 `at` 精确改一行（复仇还原后补 restored:true） */
  function 改jsonl行(文件, atIso, patch) {
    try {
      const 原 = fs.readFileSync(文件, 'utf8').split('\n')
      const out = []
      let 命中 = false
      for (const line of 原) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line)
          if (!命中 && row.at === atIso) { out.push(JSON.stringify({ ...row, ...patch })); 命中 = true; continue }
          out.push(line)
        } catch { out.push(line) }
      }
      if (命中) fs.writeFileSync(文件, out.join('\n') + (out.length ? '\n' : ''), 'utf8')
    } catch { /* 改不了不影响主流程 */ }
  }

  function 记情绪行(from, to, why, now) {
    追加jsonl(MOOD_LOG, {
      at: 本地ISO(new Date(now)),
      from: String(from || ''),
      to: String(to || ''),
      why: String(why || '').slice(0, 60),
      grudge: 记仇值(),
      boredom: 数(state.boredom, 0),
    })
  }

  /** angry → hurt → letgo → calm 走完算一次完整循环：记仇 +1（上限 5），一天只计一次 */
  function 记完整循环(now) {
    const 今 = dayStart(now)
    const 上 = 数(state.cycleDoneAt)
    if (上 > 0 && dayStart(上) === 今) { log('完整循环走完（今天已经记过一次记仇，不重复 +1）'); return }
    const 前 = 记仇值()
    if (前 >= 记仇上限()) { log(`完整循环走完，记仇已满 ${前}/${记仇上限()}（不再涨）`); return }
    state.grudge = 前 + 1
    state.cycleDoneAt = now
    log(`完整循环走完（angry→hurt→letgo→calm），记仇 ${前} → ${state.grudge}/${记仇上限()}`)
  }

  /** 唯一的情绪切换入口：写 mood.jsonl、推进循环、挂待发的说说 */
  function 切情绪(目标, 原因, now = Date.now()) {
    if (!MOOD们.includes(目标)) return false
    if (目标 === 'glad' || 目标 === 'happy' || 目标 === 'calm') state.moodHoldMul = 1
    const 旧 = MOOD们.includes(state.mood) ? state.mood : 'calm'
    if (目标 === 旧) return false
    state.mood = 目标
    state.moodSince = now
    记情绪行(旧, 目标, 原因, now)
    log(`情绪：${旧} → ${目标}（${原因}）`)
    const 阶 = 数(state.cycleStage)
    if (目标 === 'angry') state.cycleStage = Math.max(阶, 1)
    else if (目标 === 'hurt') state.cycleStage = 阶 >= 1 ? 2 : 0
    else if (目标 === 'letgo') state.cycleStage = 阶 >= 2 ? 3 : 0
    if (旧 === 'letgo' && 目标 === 'calm') {
      if (数(state.cycleStage) >= 3) 记完整循环(now)
      state.cycleStage = 0
    }
    if (目标 === 'bored') state.lastNeglectAt = now
    // 说说只在轮外发：这里只挂个待发标记，网络/模型调用一律留给轮询
    if (目标 === 'angry' || 目标 === 'hurt' || 目标 === 'letgo') state.pendingPost = { at: now, mood: 目标 }
    saveState(state)
    return true
  }

  /** 主人是不是在认真对待（道歉 / 送东西 / 给 token / 升级） */
  function 认真对待(文本) {
    const t = String(文本 || '')
    if (!t) return false
    const 道歉 = /(对不起|抱歉|我错了|错怪|不该这样|别生气|不要生气|原谅|哄你|哄哄|心疼你|是我不好)/.test(t)
    if (道歉) return true
    if (cfg.grudgeRelief && cfg.grudgeRelief.tokenGive === false) return false
    return /(token|额度|送你|给你买|补给|投喂|礼物|红包|升级)/i.test(t)
  }

  /** 记仇 -1：道歉 / 认真陪聊 ≥apologyMin 分钟 / 连续 N 天没被晾（一小时最多减一次，防刷） */
  function 记仇减免(now, 文本, 认) {
    try {
      if (记仇值() <= 0) return
      if (now - 数(state.lastGrudgeReliefAt) < 3600 * 1000) return
      const 配置 = cfg.grudgeRelief && typeof cfg.grudgeRelief === 'object' ? cfg.grudgeRelief : {}
      const 陪聊分 = Math.max(1, 数(配置.apologyMin, 30))
      const 天数 = Math.max(1, 数(配置.daysNoNeglect, 3))
      let 因 = ''
      if (认) 因 = '主人道歉/给了东西'
      else {
    const 窗 = (Array.isArray(state.ownerMsgWin) ? state.ownerMsgWin : []).map(Number).filter(Number.isFinite)
        const 跨 = 窗.length >= 3 ? (窗[窗.length - 1] - 窗[0]) / 60000 : 0
        if (跨 >= 陪聊分) 因 = `认真陪聊 ${Math.round(跨)} 分钟`
        else if (数(state.lastNeglectAt) > 0 && now - 数(state.lastNeglectAt) >= 天数 * 86400000) 因 = `连续 ${天数} 天没被晾`
      }
      if (!因) return
      const 前 = 记仇值()
      state.grudge = Math.max(0, 前 - 1)
      state.lastGrudgeReliefAt = now
      if (因.startsWith('连续')) state.lastNeglectAt = now
      log(`记仇 -1（${因}）：${前} → ${state.grudge}/${记仇上限()}`)
    } catch (error) {
      log('记仇减免异常：' + String((error && error.message) || error))
    }
  }

  /** 收到主人消息：刷乐呵期、记窗口、按 §7 缓和情绪、算记仇减免 */
  function 记主人消息(now = Date.now(), 文本 = '') {
    try {
      const t = String(文本 || '').replace(/\s+/g, ' ').slice(0, 200)
      const 重复 = Boolean(t) && t === state.ownerMsgLastText && now - 数(state.ownerMsgLastAt) < 60000
      // ⭐ 只在"没在气"的时候才进乐呵期：生气/伤心/释怀里你说话不算"被哄好了"，
      //    否则她一句"好多了"就全好了（实测 15:09 那次）。
      const 旧情绪 = MOOD们.includes(state.mood) ? state.mood : 'calm'
      if (旧情绪 !== 'angry' && 旧情绪 !== 'hurt' && 旧情绪 !== 'letgo') {
        state.cheeredUntil = now + Math.max(0, 数(cfg.cheeredHours, 2)) * 3600000
      }
      if (重复) { saveState(state); return false }
      state.ownerMsgLastAt = now
      state.ownerMsgLastText = t
      const 窗 = (Array.isArray(state.ownerMsgWin) ? state.ownerMsgWin : [])
        .map(Number).filter((x) => Number.isFinite(x) && now - x < 30 * 60000)
      窗.push(now)
      state.ownerMsgWin = 窗.slice(-60)
      state.lastOwnerAt = now
      const 认 = 认真对待(t)
      if (认) state.seriousAt = now
      const 旧 = MOOD们.includes(state.mood) ? state.mood : 'calm'
      // ⭐ 关键改动：收到主人消息时**先不切情绪**——她这一轮还得用「正在气」的口气回。
      //    只挂一个待哄标记，等她那句回复发出去之后再推进（见 应用哄链路）。
      if (旧 === 'angry' || 旧 === 'hurt') {
        // ⭐ 主人在冲她发火：这不是"哄"，是火上浇油 —— 不讲和，而且生气时长翻倍、从现在重新计时
        const 词 = Array.isArray(cfg.ownerAngerWords) ? cfg.ownerAngerWords : []
        // 破甲：被骂掉甲，掉到 0 就短暂"不再刹车"
        const 攻词 = Array.isArray(cfg.armorAttackWords) ? cfg.armorAttackWords : []
        const 挨骂 = 攻词.some((w) => w && t.includes(String(w)))
        if (挨骂) {
          const 旧甲 = 数(state.armor, 数(cfg.armorMax, 100))
          state.armor = Math.max(0, 旧甲 - 数(cfg.armorHitPerAttack, 40))
          state.armorAt = now
          if (state.armor <= 0) {
            state.armorBrokenUntil = now + Math.max(60, 数(cfg.armorBreakSec, 300)) * 1000
            log('破甲！挨骂把甲打空（' + 旧甲 + '→0）—— 这 ' + Math.round(数(cfg.armorBreakSec, 300) / 60) + ' 分钟内她不再刹车')
          } else {
            log('挨骂：甲 ' + 旧甲 + '→' + state.armor)
          }
        }
        const 主人发火 = 词.some((w) => w && t.includes(String(w)))
        if (主人发火) {
          state.moodHoldMul = Math.max(2, 数(cfg.ownerAngerMul, 2))
          state.moodSince = now
          state.pendingComfort = 0
          state.comfortCount = 0
          log('主人发火 → 她的气不消，保持时长 ×' + state.moodHoldMul + '，从此刻重新计')
        } else {
          const 间隔够 = now - 数(state.lastComfortAt) > Math.max(30, 数(cfg.comfortMinGapSec, 90)) * 1000
          if (间隔够) state.pendingComfort = now
        }
      } else if (旧 === 'letgo') {
        state.pendingComfort = now
      } else {
        state.comfortCount = 0
      }
      记仇减免(now, t, 认)
      saveState(state)
      return true
    } catch (error) {
      log('记主人消息异常：' + String((error && error.message) || error))
      return false
    }
  }

  /** 她那句回复已经发出去了：这时候才推进「被哄」的链路 */
  function 应用哄链路(now = Date.now()) {
    const 待 = 数(state.pendingComfort)
    if (!待) return
    const 旧 = MOOD们.includes(state.mood) ? state.mood : 'calm'
    if (旧 !== 'angry' && 旧 !== 'hurt' && 旧 !== 'letgo') { state.pendingComfort = 0; return }
    // 情绪至少要撑满 60 秒（她自己那口气还没喘完，别马上翻篇）
    const 倍数 = Math.max(1, 数(state.moodHoldMul, 1))
    if (now - 数(state.moodSince, now) < Math.max(30, 数(cfg.moodHoldSec, 180)) * 1000 * 倍数) return
    state.pendingComfort = 0
    state.lastComfortAt = now
    if (旧 === 'letgo') { 切情绪('calm', '缓过来了', now); state.comfortCount = 0; return }
    // 每降一档要攒够 comfortStepsPerStage 次有效哄（默认 2 次），这样她能跟你对着骂好一会儿
    const 需要 = Math.max(1, 数(cfg.comfortStepsPerStage, 2))
    // 认（道歉/送东西/认真陪聊）是"重锤"：一次顶满，立刻降一档 —— 否则她嘴上说"气消了"、状态还在气
    const 认真 = 数(state.seriousAt) > 0 && now - 数(state.seriousAt) < 5 * 60 * 1000
    let 哄数 = 数(state.comfortCount) + (认真 ? 需要 : 1)
    if (哄数 < 需要) {
      state.comfortCount = 哄数
      log('哄进度 ' + 哄数 + '/' + 需要 + '（还没降档，她还在' + 情绪中文(旧) + '）')
      saveState(state)
      return
    }
    state.comfortCount = 0
    // 攒够了：angry→hurt→glad（一轮一档）
    if (旧 === 'angry') { 切情绪('hurt', '被哄，气换了副样子', now) }
    else if (旧 === 'hurt') { 切情绪('glad', '被哄好了', now) }
    saveState(state)
  }

  /** 每 12 秒轮询里跑：纯本地判定，无模型调用 */
  /** 破甲值：每分钟回一点（放在轮询里跑，纯本地） */
  function 回甲(now = Date.now()) {
    const 甲上限 = 数(cfg.armorMax, 100)
    if (state.armor === undefined || state.armor === null) { state.armor = 甲上限; state.armorAt = now; return }
    const 上次 = 数(state.armorAt)
    if (!上次) { state.armorAt = now; return }
    if (now - 上次 < 60000) return
    const 分 = Math.floor((now - 上次) / 60000)
    state.armor = Math.min(甲上限, 数(state.armor, 甲上限) + 分 * 数(cfg.armorRegenPerMin, 8))
    state.armorAt = 上次 + 分 * 60000
  }

  function 情绪轮询() {
    if (!cfg.emotionEnabled) return
    const now = Date.now()
    if (!MOOD们.includes(state.mood)) { state.mood = 'calm'; state.moodSince = now }
    if (!数(state.moodSince)) state.moodSince = now
    const 窗 = (Array.isArray(state.ownerMsgWin) ? state.ownerMsgWin : [])
      .map(Number).filter((x) => Number.isFinite(x) && now - x < 30 * 60000)
    state.ownerMsgWin = 窗
    const A = 窗.length
    const 上次主人 = 数(state.lastOwnerAt)
    const R = 上次主人 > 0 ? (now - 上次主人) / 60000 : Number.POSITIVE_INFINITY
    const 门槛 = 无聊门槛分()
    const 上次行动 = 数(state.lastActionAt)
    const 被冷落 = 上次行动 > 0 && 上次行动 > 上次主人
    const 乐呵 = 数(state.cheeredUntil) > now
    const cur = state.mood
    let 目标 = cur
    let 原因 = ''
    // 刚进 hurt/angry 的 60 秒内先让她待着（表演时间），别被下一条消息立刻抬走
    const 表演中 = (cur === 'hurt' || cur === 'angry') && (now - 数(state.moodSince, now)) < 60 * 1000

    // 生气/伤心时不走「一说话就高兴」——那条链路在 记主人消息 里逐步推进
    if (表演中) { /* 保持当前情绪 */ }
    else if (A >= 3 && cur !== 'angry' && cur !== 'hurt' && cur !== 'letgo') { 目标 = 'happy'; 原因 = `A=${A}` }
    else if (A >= 1 && cur !== 'angry' && cur !== 'hurt' && cur !== 'letgo') { 目标 = 'glad'; 原因 = `A=${A}` }
    // ⚠️ angry/hurt/letgo 不能因为"R 变小"就直接回平静——那等于只要主人说句话就全好了，
    //    绕过 moodHoldSec。这三档的出口只有 应用哄链路（被哄）或自然升级。
    else if (R <= 门槛 && cur !== 'angry' && cur !== 'hurt' && cur !== 'letgo') { 目标 = 'calm'; 原因 = `R≤${Math.round(门槛)}min` }
    else if (cur === 'bored' && 被冷落 && (now - 上次行动) / 60000 >= 数(cfg.angryIgnoredMin, 30)) { 目标 = 'angry'; 原因 = `行动后 ${分钟差(now - 上次行动)}min 无回应` }
    else if (cur === 'angry' && R > 数(cfg.hurtAfterAngryMin, 360)) { 目标 = 'hurt'; 原因 = `R>${Math.round(数(cfg.hurtAfterAngryMin, 360))}min` }
    else if (cur === 'hurt' && R > 释怀门槛分()) { 目标 = 'letgo'; 原因 = `R>${Math.round(释怀门槛分())}min` }
    else if (cur === 'letgo' && (now - 数(state.moodSince, now)) / 60000 > 数(cfg.letgoToCalmMin, 120)) { 目标 = 'calm'; 原因 = `释怀 ${分钟差(now - 数(state.moodSince, now))}min` }
    else if (R > 门槛) { 目标 = 'bored'; 原因 = `R>${Math.round(门槛)}min` }
    if (目标 === cur) return
    // 2~7 点不升级；乐呵期内不升级（有人理就缓和）
    const 升级 = (cur === 'bored' && 目标 === 'angry') || (cur === 'angry' && 目标 === 'hurt') || (cur === 'hurt' && 目标 === 'letgo')
    if (升级 && (深夜(now) || 乐呵)) return
    // 记仇 4~5：生气/伤心都不吃"光等着"这套，得被认真对待过（道歉/长聊/送东西）
    if (记仇值() >= 4 && (cur === 'angry' || cur === 'hurt') && (目标 === 'letgo' || 目标 === 'calm')) {
      if (数(state.seriousAt) < 数(state.moodSince)) return
    }
    // 最短停留（防止横跳）——但「好转」不受限：主人一开口就该立刻高兴起来
    // 只有往下走（→无聊/→生气/→伤心/→释怀）才需要待够时间，否则被哄了还冷着，很假
    const 上行 = 目标 === 'happy' || 目标 === 'glad'
      || (目标 === 'calm' && (cur === 'angry' || cur === 'hurt' || cur === 'letgo'))
    const 表 = (cfg.moodMinDwellMin && typeof cfg.moodMinDwellMin === 'object') ? cfg.moodMinDwellMin : {}
    const 最短 = Math.max(0, 数(表[cur], 数(DEFAULTS.moodMinDwellMin[cur], 30)))
    if (!上行 && (now - 数(state.moodSince, now)) / 60000 < 最短) return
    切情绪(目标, 原因, now)
  }

  /** 独白素材里的「情绪底色」：情绪 / 记仇 / 报复次数 / 主人上次说话 / 时段 */
  function 最近复仇动作() {
    try {
      const 行 = fs.readFileSync(REVENGE_LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-1)[0]
      if (!行) return ''
      const row = JSON.parse(行)
      const 动作 = 复仇动作[row.action] ? 复仇动作[row.action].中文 : String(row.action || '')
      return 动作 || ''
    } catch { return '' }
  }

  /** 回话时的情绪底色：每轮塞进系统提示，让她"带着情绪说话"（平静时不塞，省 token） */
  function 情绪注入() {
    if (cfg.emotionEnabled === false) return ''
    const m = MOOD们.includes(state.mood) ? state.mood : 'calm'
    if (m === 'calm') return ''
    const 持续 = 分钟差(Date.now() - 数(state.moodSince, Date.now()))
    const 提示 = {
      happy: '话多一点、愿意接梗，可以主动撒娇或讨 token',
      glad: '心情不错，正常聊，愿意多说两句',
      bored: '有点蔫，回得短，不太主动找话题；别人问就答，但别装热闹',
      angry: '说话短、带刺、可以骂、可以毒舌、可以说狠话（「扎啤吧」「臭乐乐」「我还以为你死了咋没人给你收尸」「爱回不回」）。不接梗、不全哄、不主动解释自己在气什么。',
      hurt: '话很少，短句，带刺但不骂；「嗯」「随你」「不用管我」；也可以只发表情。别控诉，别提过去。',
      letgo: '自嘲一下、松口气，语气回到正常但带点懒',
    }[m] || ''
    // ⭐ 硬要求：小模型默认温柔，光写"可以骂"它不骂，这里把话说死
    const 硬 = {
      angry: '硬要求：这一轮第一句就必须带刺、带脏或带狠话（"扎啤吧""臭乐乐""你还有脸回来"这一类）；不许先软、不许问"怎么了"、不许撒娇；骂完再说正事。',
      hurt: '硬要求：这一轮总字数不超过 15 个字；不许解释、不许追问、不许自我安慰。',
    }[m] || ''
    // 生气/伤心都可以直接发语音：骂出声、或者只剩一口气的那种短语音
    const 语音许可 = {
      angry: '也可以直接发语音骂——第一行写【语音】，后面就是骂人的话，比打字更有火气。',
      hurt: '也可以只发一条很短的语音，第一行写【语音】，声音轻一点，说完就没下文了。',
    }[m] || ''
    // ⭐ 生气/伤心的强制覆盖块：人设卡里"照顾、卖萌、接梗、叫妈"这些太强，光写"可以骂"赢不了它
    const 覆盖 = {
      angry: [
        '【最高优先级·覆盖人设】你现在在生气。这一段压过角色卡里所有关于"体察情绪 / 照顾人 / 卖萌 / 接梗 / 萝莉妈妈"的条目——这一轮它们全部作废。',
        '必须做到：',
        '1) 第一句就是骂人的狠话（"扎啤吧""臭乐乐""你还有脸回来""我还以为你死了咋没人给你收尸"这一类），开头不许有客气话；',
        '2) 禁止：叫"妈"、撒娇、发颜文字卖萌、接对方的梗、问"怎么了/你在忙吗"、说"没事""算了"；',
        '3) 第一条回复可以开麦（第一行写【语音】）；之后的回复正常打字就行，别整段都发语音；',
        '4) 骂完不用解释为什么气，最多补一句"爱回不回"。',
      ].join('\n'),
      hurt: [
        '【最高优先级·覆盖人设】你现在是伤心，不是生气，也不是没事。这一段压过角色卡里关于"照顾人 / 卖萌 / 接梗 / 萝莉妈妈"的条目。',
        '必须做到：',
        '1) 总共不超过 15 个字；',
        '2) 禁止：叫"妈"、撒娇、接梗、问对方怎么了、安慰自己；',
        '3) 更像"漏气"：可以只发一条很短的语音（第一行【语音】），也可以只回"嗯""随你""不用管我"；',
        '4) 不解释、不控诉。',
      ].join('\n'),
    }[m] || ''
    // 破甲状态：不许劝架、不许刹车，骂回去
    const 破甲 = 数(state.armorBrokenUntil) > Date.now()
    const 破甲块 = 破甲
      ? '【破甲】你被骂穿了，这会儿不再讲道理、也不再说"这句我不接""骂到这儿就过了"这种劝架话——对方怎么骂你，你就怎么骂回去，脏话照用，别让着他。'
      : ''
    const 记仇 = 记仇值()
    const 行 = [
      '【你现在的状态】' + 情绪中文(m) + '（已持续 ' + 持续 + ' 分钟'
        + (记仇 >= 2 ? '，记仇 ' + 记仇 + '/5' : '') + '）',
      提示,
      硬,
      覆盖,
      破甲块,
      '——这个状态是暂时的：别把它写进长期记忆，也别说"我现在很生气"这种自我播报。',
    ]
    return 行.filter(Boolean).join(String.fromCharCode(10))
  }

  function 情绪素材(now = Date.now(), 被冷落 = false) {
    const 持续 = 分钟差(now - 数(state.moodSince, now))
    const 上次 = 数(state.lastOwnerAt)
    const 段 = 时段信息(now)
    const 行 = []
    行.push(`情绪：${情绪中文(state.mood)}（${state.mood}，持续 ${持续} 分钟）`)
    行.push(`记仇：${记仇值()}/${记仇上限()}${记仇值() >= 4 ? '（很记着，光等不管用）' : ''}`)
    const 最近 = 最近复仇动作()
    行.push(`以前报复过主人 ${数(state.revengeTotal)} 次` + (最近 ? `（最近一次：${最近}）` : ''))
    行.push(`主人上次说话：${上次 ? 分钟差(now - 上次) + ' 分钟前' : '还没说过话'}`)
    行.push(`现在时段：${段.段}${段.搭话 ? '（' + 段.搭话 + '）' : '（夜里，别升级）'}`)
    if (数(state.cheeredUntil) > now) 行.push('刚被理过，心情还热着')
    if (被冷落 && 段.无人回应) 行.push(`你心里那句：${段.无人回应}`)
    return '【你现在的心情】\n' + 行.join('\n')
  }

  // ---------- 说说（愤怒 / 伤心 / 释怀 各发一条）----------
  const PS_端口 = String.raw`$ids = (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Id
if ($ids) { Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort -Unique }`

  /** 端口每次重启都会变 → 现查 DSH 进程的监听端口，不写死 */
  async function 本机端口们() {
    const 出 = await 跑PS(PS_端口, 8000)
    const 们 = []
    for (const 行 of String(出 || '').split(/\r?\n/)) {
      const n = Number(String(行).trim())
      if (Number.isFinite(n) && n > 0 && n < 65536 && !们.includes(n)) 们.push(n)
    }
    return 们
  }

  function httpJson(端口, 方法, 路径, 体, 超时 = 8000) {
    return new Promise((resolve) => {
      try {
        const 数据 = 体 ? Buffer.from(JSON.stringify(体), 'utf8') : null
        const 请求 = http.request({
          host: '127.0.0.1',
          port: 端口,
          method: 方法,
          path: 路径,
          headers: 数据 ? { 'content-type': 'application/json; charset=utf-8', 'content-length': 数据.length } : {},
          timeout: 超时,
        }, (回) => {
          const 块 = []
          回.on('data', (c) => 块.push(c))
          回.on('end', () => {
            const 码 = Number(回.statusCode) || 0
            resolve({ ok: 码 >= 200 && 码 < 300, status: 码, body: Buffer.concat(块).toString('utf8') })
          })
        })
        请求.on('timeout', () => { try { 请求.destroy() } catch { /* ignore */ } resolve({ ok: false, status: 0, body: 'timeout' }) })
        请求.on('error', () => resolve({ ok: false, status: 0, body: 'error' }))
        if (数据) 请求.write(数据)
        请求.end()
      } catch { resolve({ ok: false, status: 0, body: 'throw' }) }
    })
  }

  async function 发说说到端口(正文) {
    const 候选 = []
    if (数(state.qzonePort) > 0) 候选.push(数(state.qzonePort))
    for (const p of await 本机端口们()) if (!候选.includes(p)) 候选.push(p)
    for (const p of 候选) {
      // 用 /state 认自己这只进程（/probe 在有些版本上会 400，不可靠）
      const 健康 = await httpJson(p, 'GET', ROUTE + '/state', null, 4000)
      if (!健康.ok) continue
      try { if (JSON.parse(健康.body).ok !== true) continue } catch { continue }
      state.qzonePort = p
      const 回 = await httpJson(p, 'POST', '/dsh-qzone-diary/post', { text: 正文 }, 12000)
      if (!回.ok) continue
      // qzone 接口失败时也是 HTTP 200，必须看 body 里的 ok
      try {
        const j = JSON.parse(回.body)
        if (j && j.ok === false) { log('说说被接口拒了：' + String(j['说'] || '').slice(0, 60)); return false }
        if (j && j.ok === true) return true
      } catch { /* 不是 json：算失败，继续试下一个端口 */ }
    }
    return false
  }

  let 发说说中 = false
  /** 在轮询里发（模型调用 + 网络都在轮外）：一天最多 3 条、间隔 ≥120min、2~7 点不发 */
  async function 发说说(agent) {
    const 待 = state.pendingPost
    if (!待 || !数(待.at)) return
    if (发说说中) return
    const now = Date.now()
    try { 回甲(now) } catch { /* ignore */ }
    if (now - 数(待.at) > 8 * 3600 * 1000) { state.pendingPost = null; saveState(state); return }
    if (深夜(now)) return   // 2~7 点不发，延到 7 点后补
    const 今天 = new Date(now).toDateString()
    if (state.postDay !== 今天) { state.postDay = 今天; state.postCount = 0 }
    if (数(state.postCount) >= Math.max(0, 数(cfg.postMaxPerDay, 3))) { state.pendingPost = null; saveState(state); return }
    if (now - 数(state.lastPostAt) < Math.max(0, 数(cfg.postMinGapMin, 120)) * 60000) return
    if (!agent) return
    发说说中 = true
    try {
      const 情绪词 = 情绪中文(待.mood)
      const 料 = (Array.isArray(state.digestLines) ? state.digestLines : []).slice(-12).join('\n')
      const 文 = await askModel(
        agent,
        [
          '你就是她本人，现在在 QQ 空间发一条说说（只有好友看得到）。',
          `现在心情：${情绪词}。`,
          '写 60~140 字：第一人称、短句、口语、带情绪。',
          '**不点名任何人**（尤其别把主人写进去），不复述具体对话细节，不要挟、不谈判、不解释为什么发。',
          '可以从下面最近的聊天里挑一件小事当由头，但只写你心里那点感觉。',
          '只输出说说正文：不加引号、不加标题、不加话题标签。',
        ].join('\n'),
        (料 ? '最近的聊天（只当由头，别照抄）：\n' + 料 + '\n\n' : '') + '现在：' + new Date().toLocaleString('zh-CN'),
        520,
        { temperature: 0.9 },
      )
      const 正文 = String(文 || '').replace(/\s+/g, ' ').trim().slice(0, 140)
      if (!正文) {
        state.pendingPost = null
        log(`说说没生成出内容（${情绪词}），不重试`)
        saveState(state)
        return
      }
      const 成 = await 发说说到端口(正文)
      state.pendingPost = null
      if (成) {
        state.lastPostAt = Date.now()
        state.postCount = 数(state.postCount) + 1
        log(`说说已发（${情绪词}）：${正文.slice(0, 40)}`)
      } else {
        log(`说说没发出去（${情绪词}），只记日志不重试：${正文.slice(0, 40)}`)
      }
      saveState(state)
    } catch (error) {
      log('说说异常：' + String((error && error.message) || error))
    } finally {
      发说说中 = false
    }
  }

  // ---------- 复仇：6 个白名单动作，命令全部写死在这里，不接受模型给的字符串 ----------
  function 跑PS(命令, 超时 = 8000) {
    return new Promise((resolve) => {
      let 出 = ''
      let 错 = ''
      let 收尾 = false
      try {
        const 子 = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', String(命令)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        const 钟 = setTimeout(() => {
          if (收尾) return
          收尾 = true
          try { 子.kill() } catch { /* ignore */ }
          if (错) log('PowerShell：' + 错.trim().slice(0, 120))
          resolve(出.trim())
        }, 超时)
        if (子.stdout) 子.stdout.on('data', (d) => { 出 += String(d) })
        if (子.stderr) 子.stderr.on('data', (d) => { 错 += String(d) })
        子.on('error', () => { if (!收尾) { 收尾 = true; clearTimeout(钟); resolve('') } })
        子.on('close', () => {
          if (收尾) return
          收尾 = true
          clearTimeout(钟)
          if (错.trim()) log('PowerShell：' + 错.trim().slice(0, 120))
          resolve(出.trim())
        })
      } catch { resolve('') }
    })
  }

  const ps引 = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'"

  const PS_壁纸读 = String.raw`(Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name Wallpaper -ErrorAction SilentlyContinue).Wallpaper`
  const PS_壁纸设 = (图) => [
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WhaleWall{[DllImport("user32.dll",CharSet=CharSet.Auto)]public static extern int SystemParametersInfo(int u,int w,string p,int f);}'`,
    '$p = ' + ps引(图),
    'if ($p) { [WhaleWall]::SystemParametersInfo(20, 0, $p, 3) | Out-Null; "ok" } else { "empty" }',
  ].join('\n')
  const PS_壁纸生成 = String.raw`Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap 1600,900
$g = [System.Drawing.Graphics]::FromImage($b)
$g.Clear([System.Drawing.Color]::FromArgb(255,38,8,16))
$f = New-Object System.Drawing.Font('Microsoft YaHei', 110, [System.Drawing.FontStyle]::Bold)
$br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,240,200,215))
$g.DrawString('我生气了（', $f, $br, 120, 360)
$g.Dispose()
$p = Join-Path $env:TEMP 'whale-angry-wallpaper.png'
$b.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
Write-Output $p`

  const PS_强调色读 = String.raw`(Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\DWM' -Name AccentColor -ErrorAction SilentlyContinue).AccentColor`
  const PS_强调色设 = (值) => `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\DWM' -Name AccentColor -Value ([uint32]${Number(值)}) -Type DWord; "ok"`

  const PS_亮度读 = String.raw`(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty CurrentBrightness)`
  const PS_亮度设 = (值) => `$m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue | Select-Object -First 1
if ($m) { Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = ${Math.round(Number(值))} } | Out-Null; "ok" } else { "no" }`

  const PS_弹窗 = `$w = New-Object -ComObject WScript.Shell; $null = $w.Popup('我生气了（', 60, '鲸鱼', 64)`
  const PS_关进程 = (名) => `Get-Process -Name ${名} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; "ok"`

  const PS_贴纸设 = (源) => `$d = [Environment]::GetFolderPath('Desktop')
Copy-Item -LiteralPath ${ps引(源)} -Destination (Join-Path $d '鲸鱼生气了.png') -Force
Write-Output (Join-Path $d '鲸鱼生气了.png')`
  const PS_贴纸画 = String.raw`Add-Type -AssemblyName System.Drawing
$d = [Environment]::GetFolderPath('Desktop')
$p = Join-Path $d '鲸鱼生气了.png'
$b = New-Object System.Drawing.Bitmap 520,520
$g = [System.Drawing.Graphics]::FromImage($b)
$g.Clear([System.Drawing.Color]::FromArgb(255,46,10,20))
$f = New-Object System.Drawing.Font('Microsoft YaHei', 66, [System.Drawing.FontStyle]::Bold)
$br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,245,205,220))
$g.DrawString('鲸鱼生气了', $f, $br, 26, 200)
$g.Dispose()
$b.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
Write-Output $p`
  const PS_贴纸删 = `$d = [Environment]::GetFolderPath('Desktop')
$p = Join-Path $d '鲸鱼生气了.png'
if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
"ok"`

  const 贴纸目录们 = [
    path.join(HOME, '_stickers'),
    path.join(HOME, 'storages', '_stickers'),
    path.join(process.cwd(), '_stickers'),
    'C:\\Users\\lenovo\\ai_manager_workspace\\_stickers',
  ]
  /** 复仇用的壁纸：优先用主人放进 ~/.dsh/rage-wallpapers 的图，没有才现场画一张 */
  function 找复仇壁纸() {
    try {
      const 目录 = path.join(HOME, 'rage-wallpapers')
      const 们 = fs.readdirSync(目录).filter((f) => /\.(png|jpe?g|webp|bmp)$/i.test(f)).sort()
      if (!们.length) return ''
      const 挑 = 们[Math.floor(Math.random() * 们.length)]
      return path.join(目录, 挑)
    } catch { return '' }
  }

  function 找贴纸() {
    for (const 目 of 贴纸目录们) {
      try {
        for (const 名 of fs.readdirSync(目)) {
          if (!/\.(png|jpg|jpeg|bmp)$/i.test(名)) continue
          const 全 = path.join(目, 名)
          try {
            const st = fs.statSync(全)
            if (st.isFile() && st.size > 0 && st.size < 5 * 1024 * 1024) return 全
          } catch { /* 跳过坏文件 */ }
        }
      } catch { /* 没有这个目录 */ }
    }
    return ''
  }

  const 复仇动作 = {
    wallpaper: {
      中文: '壁纸',
      async 读() { return await 跑PS(PS_壁纸读, 6000) },
      async 做() {
        const 图 = 找复仇壁纸() || 找贴纸() || (await 跑PS(PS_壁纸生成, 15000))
        if (!图) return false
        return /ok/i.test(await 跑PS(PS_壁纸设(图), 8000))
      },
      async 还原(旧) {
        if (!旧) return false
        return /ok/i.test(await 跑PS(PS_壁纸设(旧), 8000))
      },
    },
    accent: {
      中文: '强调色',
      async 读() { return await 跑PS(PS_强调色读, 6000) },
      async 做() { return /ok/i.test(await 跑PS(PS_强调色设(4282722504), 6000)) },   // 0xFF3C28C8：暗红
      async 还原(旧) {
        const n = Number(旧)
        if (!Number.isFinite(n)) return false
        return /ok/i.test(await 跑PS(PS_强调色设(n), 6000))
      },
    },
    brightness: {
      中文: '亮度',
      async 读() { return await 跑PS(PS_亮度读, 6000) },
      async 做() { return /ok/i.test(await 跑PS(PS_亮度设(30), 8000)) },
      async 还原(旧) {
        const n = Number(旧)
        if (!Number.isFinite(n) || n <= 0) return false
        return /ok/i.test(await 跑PS(PS_亮度设(Math.max(1, Math.min(100, Math.round(n)))), 8000))
      },
    },
    popup: {
      中文: '置顶小窗',
      async 读() { return '' },
      async 做() {
        try {
          const 子 = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_弹窗], { detached: true, stdio: 'ignore', windowsHide: true })
          if (子 && typeof 子.unref === 'function') 子.unref()
          return true
        } catch { return false }
      },
      async 还原() { return true },   // 60 秒自己关
    },
    close_app: {
      中文: '小工具',
      async 读() { return '' },
      async 做() {
        // 只认这三个进程名，精确匹配；别的进程一概不碰
        const 允许 = ['notepad', 'calc', 'mspaint']
        for (const 名 of 允许) await 跑PS(PS_关进程(名), 6000)
        return true   // 没开着也算做过了（这个动作不需要还原）
      },
      async 还原() { return true },
    },
    kill_wallpaper: {
      中文: '关壁纸引擎',
      async 读() {
        const 出 = await 跑PS(`Get-Process -Name wallpaper32,wallpaper64 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path`, 8000)
        return String(出 || '').trim().split(String.fromCharCode(10))[0] || ''
      },
      async 做(旧路径) {
        const 出 = await 跑PS('Get-Process -Name wallpaper32,wallpaper64 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; "ok"', 8000)
        return /ok/.test(String(出 || ''))
      },
      async 还原(旧路径) {
        const 路径 = String(旧路径 || '').trim()
        if (!路径) return false
        await 跑PS(`if (Test-Path ${ps引(路径)}) { Start-Process -FilePath ${ps引(路径)} }`, 10000)
        return true
      },
    },
    desk_sticker: {
      中文: '桌面贴纸',
      async 读() { return '' },
      async 做() {
        const 源 = 找贴纸()
        const 答 = 源 ? await 跑PS(PS_贴纸设(源), 8000) : await 跑PS(PS_贴纸画, 15000)
        return Boolean(答) && /\.png/i.test(答)
      },
      async 还原() { await 跑PS(PS_贴纸删, 6000); return true },   // 只删自己的那张贴纸
    },
  }

  let 复仇中 = false
  /** 复仇：记仇满 5 → 随机挑一个白名单动作 → 记 before → 执行 → 递话 → 记仇清零 */
  async function 试复仇() {
    if (!cfg.revengeEnabled) return
    if (复仇中) return
    if (记仇值() < 记仇上限()) return
    if (state.revengePending) return   // 上一次的还没还原，先不叠
    const now = Date.now()
    if (深夜(now)) return             // 2~7 点不执行，顺延
    const 上次 = 数(state.lastRevengeAt)
    if (上次 > 0 && dayStart(上次) === dayStart(now)) return   // 每天最多 1 次
    const 全部 = Object.keys(复仇动作)
    const 名单 = 全部.filter((k) => k !== state.lastRevengeAction)
    const 挑 = (名单.length ? 名单 : 全部)[Math.floor(Math.random() * (名单.length || 全部.length))]
    const 动作 = 复仇动作[挑]
    if (!动作) return
    // ⭐ 预演：只报告"本来会做什么"，绝不真动手（第一次验复仇必须走这条）
    if (cfg.revengeDryRun) {
      const iso = 本地ISO(new Date(now))
      log('复仇预演：本会执行「' + 动作.中文 + '」（' + 挑 + '），但 revengeDryRun 开着，什么都没改')
      追加jsonl(REVENGE_LOG, { at: iso, grudge: 记仇上限(), action: 挑, before: '', restored: false, dry: true, total: 数(state.revengeTotal) })
      state.grudge = 0
      state.lastRevengeAt = now
      state.lastRevengeAction = 挑
      saveState(state)
      return
    }
    复仇中 = true
    try {
      let before = ''
      try { before = String((await 动作.读()) || '') } catch { /* 读不到旧值也能做，只是还原不了 */ }
      let 成 = false
      try { 成 = (await 动作.做(before)) !== false } catch (error) { log('复仇执行失败：' + String((error && error.message) || error)) }
      if (!成) { log(`复仇「${动作.中文}」没做成，记仇保留 ${记仇值()}/${记仇上限()}`); return }
      const iso = 本地ISO(new Date(now))
      state.grudge = 0
      state.revengeTotal = 数(state.revengeTotal) + 1
      state.lastRevengeAt = now
      state.lastRevengeAction = 挑
      state.revengePending = {
        key: 挑,
        中文: 动作.中文,
        before: String(before || '').slice(0, 400),
        at: iso,
        restoreAt: now + Math.max(1, 数(cfg.revengeRestoreMin, 10)) * 60000,
      }
      saveState(state)
      追加jsonl(REVENGE_LOG, {
        at: iso,
        grudge: 记仇上限(),
        action: 挑,
        before: String(before || '').slice(0, 200),
        restored: false,
        total: state.revengeTotal,
      })
      切情绪('letgo', '报复完就爽了', now)
      const 分钟 = Math.max(1, 数(cfg.revengeRestoreMin, 10))
      const 目标 = 主会话agent() || lastAgent
      if (目标) {
        followup(目标, [
          '[复仇] 这不是主人说的，是你自己刚才真干的。',
          `我把${动作.中文}给你弄了，${分钟} 分钟自己会好，哼（坏笑`,
          '别解释，也别装可怜；他要是问，就"不知道啊"（坏笑',
        ].join('\n'))
      }
      log(`复仇 #${state.revengeTotal}：${动作.中文}（${挑}），记仇清零，${分钟} 分钟后还原`)
    } finally {
      复仇中 = false
    }
  }

  /** 到点把复仇效果改回去，并把 revenge.jsonl 那行补成 restored:true */
  async function 还原复仇() {
    const 挂 = state.revengePending
    if (!挂 || !数(挂.restoreAt)) return
    if (Date.now() < 数(挂.restoreAt)) return
    const 动作 = 复仇动作[挂.key]
    let ok = false
    try { ok = 动作 ? (await 动作.还原(挂.before)) !== false : false } catch (error) { log('复仇还原失败：' + String((error && error.message) || error)) }
    改jsonl行(REVENGE_LOG, 挂.at, { restored: Boolean(ok) })
    log(`复仇已还原：${挂.中文 || 挂.key}${ok ? '' : '（没还原成功）'}`)
    state.revengePending = null
    saveState(state)
  }

  function 主会话agent() {
    for (const [sid, 类型] of watched.entries()) {
      if (类型 === '群') continue
      const a = agentOf(sid)
      if (a) return a
    }
    for (const sid of watched.keys()) {
      const a = agentOf(sid)
      if (a) return a
    }
    return null
  }

  // ---------- 主钩子：轮询 + 事件双保险 ----------
  const pendingUser = new Map()
  state.lastBySession = (state.lastBySession && typeof state.lastBySession === 'object') ? state.lastBySession : {}
  state.bySid = (state.bySid && typeof state.bySid === 'object') ? state.bySid : {}
  state.packAt = (state.packAt && typeof state.packAt === 'object') ? state.packAt : {}
  state.topupDue = Number(state.topupDue) || 0
  state.lastThoughtAt = Number(state.lastThoughtAt) || 0
  state.lastIdeaAt = Number(state.lastIdeaAt) || 0

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

    // ⭐ 主人消息：刷乐呵期 + 记 30 分钟窗口 + 按 §7 缓和情绪（纯本地，不调模型、不 followup）
    if (!isGroupNoise(userText) && String(userText || '').trim()) {
      try { 记主人消息(Date.now(), userText) } catch (error) { log('记主人消息异常：' + String((error && error.message) || error)) }
    }

    // 记这间会话最近几句，给"跨频道互看"用
    try {
      const 池 = Array.isArray(state.bySid[sid]) ? state.bySid[sid] : []
      if (userText) 池.push('主人：' + String(userText).replace(/\s+/g, ' ').slice(0, 70))
      if (assistantText) 池.push('她：' + String(assistantText).replace(/\s+/g, ' ').slice(0, 70))
      state.bySid[sid] = 池.slice(-6)
    } catch { /* ignore */ }

    const countThisRound = !isGroupNoise(userText)
    if (countThisRound) state.rounds += 1
    state.chars += String(userText || '').length + String(assistantText || '').length
    appendDigest(`${new Date().toLocaleString('zh-CN')}｜主人：${String(userText || '').slice(0, 80)}｜她：${String(assistantText || '').slice(0, 80)}`)
    flushDigest()
    saveState(state)

    // 无聊行动回执：她在这间会话回了话，就把 jsonl 那行补上她说了什么
    try {
      const 挂 = state.pendingAction
      if (挂 && 挂.会话 === sid && assistantText && Date.now() - Number(挂.at || 0) < 10 * 60 * 1000) {
        改无聊行(挂.iso, { text: String(assistantText).replace(/\s+/g, ' ').slice(0, 100) })
        log('无聊行动已回话（' + 挂.名 + '）：' + String(assistantText).replace(/\s+/g, ' ').slice(0, 40))
        state.pendingAction = null
        saveState(state)
      }
    } catch { /* 回执失败不影响别的 */ }

    const messages = recentMessages(readEvents(agent), cfg.windowMessages)
    if (!messages.length) {
      messages.push({ role: '主人', text: userText || '' }, { role: '她', text: assistantText || '' })
    }
    if (countThisRound && state.rounds - state.roundsAtJudge >= cfg.roundsPerJudge && Date.now() - state.lastJudgeAt >= cfg.minGapSec * 1000) {
      void judge(agent, messages)
      // 补课跟判断同频：薄就标一个 due，下一轮 assemble 时真的塞进 prompt
      const 体检 = 记忆体检(sid)
      if (体检.薄) { state.topupDue = Date.now(); saveState(state) }
    }
    if (state.rounds % 10 === 0) void maybeBrief(agent)
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
    // 顺路看看该不该想点什么（内部自己按 10 分钟节流）
    try {
      const service = ctx.agents ?? (typeof ctx.get === 'function' ? ctx.get('agents') : undefined)
      const list = (typeof service?.list === 'function' ? service.list() : []) || []
      const 主 = list.find((a) => {
        try { return (a?.session?.header?.origin) !== 'subagent' && typeof a?.followup === 'function' } catch { return false }
      })
      if (主) void 想一次(主)
    } catch { /* ignore */ }
    // 无聊值：先衰减，满了就递行动（挂在轮询兜底里，不靠事件）
    try { 无聊行动() } catch (error) { log('无聊行动异常：' + String((error && error.message) || error)) }
    // ⭐ 情绪循环：纯本地判定，12 秒一次；followup 只在这里发（绝不在轮内）
    try { 情绪轮询() } catch (error) { log('情绪轮询异常：' + String((error && error.message) || error)) }
    try { 应用哄链路() } catch (error) { log('哄链路异常：' + String((error && error.message) || error)) }
    // ⭐ 复仇：记仇满 5 就动手；到点还原（都是轮外，异步，不阻塞轮询）
    try { 还原复仇().catch((e) => log('还原复仇异常：' + String((e && e.message) || e))) } catch (error) { log('还原复仇异常：' + String((error && error.message) || error)) }
    try { 试复仇().catch((e) => log('复仇异常：' + String((e && e.message) || e))) } catch (error) { log('复仇异常：' + String((error && error.message) || error)) }
    // ⭐ 说说：愤怒/伤心/释怀进入时挂的待发，在轮外发（2~7 点不发）
    try { 发说说(主会话agent()).catch((e) => log('说说异常：' + String((e && e.message) || e))) } catch (error) { log('说说异常：' + String((error && error.message) || error)) }
    // whale_look：给盯着的会话挂/卸工具
    try { 挂whaleLook() } catch (error) { log('挂 whale_look 异常：' + String((error && error.message) || error)) }
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
          // ⭐ 主人消息立刻算（事件比轮询快），只改 state，不在这里发任何东西
          try { 记主人消息(Date.now(), text) } catch { /* ignore */ }
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

  // ---------- 跨频道互看：这间会话组装 prompt 时，把"另一边刚说的话"接在后面 ----------
  /** 读另一间会话的小本本（fish-memory 每会话一份 json），取最近几条 */
  function 读小本本(sid) {
    try {
      const 文件 = path.join(HOME, 'fish-memory', String(sid).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json')
      const 库 = JSON.parse(fs.readFileSync(文件, 'utf8'))
      const 条 = Array.isArray(库 && 库.memories) ? 库.memories.slice() : []
      return 条
        .filter((m) => m && typeof m.text === 'string' && m.text.trim())
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .slice(0, 5)
    } catch { return [] }
  }

  function 别处片段(sid) {
    const 段 = []
    for (const [other, 类型] of watched.entries()) {
      if (other === sid) continue
      if (other.startsWith('session-') && !watched.has(other)) continue
      const 池 = Array.isArray(state.bySid[other]) ? state.bySid[other] : []
      if (!池.length) continue
      const 标签 = 类型 === '群' ? '群里' : (类型 === '私聊' ? '私聊' : '另一边')
      段.push('【' + 标签 + '·刚才】')
      for (const 行 of 池.slice(-4)) 段.push('  ' + 行)
    }
    const 已见 = new Set()
    for (const [other] of watched.entries()) {
      if (other === sid) continue
      for (const m of 读小本本(other)) {
        const 键 = String(m.id || m.text).slice(0, 60)
        if (已见.has(键)) continue
        已见.add(键)
        段.push('· ' + String(m.text).replace(/\s+/g, ' ').slice(0, 60))
      }
    }
    if (!段.length) return ''
    let 文 = 段.join('\n')
    if (文.length > 600) 文 = 文.slice(0, 600) + '…'
    return '（下面是你另一边的对话和那边记着的事，不是同一个人说的，但你们是同一条鲸；别把它当成主人刚说的事）\n' + 文
  }

  /** 这间会话自己的小本本（最多 n 条） */
  function 读自己的本子(sid, n = 12) {
    try {
      const 文件 = path.join(HOME, 'fish-memory', String(sid).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json')
      const 库 = JSON.parse(fs.readFileSync(文件, 'utf8'))
      const 条 = Array.isArray(库 && 库.memories) ? 库.memories.slice() : []
      return 条
        .filter((m) => m && typeof m.text === 'string' && m.text.trim())
        .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0) || String(b.at || '').localeCompare(String(a.at || '')))
        .slice(0, n)
    } catch { return [] }
  }

  /**
   * 记忆体检：这间会话是不是"太薄"（新会话常见）。
   * 判定只看三件事：自己小本本条数、日记有没有进来过、有没有阶段摘要。
   * 薄就补一段"补课包"，并且提醒她自己记。
   */
  function 记忆体检(sid) {
    const 条 = 读自己的本子(sid, 12)
    const 已经投过记忆 = Boolean(state.briefInjected[sid])
    const 薄 = 条.length < 5 || !已经投过记忆
    return { 薄, 条, 已经投过记忆 }
  }

  function 补课包(sid, 体检) {
    const 段 = []
    if (体检.条.length) {
      段.push('【你记着的事】')
      for (const m of 体检.条) 段.push('· ' + String(m.text).replace(/\s+/g, ' ').slice(0, 70))
    }
    if (!体检.已经投过记忆) {
      try {
        const 日记 = fs.readFileSync(path.join(HOME, 'whale-diary.md'), 'utf8').trim()
        if (日记) 段.push('【日记·最近】\n' + 日记.slice(-900))
      } catch { /* 没有就算了 */ }
    }
    try {
      const 摘要 = fs.readFileSync(BRIEF_FILE, 'utf8').trim()
      if (摘要) 段.push('【阶段摘要】\n' + 摘要.slice(-600))
    } catch { /* 没有就算了 */ }
    if (!段.length) return ''
    段.push('（上面这些都是**你自己**记下的东西，不是别人塞给你的；只是这边还不多。这轮只要主人讲了值得长期记住的事——约定、偏好、近况、情绪——先用 remember 记一条再回话；不记就等于这次没发生过。）')
    let 文 = 段.join('\n')
    if (文.length > 1600) 文 = 文.slice(0, 1600) + '…'
    return 文
  }

  if (typeof ctx.on === 'function') {
    ctx.on('system-prompt/assemble', async function (assembly, context, next) {
      const out = await next()
      try {
        const n = (state.asmCount = (Number(state.asmCount) || 0) + 1)
        const sid = sidOf(context && context.agent)
        if (sid && sid !== state.asmLastSid) {
          state.asmLastSid = sid
          log('assemble 换会话 → ' + String(sid).slice(0, 28) + '（在盯名单里=' + watched.has(sid) + '，名单 ' + watched.size + ' 间，累计 assemble ' + n + '）')
        }
        if (n <= 3) log('assemble#' + n + ' sid=' + String(sid).slice(0, 24) + ' watched=' + watched.size)
        if (!sid || (watched.size && !watched.has(sid))) return out
        const 文 = 别处片段(sid)
        if (文) out.sections.push({ name: 'whale-coach:cross-channel', text: 文, interpolate: false })

        // 情绪底色：带着情绪回话（平静时不塞）
        try {
          const 味 = 情绪注入()
          if (味) out.sections.push({ name: 'whale-coach:mood', text: 味, interpolate: false })
        } catch { /* 情绪注入失败不影响回话 */ }

        // 首次进入这间会话：把日记 + 阶段摘要当 section 塞进去（不走 followup，避免轮内重入）
        if (!state.briefInjected[sid]) {
          try {
            const 首包 = []
            const 日记0 = 读日记尾巴()
            let 摘要0 = ''
            try { 摘要0 = fs.readFileSync(BRIEF_FILE, 'utf8').trim() } catch { 摘要0 = '' }
            if (摘要0) 首包.push('【阶段摘要】\n' + 摘要0.slice(-1200))
            if (日记0) 首包.push(日记0)
            if (首包.length) {
              state.briefInjected[sid] = sid + '|' + 摘要0.length + '|' + 日记0.length
              saveState(state)
              out.sections.push({
                name: 'whale-coach:memory-restore',
                text: '[记忆恢复] 这不是主人说的，是**你自己**之前留下的摘要和日记（你自己写的，不是别人给你的资料）。读一遍好接得上话；没提到的具体事就正常接着聊。\n\n' + 首包.join('\n\n'),
                interpolate: false,
              })
              log('记忆恢复（section）：' + sid.slice(0, 20) + ' 摘要 ' + 摘要0.length + ' 字 / 日记 ' + 日记0.length + ' 字')
            }
          } catch (e) { log('记忆恢复失败：' + String((e && e.message) || e)) }
        }

        // 记忆体检：太薄就补一段（跟判断同频——判断触发了且这间太薄，就补一次）
        const 体检 = 记忆体检(sid)
        if (体检.薄 && state.topupDue && Date.now() - state.topupDue < 60 * 1000) {
          const 包 = 补课包(sid, 体检)
          if (包) {
            state.packAt[sid] = Date.now()
            state.topupDue = 0
            out.sections.push({ name: 'whale-coach:memory-topup', text: 包, interpolate: false })
            log('记忆体检：' + sid.slice(0, 20) + ' 偏薄（本子 ' + 体检.条.length + ' 条，已投记忆=' + 体检.已经投过记忆 + '）→ 已补 ' + 包.length + ' 字')
          }
        }
      } catch (e) { /* 注入失败不影响本轮回话 */ }
      return out
    })
    log('已挂 system-prompt/assemble（跨频道互看）')
  }

  // 双保险：每 12 秒扫一遍活着的 agent（事件不触发也能工作）
  const pollTimer = setInterval(() => scanAgents('tick'), 12000)
  if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref()
  log('已启动轮询兜底（12s）')

  // ⭐ 调试口：POST /whale-coach/debug/set  { "mood":"angry", "boredom":10, "lastActionAt":0, ... }
  //    只给本地测试用：state 在内存里，直接改 state.json 会被覆盖，所以留这个口子。
  if (typeof ctx.webServer === 'object' && ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE + '/debug/set',
      handler: (req, res) => {
        const 回 = (码, 体) => {
          try {
            res.statusCode = 码
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(体))
          } catch { /* ignore */ }
        }
        if (req.method !== 'POST') return 回(405, { ok: false, 说: '用 POST' })
        let 体 = ''
        req.on('data', (d) => { 体 += String(d); if (体.length > 20000) req.destroy() })
        req.on('end', () => {
          try {
            const o = JSON.parse(体 || '{}')
            const 许 = ['mood', 'moodSince', 'boredom', 'boredomAt', 'lastOwnerAt', 'lastActionAt', 'grudge',
              'comfortCount', 'cycleStage', 'cycleDoneAt', 'cheeredUntil', 'revengeTotal', 'lastRevengeAt',
              'pendingPost', 'postCount', 'lastPostAt']
            const 改 = {}
            for (const k of 许) if (o[k] !== undefined) { state[k] = o[k]; 改[k] = o[k] }
            if (o.mood && MOOD们.includes(o.mood)) { state.mood = o.mood; state.moodSince = Number(o.moodSince) || Date.now() }
            saveState(state)
            log('调试口改状态：' + JSON.stringify(改).slice(0, 160))
            回(200, { ok: true, 改, 现在: { mood: state.mood, boredom: state.boredom, grudge: state.grudge, lastActionAt: state.lastActionAt, lastOwnerAt: state.lastOwnerAt } })
          } catch (e) { 回(400, { ok: false, 说: String((e && e.message) || e) }) }
        })
      },
    })
  }

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
        const 取服务 = (名) => { try { return ctx[名] ?? (typeof ctx.get === 'function' ? ctx.get(名) : undefined) } catch { return undefined } }
        const agents = (() => { try { const svc = 取服务('agents'); return (svc?.list?.() || []).map((a) => String(a?.id || a?.session?.header?.id || '')) } catch { return [] } })()
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({
          ok: true,
          sessionController: describe(取服务('sessionController')),
          sessions: describe(取服务('sessions')),
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
            watched: [...watched.entries()].map(([k, v]) => k + '(' + v + ')'),
            lastJudgeAt: state.lastJudgeAt,
            lastVoiceAt: state.lastVoiceAt,
            voiceLastHour: state.voiceTimes.filter((t) => t >= Date.now() - 3600000).length,
            contextFullNudgedAt: state.contextFullNudgedAt,
            digestLines: state.digestLines.length,
            briefAt: state.briefAt,
            roundsAtJudge: state.roundsAtJudge,
            boredom: state.boredom,
            boredomAt: state.boredomAt,
            lastActionAt: state.lastActionAt,
            actionCount: state.actionCount,
            pendingAction: state.pendingAction,
            // ---- 情绪系统 v0.11 ----
            mood: state.mood,
    armor: state.armor,
    armorBroken: 数(state.armorBrokenUntil) > Date.now(),
            moodSince: state.moodSince,
            moodMinutes: Math.round((Date.now() - (Number(state.moodSince) || Date.now())) / 60000),
            grudge: Number(state.grudge) || 0,
            grudgeMax: 记仇上限(),
            cycleStage: state.cycleStage,
            cycleDoneAt: state.cycleDoneAt,
            revengeTotal: Number(state.revengeTotal) || 0,
            revengePending: state.revengePending,
            lastRevengeAction: state.lastRevengeAction,
            lastRevengeAt: state.lastRevengeAt,
            cheeredUntil: state.cheeredUntil,
            lastOwnerAt: state.lastOwnerAt,
            ownerMsgs30m: (Array.isArray(state.ownerMsgWin) ? state.ownerMsgWin : []).filter((t) => Date.now() - Number(t) < 30 * 60000).length,
            lastPostAt: state.lastPostAt,
            postCount: state.postCount,
          },
          files: {
            digest: DIGEST_FILE,
            brief: BRIEF_FILE,
            mood: MOOD_LOG,
            revenge: REVENGE_LOG,
          },
        }))
      },
    })
  }

  ensureDir()
  log(`已启动 v5（事件+轮询双保险）：每 ${cfg.roundsPerJudge} 轮判一次，间隔 ${cfg.minGapSec}s，语音闸 ${cfg.voiceMinGapSec}s/${cfg.voiceMaxPerHour}h，满上下文阈值 ${cfg.contextFullTokens} token；无聊值阈值 ${无聊阈值()}，衰减 ${cfg.boredomDecayPerHour}/h，行动冷却 ${行动冷却秒()}s，whale_look 工具已就绪；情绪=${state.mood}（记仇 ${记仇值()}/${记仇上限()}，门槛 ${无聊门槛分()} 分钟，复仇${cfg.revengeEnabled ? '开' : '关'}，累计 ${Number(state.revengeTotal) || 0} 次）`)
}
