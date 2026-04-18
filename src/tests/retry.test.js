const { generateSignature, verifySignature } = require('../utils/hmac')

jest.mock('axios')
jest.mock('../models/deliveryLog', () => ({ create: jest.fn().mockResolvedValue({}) }))
jest.mock('../models/subscriber', () => ({
  findById: jest.fn()
}))
jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const axios = require('axios')
const DeliveryLog = require('../models/deliveryLog')
const Subscriber = require('../models/subscriber')
const { processDeliveryJob } = require('../workers/deliveryWorker')

// Helper — builds a minimal BullMQ-shaped job object
const makeJob = (overrides = {}) => ({
  id: 'job-test-1',
  attemptsMade: 0,
  data: {
    eventId: 'event-1',
    subscriberId: 'sub-1',
    subscriberUrl: 'http://mock-subscriber.com/receive',
    payload: { orderId: 'ORD-1' }
    // no secret in job data — worker fetches from DB
  },
  ...overrides
})

// Stub Subscriber.findById to return a secretHash by default
beforeEach(() => {
  jest.clearAllMocks()
  Subscriber.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({ secretHash: 'test-secret-hash' })
  })
})

// --- HMAC integration ---
describe('Delivery Signature Behaviour', () => {
  const secret = 'sub-secret'
  const payload = { orderId: 'ORD-999', amount: 500 }

  it('signed payload produces a verifiable signature on subscriber side', () => {
    const bodyBuffer = Buffer.from(JSON.stringify(payload))
    const signature = generateSignature(bodyBuffer, secret)
    expect(verifySignature(bodyBuffer, secret, signature)).toBe(true)
  })

  it('subscriber rejects a delivery where payload was modified in transit', () => {
    const bodyBuffer = Buffer.from(JSON.stringify(payload))
    const signature = generateSignature(bodyBuffer, secret)
    const modifiedBuffer = Buffer.from(JSON.stringify({ ...payload, amount: 99999 }))
    expect(verifySignature(modifiedBuffer, secret, signature)).toBe(false)
  })
})

// --- Retry behaviour via processDeliveryJob ---
describe('Delivery Retry Behaviour', () => {
  it('resolves and logs success on 200', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { received: true } })

    await processDeliveryJob(makeJob())

    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, statusCode: 200 })
    )
    expect(axios.post).toHaveBeenCalledTimes(1)
  })

  it('throws on 503 so BullMQ knows to retry, logs the failure', async () => {
    const err = new Error('Request failed with status code 503')
    err.response = { status: 503, data: { error: 'unavailable' } }
    axios.post.mockRejectedValueOnce(err)

    await expect(processDeliveryJob(makeJob())).rejects.toThrow()

    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: 503 })
    )
  })

  it('throws on network timeout, logs null statusCode', async () => {
    const err = new Error('ECONNREFUSED')
    err.code = 'ECONNREFUSED'
    axios.post.mockRejectedValueOnce(err)

    await expect(processDeliveryJob(makeJob())).rejects.toThrow('ECONNREFUSED')

    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: null })
    )
  })

  it('throws permanently when subscriber record is not found', async () => {
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(null)
    })

    await expect(processDeliveryJob(makeJob())).rejects.toThrow(
      'Subscriber sub-1 not found'
    )

    // No delivery attempt should be made
    expect(axios.post).not.toHaveBeenCalled()
    expect(DeliveryLog.create).not.toHaveBeenCalled()
  })

  it('succeeds after simulated retry (fail once then succeed)', async () => {
    const networkError = new Error('Service temporarily unavailable')
    networkError.response = { status: 503, data: {} }

    // Attempt 1 — fails
    axios.post.mockRejectedValueOnce(networkError)
    await expect(processDeliveryJob(makeJob({ attemptsMade: 0 }))).rejects.toThrow()
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, attemptNumber: 1 })
    )

    jest.clearAllMocks()
    Subscriber.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ secretHash: 'test-secret-hash' })
    })

    // Attempt 2 — succeeds (BullMQ increments attemptsMade before retry)
    axios.post.mockResolvedValueOnce({ status: 200, data: { received: true } })
    await processDeliveryJob(makeJob({ attemptsMade: 1 }))
    expect(DeliveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, attemptNumber: 2 })
    )
  })
})