import { createHmac, randomUUID } from 'node:crypto';

const API_URL = process.env.API_URL ?? 'http://localhost:8080';
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET;

async function main() {
  const orderId = process.argv[2];

  if (!orderId) {
    throw new Error('Usage: npx tsx scripts/simulate-payment.ts <ORDER_ID>');
  }

  if (!SECRET) {
    throw new Error('PAYMENT_WEBHOOK_SECRET is not set.');
  }

  // Fetch the real order created by the frontend.
  const orderResponse = await fetch(`${API_URL}/orders/${orderId}`);
  const order = await orderResponse.json();

  if (!orderResponse.ok) {
    throw new Error(`Could not fetch order: ${JSON.stringify(order)}`);
  }

  if (order.status !== 'PENDING') {
    throw new Error(`Order status is ${order.status}, not PENDING.`);
  }

  // Match the field names expected by your webhook.
  const payload = {
    eventId: randomUUID(),
    orderId: order.id,
    amount: order.total,
    status: 'captured',
  };

  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', SECRET).update(rawBody).digest('hex');

  const response = await fetch(`${API_URL}/payments/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': signature,
    },
    body: rawBody,
  });

  const result = await response.text();

  console.log('Webhook HTTP status:', response.status);
  console.log('Webhook response:', result);

  if (!response.ok) {
    throw new Error('Payment webhook request failed.');
  }

  console.log(`Payment simulation sent for order ${order.id}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
