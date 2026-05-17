const app = document.getElementById('app')
const chat = document.getElementById('chat')
const form = document.getElementById('input')
const message = document.getElementById('message')
const sessionsEl = document.getElementById('sessions')
const newSessionButton = document.getElementById('new-session')

const chromeVersion = getChromeVersion()

let sessions = []
let activeSessionId = null
let session = null
initialized = initialize()

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

  if (!session) {
    await addMessage('assistant', 'No language model session available.')
    return
  }

  const loading = showLoading()

  try {
    const result = await session.prompt(text)

    loading.remove()
    await addMessage('assistant', result)
  } catch (error) {
    loading.remove()
    await addMessage('assistant', 'Something went wrong.')
    console.error(error)
  }
})


async function createSession() {
  const id = crypto.randomUUID()

  const newSession = {
    id,
    name: 'New chat',
    createdAt: Date.now(),
  }

  sessions.unshift(newSession)
  activeSessionId = id

  renderSessions()
  await renderChat()

  await addMessage('assistant', 'Hi There!')
}

function getActiveSession() {
  return sessions.find(session => session.id === activeSessionId)
}

async function addMessage(by, text) {
  const activeSession = getActiveSession()
  if (!activeSession) return

  const message = {
    id: crypto.randomUUID(),
    sessionId: activeSession.id,
    by,
    text,
    createdAt: Date.now(),
  }

  await store.saveMessage(message)

  if (by === 'user' && activeSession.name === 'New chat') {
    activeSession.name = text.slice(0, 24)

    await store.saveSession({
      ...activeSession,
      createdAt: Date.now(),
    })

    sessions = await store.getSessions()
    sessions.sort((a, b) => b.createdAt - a.createdAt)
  }

  renderSessions()
  await renderChat()
}
async function renderChat() {
  chat.innerHTML = ''

  const activeSession = getActiveSession()
  if (!activeSession) return

  const messages = await store.getMessages(activeSession.id)

  messages.sort((a, b) => a.createdAt - b.createdAt)

  for (const message of messages) {
    output(message.text, message.by)
  }
}

function renderSessions() {
  sessionsEl.innerHTML = ''

  for (const session of sessions) {
    const row = document.createElement('div')
    row.className = 'session'

    if (session.id === activeSessionId) {
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
      activeSessionId = session.id
      renderSessions()
      await renderChat()
    })

    deleteButton.addEventListener('click', async event => {
      event.stopPropagation()

      await store.deleteSession(session.id)

      sessions = sessions.filter(item => item.id !== session.id)

      if (activeSessionId === session.id) {
        activeSessionId = sessions[0]?.id ?? null
      }

      if (sessions.length === 0) {
        await createSession()
        return
      }

      renderSessions()
      await renderChat()
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
    output('No on-device language model available. Requires Chrome version 148.', 'assistant')

    if (chromeVersion) {
      output('Current Chrome version: ' + chromeVersion, 'assistant')
    }

    return
  }

  sessions = await store.getSessions()

  await createSession()
  renderSessions()

  session = await LanguageModel.create()

  await store.open()
}

function output(str, by = 'user') {
  const p = document.createElement('p')
  p.className = by
  p.textContent = str
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

function getChromeVersion() {
  const raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./)
  return raw ? parseInt(raw[2], 10) : false
}
