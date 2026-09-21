const axios = require('axios')

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DELIVERY_WAIT_MS = Number(process.env.DELIVERY_WAIT_MS) || 20000

// URL the worker will POST deliveries to.
// - Manual flow (API + worker on host): default http://localhost:4000/receive
// - Docker flow (API + worker in containers, mocks on host):
//   SUBSCRIBER_URL=http://host.docker.internal:4000/receive
//   (`localhost` inside a container means the container itself, not the host.)
const SUBSCRIBER_URL = process.env.SUBSCRIBER_URL || 'http://localhost:4000/receive'

// Webhook signing secret shared with the mock subscriber (min 32 chars).
// Must match the `secret` used when registering the subscriber below.
const SHARED_SECRET =
  process.env.WEBHOOK_SECRET || 'mock-shared-webhook-secret-at-least-32-chars-long!'

// NOTE: both the producer URL (localhost:5000) and the subscriber URL
// (localhost:4000) require DISABLE_SSRF_CHECK=true on the API server,
// otherwise SSRF protection rejects localhost/private IPs.

// Step 1: Register a producer (event emitter) and get its management API key
const registerProducer = async () => {
  const res = await axios.post(`${BASE_URL}/producers/register`, {
    producerUrl: 'http://localhost:5000/mock-producer',
    allowedEvents: ['payment.success', 'payment.failed', 'order.created'],
  })
  console.log('[Producer] Producer registered:', {
    producerId: res.data.producerId,
  })
  return res.data.apiKey
}

// Step 2: Register a subscriber (run once, then comment out)
const registerSubscriber = async () => {
  const res = await axios.post(`${BASE_URL}/webhooks/register`, {
    subscriberUrl: SUBSCRIBER_URL,
    events: ['payment.success', 'payment.failed', 'order.created'],
    secret: SHARED_SECRET,
  })
  console.log('[Producer] Subscriber registered:', {
    subscriberId: res.data.subscriberId,
  })
  return { subscriberId: res.data.subscriberId, apiKey: res.data.apiKey }
}

// Step 3: Fire an event (producer-authenticated)
const fireEvent = async (producerApiKey, type, payload, idempotencyKey) => {
  const res = await axios.post(
    `${BASE_URL}/events`,
    { type, payload, ...(idempotencyKey ? { idempotencyKey } : {}) },
    { headers: { 'x-api-key': producerApiKey } }
  )
  console.log(`[Producer] Event fired (${type}):`, res.data)
  return res.data
}

// Step 4: Check delivery logs for a subscriber (subscriber-authenticated)
const checkLogs = async (subscriberApiKey) => {
  const res = await axios.get(`${BASE_URL}/webhooks/logs`, {
    headers: { 'x-api-key': subscriberApiKey },
  })
  console.log('[Producer] Delivery logs:')
  res.data.logs.forEach(log => {
    const status = log.success ? '✅' : '❌'
    console.log(`  ${status} Attempt ${log.attemptNumber} → ${log.statusCode} at ${log.createdAt}`)
  })
}

const run = async () => {
  try {
    // Register producer + subscriber
    console.log('\n--- Registering Producer ---')
    const producerApiKey = await registerProducer()

    console.log('\n--- Registering Subscriber ---')
    const { subscriberId, apiKey: subscriberApiKey } = await registerSubscriber()
    void subscriberId

    // Wait a moment then fire multiple events
    await new Promise(r => setTimeout(r, 500))

    console.log('\n--- Firing Events ---')
    await fireEvent(producerApiKey, 'payment.success', {
      orderId: `ORD-${Date.now()}`,
      amount: 4999,
      currency: 'INR',
      userId: 'user_123'
    })

    await fireEvent(producerApiKey, 'order.created', {
      orderId: `ORD-${Date.now() + 1}`,
      items: ['item_a', 'item_b'],
      total: 1299
    })

    await fireEvent(producerApiKey, 'payment.failed', {
      orderId: `ORD-${Date.now() + 2}`,
      reason: 'insufficient_funds'
    })

    // Wait for deliveries to process, then check logs
    console.log(`\n--- Waiting ${Math.round(DELIVERY_WAIT_MS / 1000)}s for deliveries to process ---`)
    await new Promise(r => setTimeout(r, DELIVERY_WAIT_MS))

    console.log('\n--- Delivery Logs ---')
    await checkLogs(subscriberApiKey)

  } catch (err) {
    console.error('[Producer] Error:', err.response?.data || err.message)
  }
}

run()
