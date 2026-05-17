const app = document.getElementById('app')
const chat = document.getElementById('chat')
const form = document.getElementById('input')
const message = document.getElementById('message')
const sessionsEl = document.getElementById('sessions')
const newSessionButton = document.getElementById('new-session')
const usageEl = document.getElementById('usage')

const chromeVersion = getChromeVersion()
const NEW_CHAT_NAME = 'New chat'
const WELCOME_MESSAGE = 'Hi There!'

let sessions = []
let activeSession = null
let llmSession = null
let initialized = initialize()

newSessionButton.addEventListener('click', async () => {
  await createSession()
})

form.addEventListener('submit', async event => {
  event.preventDefault()

  const text = message.value.trim()
  if (!text) return

  message.value = ''

  await addMessage('user', text)

  await initialized

  if (!llmSession) {
    await addMessage('assistant', 'No language model session available.')
    return
  }

  const loading = showLoading()
  const { contextUsage : usageBefore } = llmSession
  const startedAt = performance.now()

  try {
    const result = await llmSession.prompt(text)
    const durationMs = performance.now() - startedAt
    const { contextUsage, contextWindow } = llmSession
    Object.assign(activeSession.metadata, { contextUsage, contextWindow })

    loading.remove()
    await addMessage('assistant', result, {
      durationMs,
      tokenUsage: Math.max(contextUsage - usageBefore, 0),
    })
  } catch (error) {
    loading.remove()
    await addMessage('assistant', 'Something went wrong.')
    console.error(error)
  }
})

async function createSession() {
  const existing = await findReusableNewSession()

  if (existing) {
    await setActiveSession(existing)
    return existing
  }

  const newSession = {
    id: crypto.randomUUID(),
    name: NEW_CHAT_NAME,
    createdAt: Date.now(),
  }

  sessions.unshift(newSession)
  await store.saveSession(newSession)
  await setActiveSession(newSession)
  await addMessage('assistant', WELCOME_MESSAGE)

  return newSession
}

async function findReusableNewSession() {
  let reusableSession = null

  for (const session of sessions) {
    if (session.name !== NEW_CHAT_NAME) continue

    const messages = await store.getMessages(session.id)
    const userMessages = messages.filter(message => message.by === 'user')

    if (userMessages.length > 0) continue

    if (!reusableSession) {
      reusableSession = session
      continue
    }

    await store.deleteSession(session.id)
    sessions = sessions.filter(item => item.id !== session.id)
  }

  return reusableSession
}

async function setActiveSession(sessionMeta) {
  const messages = await store.getMessages(sessionMeta.id)

  messages.sort((a, b) => a.createdAt - b.createdAt)

  activeSession = {
    metadata: sessionMeta,
    messages,
  }

  renderSessions()
  renderChat()
}

async function addMessage(by, text, metadata = {}) {
  if (!activeSession) return

  const message = {
    id: crypto.randomUUID(),
    sessionId: activeSession.metadata.id,
    by,
    text,
    createdAt: Date.now(),
    ...metadata,
  }

  await store.saveMessage(message)
  activeSession.messages.push(message)

  if (by === 'user' && activeSession.metadata.name === NEW_CHAT_NAME) {
    activeSession.metadata.name = text.slice(0, 24) || NEW_CHAT_NAME
    activeSession.metadata.updatedAt = Date.now()

    await store.saveSession(activeSession.metadata)

    sessions = await store.getSessions()
    activeSession.metadata = sessions.find(session => session.id === activeSession.metadata.id) ?? activeSession.metadata
  }

  renderSessions()
  renderChat()
}

function renderChat() {
  chat.innerHTML = ''

  if (!activeSession) {
    renderOverallUsage()
    return
  }

  for (const message of activeSession.messages) {
    output(message)
  }

  renderOverallUsage()
}

function renderSessions() {
  sessionsEl.innerHTML = ''

  for (const session of sessions) {
    const row = document.createElement('div')
    row.className = 'session'

    if (session.id === activeSession?.metadata.id) {
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

      await store.deleteSession(session.id)

      sessions = sessions.filter(item => item.id !== session.id)

      if (activeSession?.metadata.id === session.id) {
        activeSession = null
      }

      if (sessions.length === 0) {
        await createSession()
        return
      }

      await setActiveSession(sessions[0])
    })

    row.append(name, deleteButton)
    sessionsEl.append(row)
  }
}

async function checkAvailability() {
  if (!window.LanguageModel) return false

  const available = await LanguageModel.availability({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  })

  return available !== 'unavailable'
}

async function initialize() {
  let available = await checkAvailability()

  if (!available) {
    output({ text: 'No on-device language model available. Requires Chrome version 148.', by: 'assistant' })

    if (chromeVersion) {
      output({ text: 'Current Chrome version: ' + chromeVersion, by: 'assistant' })
    }

    return
  }

  await store.open()
  sessions = await store.getSessions()

  if (sessions.length > 0) {
    await setActiveSession(sessions[0])
  } else {
    await createSession()
  }

  llmSession = await LanguageModel.create()
  renderOverallUsage()
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

function showLoading() {
  const p = document.createElement('p')
  p.className = 'assistant loading'
  p.innerHTML = '<span></span><span></span><span></span>'
  chat.append(p)

  chat.scrollTop = chat.scrollHeight

  return p
}



function formatMessageUsage(message) {
  const parts = []
  if (message.tokenUsage) parts.push(`${message.tokenUsage} tokens`)
  if (message.durationMs) parts.push(formatDuration(message.durationMs))
  return parts.join(' · ')
}

function renderOverallUsage() {
  if (!usageEl) return
  if (!llmSession) return usageEl.textContent = ''

  const { contextUsage, contextWindow } = llmSession

  const percent = contextWindow > 0 ? (contextUsage / contextWindow) * 100 : 0
  usageEl.textContent = `${contextUsage}/${contextWindow} tokens · ${percent.toFixed(1)}%`
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`

  return `${(ms / 1000).toFixed(1)}s`
}


function getChromeVersion() {
  const raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./)
  return raw ? parseInt(raw[2], 10) : false
}
