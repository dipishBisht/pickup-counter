import 'dotenv/config';
import { createHmac } from 'node:crypto';

const baseUrl = process.env.API_URL ?? 'http://localhost:8080';
const secret = process.env.PAYMENT_WEBHOOK_SECRET!;

if (!secret) {
  throw new Error('PAYMENT_WEBHOOK_SECRET is missing from backend/.env');
}

async function main() {
  // First, create an order using a real product from the database.
  const productsResponse = await fetch(`${baseUrl}/products`);
  if (!productsResponse.ok) {
    throw new Error(`Products request failed: ${productsResponse.status}`);
  }

  const products = (await productsResponse.json()) as Array<{
    id: string;
    name: string;
    availableUnits: number;
  }>;

  const product = products.find((p) => p.availableUnits > 0);
  if (!product) throw new Error('No products have available stock');

  const idempotencyKey = `webhook-test-${Date.now()}`;

  const orderResponse = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey,
      items: [{ productId: product.id, quantity: 1 }],
    }),
  });

  const order = (await orderResponse.json()) as {
    id: string;
    total?: number;
    status: string;
  };

  if (!orderResponse.ok) {
    throw new Error(`Order creation failed: ${JSON.stringify(order)}`);
  }

  const amount = order.total ?? order.total;
  if (typeof amount !== 'number') {
    throw new Error(`Could not read order total: ${JSON.stringify(order)}`);
  }

  const payload = {
    eventId: `evt-${Date.now()}`,
    orderId: order.id,
    amount,
    status: 'captured',
  };

  // Sign the exact serialized string that will be sent.
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');

  async function sendWebhook() {
    return fetch(`${baseUrl}/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
      },
      body: rawBody,
    });
  }

  const first = await sendWebhook();
  console.log('First webhook:', first.status, await first.text());

  const second = await sendWebhook();
  console.log('Duplicate webhook:', second.status, await second.text());

  const orderStatusResponse = await fetch(`${baseUrl}/orders/${order.id}`);
  console.log(
    'Final order:',
    orderStatusResponse.status,
    await orderStatusResponse.text(),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
