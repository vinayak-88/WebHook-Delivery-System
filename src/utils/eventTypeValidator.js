const EventType = require('../models/EventType');
const logger = require('../config/logger');

/**
 * Validate that an array of event types (or a single event type string)
 * is registered and active in the EventType registry.
 *
 * If EVENT_TYPE_STRICT_MODE is 'true', or if the registry has at least one active
 * event type, unregistered event types will cause an error to be thrown.
 * Otherwise, in development with an empty registry, a warning is logged.
 *
 * @param {string | string[]} types
 * @throws {Error} with statusCode 400 if validation fails
 */
async function validateRegisteredEventTypes(types) {
  const typeList = Array.isArray(types) ? types : [types];
  if (typeList.length === 0) return;

  const isStrict = process.env.EVENT_TYPE_STRICT_MODE === 'true';
  const totalCount = await EventType.countDocuments({ isActive: true });

  if (isStrict || totalCount > 0) {
    const activeDocs = await EventType.find({
      name: { $in: typeList },
      isActive: true,
    }).select('name');

    const activeSet = new Set(activeDocs.map((doc) => doc.name));
    const unknown = typeList.filter((t) => !activeSet.has(t));

    if (unknown.length > 0) {
      const err = new Error(
        `Event type(s) not registered or inactive in registry: ${unknown.join(', ')}`
      );
      err.statusCode = 400;
      err.unknown = unknown;
      throw err;
    }
  }
}

module.exports = { validateRegisteredEventTypes };
