const {
  validateDeliveryJobData,
  assertValidDeliveryJobData,
} = require('../utils/jobSchema');

describe('Delivery Job Schema Validation', () => {
  const validJobData = {
    eventId: '507f1f77bcf86cd799439011',
    subscriberId: '507f191e810c19729de860ea',
    subscriberUrl: 'https://example.com/webhook',
    payload: { orderId: 'ORD-123', amount: 4999 },
    requestId: 'req-uuid-1234',
  };

  it('passes validation for a correctly formed job data object', () => {
    const { valid, errors } = validateDeliveryJobData(validJobData);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
    expect(() => assertValidDeliveryJobData(validJobData)).not.toThrow();
  });

  it('allows optional requestId to be absent or null', () => {
    const withoutReqId = { ...validJobData };
    delete withoutReqId.requestId;
    expect(validateDeliveryJobData(withoutReqId).valid).toBe(true);

    const withNullReqId = { ...validJobData, requestId: null };
    expect(validateDeliveryJobData(withNullReqId).valid).toBe(true);
  });

  it('rejects null or non-object input', () => {
    expect(validateDeliveryJobData(null).valid).toBe(false);
    expect(validateDeliveryJobData('string').valid).toBe(false);
    expect(() => assertValidDeliveryJobData(undefined)).toThrow();
  });

  it('rejects missing or malformed eventId', () => {
    expect(validateDeliveryJobData({ ...validJobData, eventId: '' }).valid).toBe(false);
    expect(validateDeliveryJobData({ ...validJobData, eventId: 'not-an-objectid' }).valid).toBe(false);
    expect(validateDeliveryJobData({ ...validJobData, eventId: 12345 }).valid).toBe(false);
  });

  it('rejects missing or malformed subscriberId', () => {
    expect(validateDeliveryJobData({ ...validJobData, subscriberId: '' }).valid).toBe(false);
    expect(validateDeliveryJobData({ ...validJobData, subscriberId: 'short-id' }).valid).toBe(false);
  });

  it('rejects missing, malformed, or non-HTTP subscriberUrl', () => {
    expect(validateDeliveryJobData({ ...validJobData, subscriberUrl: '' }).valid).toBe(false);
    expect(validateDeliveryJobData({ ...validJobData, subscriberUrl: 'ftp://bad.com' }).valid).toBe(false);
    expect(validateDeliveryJobData({ ...validJobData, subscriberUrl: 'javascript:alert(1)' }).valid).toBe(false);
  });

  it('rejects missing or undefined payload', () => {
    const missingPayload = { ...validJobData };
    delete missingPayload.payload;
    expect(validateDeliveryJobData(missingPayload).valid).toBe(false);
    expect(validateDeliveryJobData({ ...validJobData, payload: null }).valid).toBe(false);
  });

  it('assertValidDeliveryJobData throws descriptive error on failure', () => {
    expect(() =>
      assertValidDeliveryJobData({
        eventId: 'bad',
        subscriberId: 'bad',
        subscriberUrl: 'bad',
        payload: null,
      })
    ).toThrow(/Invalid delivery job data/);
  });
});
