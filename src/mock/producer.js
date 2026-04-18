const axios = require('axios')

const BASE_URL = 'http://localhost:3000'
const DELIVERY_WAIT_MS = Number(process.env.DELIVERY_WAIT_MS) || 20000

const SHARED_SECRET = process.env.WEBHOOK_SECRET
if (!SHARED_SECRET) {
  throw new Error('WEBHOOK_SECRET env variable is required. Copy .env.example to .env and set it.')
}

// Step 1: Register a subscriber (run once, then comment out)
const registerSubscriber = async () => {
  const res = await axios.post(`${BASE_URL}/webhooks/register`, {
    subscriberUrl: 'http://localhost:4000/receive',
    events: ['payment.success', 'payment.failed', 'order.created'],
    secret: SHARED_SECRET
  })
  console.log('[Producer] Subscriber registered:', res.data)
  return res.data.subscriberId
}

// Step 2: Fire an event
const fireEvent = async (type, payload) => {
  const res = await axios.post(`${BASE_URL}/events`, { type, payload })
  console.log(`[Producer] Event fired (${type}):`, res.data)
}

// Step 3: Check delivery logs for a subscriber
const checkLogs = async (subscriberId) => {
  const res = await axios.get(`${BASE_URL}/webhooks/${subscriberId}/logs`)
  console.log('[Producer] Delivery logs:')
  res.data.logs.forEach(log => {
    const status = log.success ? '✅' : '❌'
    console.log(`  ${status} Attempt ${log.attemptNumber} → ${log.statusCode} at ${log.createdAt}`)
  })
}

const run = async () => {
  try {
    // Register subscriber
    console.log('\n--- Registering Subscriber ---')
    const subscriberId = await registerSubscriber()

    // Wait a moment then fire multiple events
    await new Promise(r => setTimeout(r, 500))

    console.log('\n--- Firing Events ---')
    await fireEvent('payment.success', {
      orderId: `ORD-${Date.now()}`,
      amount: 4999,
      currency: 'INR',
      userId: 'user_123'
    })

    await fireEvent('order.created', {
      orderId: `ORD-${Date.now() + 1}`,
      items: ['item_a', 'item_b'],
      total: 1299
    })

    await fireEvent('payment.failed', {
      orderId: `ORD-${Date.now() + 2}`,
      reason: 'insufficient_funds'
    })

    // Wait for deliveries to process, then check logs
    console.log(`\n--- Waiting ${Math.round(DELIVERY_WAIT_MS / 1000)}s for deliveries to process ---`)
    await new Promise(r => setTimeout(r, DELIVERY_WAIT_MS))

    console.log('\n--- Delivery Logs ---')
    await checkLogs(subscriberId)

  } catch (err) {
    console.error('[Producer] Error:', err.response?.data || err.message)
  }
}

run()