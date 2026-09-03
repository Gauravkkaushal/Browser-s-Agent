import http from 'node:http'

const PORT = Number(process.env.PORT || 8787)

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, '')
    return
  }

  if (req.method !== 'POST' || req.url !== '/reason') {
    send(res, 404, { error: 'Use POST /reason' })
    return
  }

  try {
    const payload = JSON.parse(await readBody(req))
    const command = chooseCommand(payload.elements || [], payload.task || '')

    send(res, 200, {
      command,
      rationale:
        'Processed sanitized DOM and redaction metadata only. Raw values, passwords, and visual PII are never required by this demo server.',
      receivedPrivacySummary: payload.privacySummary,
    })
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' })
  }
})

server.listen(PORT, () => {
  console.log(`NetraShield demo reasoning server listening on http://localhost:${PORT}/reason`)
})

function chooseCommand(elements, task) {
  const taskText = String(task).toLowerCase()
  const taskPattern = getTaskPattern(taskText)
  const actionable = elements.find((element) => {
    const label = `${element.role} ${element.label}`.toLowerCase()
    return taskPattern.test(label)
  })

  if (!actionable) {
    return {
      type: 'none',
      targetId: '',
      instruction: 'No high-confidence action target found in sanitized context.',
    }
  }

  return {
    type: 'highlight',
    targetId: actionable.id,
    instruction: `Highlight "${actionable.label}" so the user can approve the next browser action.`,
  }
}

function getTaskPattern(taskText) {
  if (/log ?in|sign ?in/.test(taskText)) {
    return /(login|log in|sign in|continue)/
  }

  if (/pay|checkout|order/.test(taskText)) {
    return /(pay|checkout|place order|continue)/
  }

  if (/save|update/.test(taskText)) {
    return /(save|update|submit)/
  }

  if (/send|message|email/.test(taskText)) {
    return /(send|submit)/
  }

  return /(submit|continue|next|review|save|send|login|sign in|checkout|pay)/
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body || '{}'))
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  })
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
}
