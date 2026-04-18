const express = require('express')
const { verifySignature } = require('../utils/hmac')

const app = express()

// Capture raw body bytes so signature verification operates on the exact
// bytes that were signed — not a re-serialised parsed object
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf
  }
}))

// The secret must match what you registered with
const SHARED_SECRET = process.env.WEBHOOK_SECRET
if (!SHARED_SECRET) {
  throw new Error('WEBHOOK_SECRET env variable is required. Copy .env.example to .env and set it.')
}

let requestCount = 0

app.post('/receive', (req, res) => {
  requestCount++
  const signature = req.headers['x-webhook-signature']
  const attemptNumber = req.headers['x-webhook-attempt']

  console.log(`\n[Subscriber] Request #${requestCount} received`)
  console.log(`  Event:     `, req.body)
  console.log(`  Attempt:   `, attemptNumber)
  console.log(`  Signature: `, signature)

  // Verify against raw body bytes — same bytes the worker signed
  const isValid = verifySignature(req.rawBody, SHARED_SECRET, signature)
  if (!isValid) {
    console.log(`  ❌ Signature verification FAILED`)
    return res.status(401).json({ error: 'Invalid signature' })
  }

  console.log(`  ✅ Signature verified`)

  // Simulate 30% failure rate to trigger retry logic
  if (Math.random() < 0.3) {
    console.log(`  ⚠️  Simulating server failure (503)`)
    return res.status(503).json({ error: 'Service temporarily unavailable' })
  }

  console.log(`  ✅ Delivery successful`)
  res.status(200).json({ received: true, timestamp: new Date().toISOString() })
})

app.listen(4000, () => {
  console.log('[Subscriber] Mock subscriber running on port 4000')
  console.log('[Subscriber] Expecting events at http://localhost:4000/receive')
  console.log('[Subscriber] 30% random failure rate enabled to test retries\n')
})