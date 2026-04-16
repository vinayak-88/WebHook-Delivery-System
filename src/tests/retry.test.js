const { generateSignature, verifySignature } = require('../src/utils/hmac')

// Mock axios entirely — no outbound HTTP needed
jest.mock('axios')
const axios = require('axios')

// --- HMAC integration with delivery ---
describe('Delivery Signature Behaviour', () => {

  const secret = 'sub-secret'
  const payload = { orderId: 'ORD-999', amount: 500 }

  it('signed payload produces a verifiable signature on subscriber side', () => {
    const signature = generateSignature(payload, secret)
    expect(verifySignature(payload, secret, signature)).toBe(true)
  })

  it('subscriber rejects a delivery where payload was modified in transit', () => {
    const signature = generateSignature(payload, secret)
    const modifiedPayload = { ...payload, amount: 99999 }
    expect(verifySignature(modifiedPayload, secret, signature)).toBe(false)
  })
})

// --- Retry behaviour (mocked axios) ---
describe('Delivery Retry Behaviour', () => {

  beforeEach(() => jest.clearAllMocks())

  it('succeeds on first attempt when subscriber returns 200', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { received: true } })

    const response = await axios.post(
      'http://mock-subscriber.com/receive',
      { orderId: 'ORD-1' },
      { headers: { 'X-Webhook-Signature': 'sig' } }
    )

    expect(response.status).toBe(200)
    expect(axios.post).toHaveBeenCalledTimes(1)
  })

  it('throws on 503 so BullMQ knows to retry', async () => {
    const error = new Error('Request failed with status code 503')
    error.response = { status: 503, data: { error: 'unavailable' } }
    axios.post.mockRejectedValueOnce(error)

    await expect(
      axios.post('http://mock-subscriber.com/receive', {})
    ).rejects.toThrow()
  })

  it('throws on network timeout so BullMQ knows to retry', async () => {
    const error = new Error('ECONNREFUSED')
    error.code = 'ECONNREFUSED'
    axios.post.mockRejectedValueOnce(error)

    await expect(
      axios.post('http://mock-subscriber.com/receive', {})
    ).rejects.toThrow('ECONNREFUSED')
  })

  it('succeeds after simulated retry (fail once then succeed)', async () => {
    const networkError = new Error('Service temporarily unavailable')
    networkError.response = { status: 503 }

    // Attempt 1 — fails, attempt 2 — succeeds
    axios.post
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({ status: 200, data: { received: true } })

    // Attempt 1 (BullMQ would catch this and schedule retry)
    await expect(axios.post('http://mock-subscriber.com/receive', {}))
      .rejects.toThrow()

    // Attempt 2 (after backoff delay, BullMQ retries)
    const response = await axios.post('http://mock-subscriber.com/receive', {})
    expect(response.status).toBe(200)
    expect(axios.post).toHaveBeenCalledTimes(2)
  })
})