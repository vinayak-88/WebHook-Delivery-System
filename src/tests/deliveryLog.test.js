const DeliveryLog = require('../models/DeliveryLog');

describe('DeliveryLog audit schema', () => {
  it('records createdAt but generates no updatedAt (append-only audit record)', () => {
    expect(DeliveryLog.schema.path('createdAt')).toBeDefined();
    expect(DeliveryLog.schema.path('updatedAt')).toBeUndefined();
  });

  it('supports the documented audit fields', () => {
    for (const path of [
      'eventId',
      'subscriberId',
      'subscriberUrl',
      'attemptNumber',
      'statusCode',
      'responseBody',
      'success',
      'errorMessage',
      'durationMs',
      'requestId',
    ]) {
      expect(DeliveryLog.schema.path(path)).toBeDefined();
    }
  });
});
