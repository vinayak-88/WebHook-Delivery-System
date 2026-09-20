/**
 * Job data schema validation for BullMQ delivery jobs.
 *
 * Validates job data before it is added to the queue (producer-side)
 * and again inside the worker before processing (consumer-side).
 *
 * This is a trust boundary: even if the API creates jobs, the worker
 * should not assume every job is correctly shaped.
 */

const VALID_OBJECTID_RE = /^[0-9a-fA-F]{24}$/;
const VALID_URL_RE = /^https?:\/\/.+/;

/**
 * Validate delivery job data.
 *
 * @param {object} data - The job data object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDeliveryJobData(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['job data must be a non-null object'] };
  }

  // eventId — must be a valid 24-char hex MongoDB ObjectId string
  if (!data.eventId || typeof data.eventId !== 'string') {
    errors.push('eventId is required and must be a string');
  } else if (!VALID_OBJECTID_RE.test(data.eventId)) {
    errors.push(`eventId "${data.eventId}" is not a valid ObjectId`);
  }

  // subscriberId — must be a valid 24-char hex MongoDB ObjectId string
  if (!data.subscriberId || typeof data.subscriberId !== 'string') {
    errors.push('subscriberId is required and must be a string');
  } else if (!VALID_OBJECTID_RE.test(data.subscriberId)) {
    errors.push(`subscriberId "${data.subscriberId}" is not a valid ObjectId`);
  }

  // subscriberUrl — must be a non-empty string starting with http(s)://
  if (!data.subscriberUrl || typeof data.subscriberUrl !== 'string') {
    errors.push('subscriberUrl is required and must be a string');
  } else if (!VALID_URL_RE.test(data.subscriberUrl)) {
    errors.push(`subscriberUrl "${data.subscriberUrl}" is not a valid HTTP/HTTPS URL`);
  }

  // payload — must be present and not undefined/null
  if (data.payload === undefined || data.payload === null) {
    errors.push('payload is required');
  }

  // requestId — optional but if present must be a non-empty string
  if (data.requestId !== undefined && data.requestId !== null) {
    if (typeof data.requestId !== 'string' || data.requestId.trim() === '') {
      errors.push('requestId, if provided, must be a non-empty string');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate job data and throw an Error with all validation errors if invalid.
 *
 * @param {object} data
 * @throws {Error} if validation fails
 */
function assertValidDeliveryJobData(data) {
  const { valid, errors } = validateDeliveryJobData(data);
  if (!valid) {
    throw new Error(`Invalid delivery job data: ${errors.join('; ')}`);
  }
}

module.exports = { validateDeliveryJobData, assertValidDeliveryJobData };
