const express = require('express')
const { verifySignature } = require('../src/utils/hmac')

const app = express()
app.use(express.json())

// The secret must match what you registered with
const SHARED_SECRET = 'my-super-secret-key'

let requestCount = 0

app.post('/receive', (req, res) => {
  requestCount++
  const signature = req.headers['x-webhook-signature']
  const attemptNumber = req.headers['x-webhook-attempt']

  console.log(`\n[Subscriber] Request #${requestCount} received`)
  console.log(`  Event:     `, req.body)
  console.log(`  Attempt:   `, attemptNumber)
  console.log(`  Signature: `, signature)

  // Verify the signature — reject if invalid
  const isValid = verifySignature(req.body, SHARED_SECRET, signature)
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