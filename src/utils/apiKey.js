const crypto = require('crypto');

function generateApiKey() {
    const key = crypto.randomBytes(32).toString('hex');
    return key;
}

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

module.exports = {generateApiKey, hashKey}