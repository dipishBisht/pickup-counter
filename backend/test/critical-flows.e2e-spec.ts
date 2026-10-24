import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Real HTTP requests against a real PostgreSQL test database. No mocks.
let app: INestApplication;
let prisma: PrismaService;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  // Must mirror main.ts: raw body (for the HMAC) and the same validation pipe options.
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(0);
  prisma = app.get(PrismaService);
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

beforeEach(async () => {
  await prisma.orderItem.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
});

// ---------- helpers ----------
const createProduct = (stock: number) =>
  prisma.product.create({
    data: { name: `Test snack ${randomUUID()}`, price: 2250, stock },
  });

const placeOrder = (productId: string, quantity = 1) =>
  fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      items: [{ productId, quantity }],
    }),
  });

const sendWebhook = (payload: object) => {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest('hex');
  return fetch(`${baseUrl}/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
    body: rawBody,
  });
};

const claimPickup = (orderId: string) =>
  fetch(`${baseUrl}/orders/${orderId}/pickup-claim`, { method: 'POST' });

async function createPaidOrder(stock: number, quantity: number) {
  const product = await createProduct(stock);
  const order = await (await placeOrder(product.id, quantity)).json();
  const res = await sendWebhook({
    eventId: `evt_${randomUUID()}`,
    orderId: order.id,
    amount: order.total,
    status: 'captured',
  });
  expect(res.status).toBe(200);
  expect(
    (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
  ).toBe('PAID');
  return { product, order };
}

// ---------- the three required scenarios ----------
describe('10 customers competing for the last 2 units', () => {
  it('holds exactly 2 units and fails the other 8 orders cleanly', async () => {
    const product = await createProduct(2);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => placeOrder(product.id, 1)),
    );
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    // Clean failure = 409 Conflict, never a 500 / crash / deadlock.
    expect(statuses.filter((s) => s === 409)).toHaveLength(8);
    const failedBody = await responses.find((r) => r.status === 409)!.json();
    expect(failedBody.message).toContain('Insufficient stock');

    // Database truth: only 2 orders exist, holding 2 units in total; failures held nothing.
    expect(await prisma.order.count()).toBe(2);
    expect(await prisma.order.count({ where: { status: 'PENDING' } })).toBe(2);
    const held = await prisma.orderItem.aggregate({
      _sum: { quantity: true },
      where: { productId: product.id },
    });
    expect(held._sum.quantity).toBe(2);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(2); // stock only drops at pickup

    const products = await (await fetch(`${baseUrl}/products`)).json();
    expect(
      products.find((p: { id: string }) => p.id === product.id).availableUnits,
    ).toBe(0);
  });
});

describe('duplicate payment webhook events', () => {
  it('processes the order once when the same event arrives twice at the same time', async () => {
    const product = await createProduct(5);
    const order = await (await placeOrder(product.id)).json();
    const payload = {
      eventId: `evt_${randomUUID()}`,
      orderId: order.id,
      amount: order.total,
      status: 'captured',
    };

    const responses = await Promise.all([
      sendWebhook(payload),
      sendWebhook(payload),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(bodies.filter((b) => b.duplicate === false)).toHaveLength(1);
    expect(bodies.filter((b) => b.duplicate === true)).toHaveLength(1);
    expect(
      await prisma.webhookEvent.count({ where: { eventId: payload.eventId } }),
    ).toBe(1);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe('PAID');
  });

  it('changes nothing when the event is replayed later', async () => {
    const product = await createProduct(5);
    const order = await (await placeOrder(product.id)).json();
    const payload = {
      eventId: `evt_${randomUUID()}`,
      orderId: order.id,
      amount: order.total,
      status: 'captured',
    };

    const first = await (await sendWebhook(payload)).json();
    const afterFirst = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    const replay = await sendWebhook(payload);
    const second = await replay.json();
    const afterSecond = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(first.duplicate).toBe(false);
    expect(replay.status).toBe(200);
    expect(second.duplicate).toBe(true);
    expect(afterSecond.status).toBe('PAID');
    expect(afterSecond.updatedAt.getTime()).toBe(
      afterFirst.updatedAt.getTime(),
    ); // row untouched by the replay
    expect(await prisma.webhookEvent.count()).toBe(1);
  });
});

describe('two simultaneous pickup claims', () => {
  it('lets exactly one succeed, the other gets 409, and stock drops once', async () => {
    const { product, order } = await createPaidOrder(5, 2);

    const responses = await Promise.all([
      claimPickup(order.id),
      claimPickup(order.id),
    ]);
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(finalOrder.status).toBe('PICKED_UP');
    expect(finalOrder.claimedAt).not.toBeNull();
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(3); // 5 - 2, deducted once

    expect((await claimPickup(order.id)).status).toBe(409); // a later claim is rejected too
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(3);
  });
});
