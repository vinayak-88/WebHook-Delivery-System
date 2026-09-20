const express = require('express');
const { verifySignature } = require('../utils/hmac');

const app = express();

// Capture raw body bytes so signature verification operates on the exact bytes that were signed
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const signingKey = process.env.WEBHOOK_SECRET || 'mock-shared-webhook-secret-at-least-32-chars-long!';
if (!process.env.WEBHOOK_SECRET) {
  console.warn(
    '[Subscriber] WEBHOOK_SECRET not set — using default dev secret. ' +
    'Set WEBHOOK_SECRET to match the `secret` used at subscriber registration.'
  );
}

let requestCount = 0;

app.post('/receive', (req, res) => {
  requestCount++;
  const signature = req.headers['x-webhook-signature'];
  const attemptNumber = req.headers['x-webhook-attempt'];
  const timestamp = req.headers['x-timestamp'];

  console.log(`\n[Subscriber] Request #${requestCount} received`);
  console.log(`  Event:     `, req.body);
  console.log(`  Attempt:   `, attemptNumber);
  console.log(`  Timestamp: `, timestamp);
  console.log(`  Signature: `, signature);

  // Verify against raw body bytes using the shared secret and timestamp
  const isValid = verifySignature(req.rawBody, signingKey, timestamp, signature);
  if (!isValid) {
    console.log(`  Invalid signature`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  console.log(`  Signature verified`);

  // Simulate 30% failure rate to trigger retry logic
  if (Math.random() < 0.3) {
    console.log(`  Simulating server failure (503)`);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  console.log(`  Delivery successful`);
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });
});

app.listen(4000, () => {
  console.log('[Subscriber] Mock subscriber running on port 4000');
  console.log('[Subscriber] Expecting events at http://localhost:4000/receive');
  console.log('[Subscriber] 30% random failure rate enabled to test retries\n');
});