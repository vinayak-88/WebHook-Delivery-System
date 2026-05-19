const Subscriber = require('../models/Subscriber')
const { hashKey } = require("../utils/apiKey");

const authenticateSubscriber = async (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ message: "API key required" });

  const hashed = hashKey(apiKey);
  try {
    const subscriber = await Subscriber.findOne({
      apiSecret: hashed,
      isActive: true,
    });

    if (!subscriber) return res.status(401).json({ message: "Invalid API key" });
    req.subscriber = subscriber;
    next();
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = authenticateSubscriber;