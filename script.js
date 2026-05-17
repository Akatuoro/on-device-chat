const app = document.getElementById('app')
const chat = document.getElementById('chat')
const form = document.getElementById('input')
const messageIn = document.getElementById('message')
const sessionsEl = document.getElementById('sessions')
const newSessionButton = document.getElementById('new-session')
const usageEl = document.getElementById('usage')
const sendButton = document.getElementById('send-message')
const abortButton = document.getElementById('abort-message')

const NEW_CHAT_NAME = 'New chat'
const WELCOME_MESSAGE = 'Hi There!'

let sessions = []
let activeSession = null
let initialized = initialize()

// ==========================
// === Register UI Events ===
// ==========================

newSessionButton.addEventListener('click', newSession)

messageIn.addEventListener('input', updateInputControls)

form.addEventListener('submit', async event => {
  event.preventDefault()

  const text = messageIn.value.trim()
  if (!text) return

  messageIn.value = ''
  await sendPrompt(text)
})

abortButton.addEventListener('click', () => {
  getPendingMessage(activeSession)?.generation.controller.abort()
})


// =====================
// === Session Logic ===
// =====================

async function initialize() {
  const outputErr = (text) => {
    const chromeVersion = getChromeVersion()
    if (!chromeVersion || chromeVersion < 148) text += ' - Chrome 148 is required.'
    output({ by: 'assistant', text })
  }

  if (!window.LanguageModel) {
    return outputErr('LanguageModel API not available')
  }
  const availability = await LanguageModel.availability({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  })
  if (availability !== 'available') {
    return outputErr('No on-device language model available, status: ' + availability)
  }


  await store.open()
  const sessionRecords = await store.getSessions()
  sessionRecords.sort((a, b) => b.createdAt - a.createdAt) // desc
  sessions = await Promise.all(sessionRecords.map(loadSession))

  await newSession()
}


async function sendPrompt(text, session = activeSession) {
  await initialized

  if (!session) return
  const pending = getPendingMessage(session)
  if (pending) {
    pending.generation.suppressAbortMessage = true
    pending.generation.controller.abort()
    await pending.generation.done
  }
  const message = await putMessage(session, { by: 'user', text })
  if (!message) return

  const generation = {
    controller: new AbortController(),
    suppressAbortMessage: false,
  }

  message.generation = generation
  generation.done = promptUserMessage(session, message, generation)
  updateSessionUi(session)

  await generation.done
}

async function promptUserMessage(session, userMessage, generation) {

  try {
    const llmSession = await ensureLanguageModelSession(session)

    if (!llmSession) {
      await putMessage(session, { by: 'assistant', text: 'No language model session available.' })
      return
    }

    if (generation.controller.signal.aborted) return

    const startedAt = performance.now()
    const { contextUsage: usageBefore } = llmSession
    const result = await llmSession.prompt(userMessage.text, { signal: generation.controller.signal })
    const durationMs = performance.now() - startedAt
    const { contextUsage, contextWindow } = llmSession

    if (generation.controller.signal.aborted) return

    Object.assign(session, { contextUsage, contextWindow })
    await putMessage(session, {
      by: 'assistant',
      text: result,
      durationMs,
      tokenUsage: Math.max(contextUsage - usageBefore, 0),
    })
  } catch (error) {
    if (isAbortError(error) && !generation.suppressAbortMessage) {
      await putMessage(session, { by: 'assistant', text: 'Response stopped.' })
    } else {
      await putMessage(session, { by: 'assistant', text: 'Something went wrong.' })
      console.error(error)
    }
  } finally {
    if (userMessage.generation === generation) delete userMessage.generation
    updateSessionUi(session)
  }
}


async function ensureLanguageModelSession(session) {
  if (!window.LanguageModel) return null
  if (!session.llmSession) session.llmSession = await LanguageModel.create(createSessionData(session))
  return session.llmSession
}

function createSessionData(session) {
  return {
    initialPrompts: session.messages
      .filter(message => !message.generation)
      .filter(message => message.by === 'user' || (message.by === 'assistant' && !message.transient))
      .map(message => ({
        role: message.by,
        content: message.text,
      })),
  }
}

function getPendingMessage(session) {
  return session?.messages.find(message => message.generation) ?? null
}

function releaseIdleLanguageModelSessions(keepSession) {
  for (const session of sessions) {
    if (session === keepSession || getPendingMessage(session) || !session.llmSession) continue

    session.llmSession.destroy?.()
    session.llmSession = null
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError'
    || (typeof DOMException !== 'undefined' && error?.code === DOMException.ABORT_ERR)
}

function updateSessionUi(session) {
  if (session?.deleted) return

  if (activeSession === session) renderChat()
  renderSessions()
}

function updateInputControls() {
  const isSending = Boolean(getPendingMessage(activeSession))

  sendButton.disabled = !messageIn.value.trim()
  sendButton.hidden = isSending
  abortButton.hidden = !isSending
}

async function newSession() {
  const existing = sessions.find(session => session.name === NEW_CHAT_NAME)

  if (existing) {
    setActiveSession(existing)
    return existing
  }

  const session = {
    id: crypto.randomUUID(),
    name: NEW_CHAT_NAME,
    createdAt: Date.now(),
    persisted: false,
    messages: [],
    llmSession: null,
  }

  sessions.unshift(session)
  setActiveSession(session)
  addWelcomeMessage(session)

  await ensureLanguageModelSession(session)
  renderOverallUsage()
  return session
}


async function deleteSession(session) {
  session.deleted = true
  getPendingMessage(session)?.generation.controller.abort()
  session.llmSession?.destroy?.()

  if (session.persisted) {
    await store.deleteSession(session.id)
  }

  sessions = sessions.filter(item => item.id !== session.id)

  if (activeSession?.id === session.id) {
    activeSession = null
  }

  if (sessions.length === 0) {
    await newSession()
    return
  }

  await setActiveSession(sessions[0])
}


function setActiveSession(session) {
  activeSession = sessions.find(item => item.id === session.id) ?? session

  renderSessions()
  renderChat()
}

function addWelcomeMessage(session) {
  session.messages.push({
    id: crypto.randomUUID(),
    sessionId: session.id,
    by: 'assistant',
    text: WELCOME_MESSAGE,
    createdAt: Date.now(),
    transient: true,
  })

  updateSessionUi(session)
}

async function putMessage(session, data, updates = {}) {
  if (!session || session.deleted) return null

  const message = {
    id: data.id ?? crypto.randomUUID(),
    sessionId: session.id,
    createdAt: Date.now(),
    ...data,
    ...updates,
  }

  if (!data.id) session.messages.push(message)

  if (data.by === 'user') {
    await updateSessionName(session)
  }

  await saveSession(session)
  await store.saveMessage(message)
  updateSessionUi(session)

  return message
}

async function updateSessionName(session) {
  const firstUserMessage = session.messages.find(message => message.by === 'user')
  const nextName = firstUserMessage?.text.slice(0, 24) || NEW_CHAT_NAME

  if (session.name === nextName) return

  session.name = nextName
  session.updatedAt = Date.now()
}

async function saveSession(session) {
  await store.saveSession(sessionRecord(session))
  session.persisted = true
}

function sessionRecord(session) {
  const { id, name, createdAt, updatedAt, contextUsage, contextWindow } = session
  return { id, name, createdAt, updatedAt, contextUsage, contextWindow }
}

async function loadSession(sessionMeta) {
  const messages = await store.getMessages(sessionMeta.id)
  messages.sort((a, b) => a.createdAt - b.createdAt) // asc

  return {
    ...sessionMeta,
    persisted: true,
    messages,
    llmSession: null,
  }
}


// ====================
// === UI Rendering ===
// ====================

function renderChat() {
  chat.innerHTML = ''

  for (const message of activeSession?.messages ?? []) {
    output(message)
    if (message.generation) outputLoading()
  }

  renderOverallUsage()
  updateInputControls()
}

function renderSessions() {
  sessionsEl.innerHTML = ''

  for (const session of sessions) {
    const row = document.createElement('div')
    row.className = 'session'

    if (session.id === activeSession?.id) {
      row.classList.add('active')
    }

    const name = document.createElement('div')
    name.className = 'session-name'
    name.textContent = session.name

    const deleteButton = document.createElement('button')
    deleteButton.className = 'delete-session'
    deleteButton.textContent = '×'
    deleteButton.title = 'Delete session'

    row.addEventListener('click', async () => {
      await setActiveSession(session)
    })

    deleteButton.addEventListener('click', async event => {
      event.stopPropagation()
      await deleteSession(session)
    })

    row.append(name, deleteButton)
    sessionsEl.append(row)
  }
}


function output(message) {
  const p = document.createElement('p')
  p.className = message.by

  const text = document.createElement('span')
  text.textContent = message.text
  p.append(text)

  if (message.by === 'assistant') {
    const details = formatMessageUsage(message)

    if (details) {
      const meta = document.createElement('span')
      meta.className = 'message-meta'
      meta.textContent = details
      p.append(meta)
    }
  }

  chat.append(p)
  chat.scrollTop = chat.scrollHeight
}

function outputLoading() {
  const p = document.createElement('p')
  p.className = 'assistant loading'
  p.innerHTML = '<span></span><span></span><span></span>'
  chat.append(p)

  chat.scrollTop = chat.scrollHeight
}

function formatMessageUsage(message) {
  const parts = []
  if (message.tokenUsage) parts.push(`${message.tokenUsage} tokens`)
  if (message.durationMs) parts.push(formatDuration(message.durationMs))
  return parts.join(' · ')
}

function renderOverallUsage() {
  if (!usageEl) return

  const llmSession = activeSession?.llmSession
  if (!llmSession) return usageEl.textContent = ''

  const { contextUsage, contextWindow } = llmSession

  const percent = contextWindow > 0 ? (contextUsage / contextWindow) * 100 : 0
  usageEl.textContent = `${contextUsage}/${contextWindow} tokens · ${percent.toFixed(1)}%`
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`

  return `${(ms / 1000).toFixed(1)}s`
}


// =============
// === Utils ===
// =============

function getChromeVersion() {
  const raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./)
  return raw ? parseInt(raw[2], 10) : false
}
