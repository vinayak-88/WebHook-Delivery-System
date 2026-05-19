const Producer = require("../models/Producer");
const { hashKey } = require("../utils/apiKey");

const authenticateProducer = async (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ message: "API key required" });

  const hashed = hashKey(apiKey);
  try {
    const producer = await Producer.findOne({
      apiSecret: hashed,
      isActive: true,
    });

    if (!producer) return res.status(403).json({ message: "Invalid API key" });
    req.producer = producer;
    next();
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = authenticateProducer;
