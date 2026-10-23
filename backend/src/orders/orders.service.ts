import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';

const HOLD_SECONDS = 120;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateOrderDto) {
    // Combine repeated product IDs so each product appears once.
    const quantities = new Map<string, number>();

    for (const item of dto.items) {
      quantities.set(
        item.productId,
        (quantities.get(item.productId) ?? 0) + item.quantity,
      );
    }

    const requested = [...quantities.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Lock every requested product in a consistent order.
          // Concurrent orders for the same product must wait here.
          for (const [productId] of requested) {
            const rows = await tx.$queryRaw<{ id: string }[]>`
              SELECT id
              FROM "Product"
              WHERE id = ${productId}::uuid
              FOR UPDATE
            `;

            if (rows.length === 0) {
              throw new NotFoundException(`Product ${productId} not found`);
            }
          }

          // A retry with the same key must not create a second order.
          const existing = await tx.order.findUnique({
            where: { idempotencyKey: dto.idempotencyKey },
            include: { items: true },
          });

          if (existing) {
            return existing;
          }

          const products = await tx.product.findMany({
            where: {
              id: { in: requested.map(([id]) => id) },
            },
          });

          const now = new Date();
          const lines: {
            productId: string;
            quantity: number;
            price: number;
          }[] = [];

          let total = 0;

          for (const [productId, quantity] of requested) {
            const product = products.find((p) => p.id === productId);

            if (!product) {
              throw new NotFoundException(`Product ${productId} not found`);
            }

            // Count active holds, including paid orders awaiting pickup.
            const held = await tx.orderItem.aggregate({
              where: {
                productId,
                order: {
                  OR: [
                    {
                      status: 'PENDING',
                      expiresAt: { gt: now },
                    },
                    {
                      status: 'PAID',
                      claimedAt: null,
                    },
                  ],
                },
              },
              _sum: { quantity: true },
            });

            const heldUnits = held._sum.quantity ?? 0;
            const available = product.stock - heldUnits;

            if (quantity > available) {
              throw new ConflictException(
                `Insufficient stock for ${product.name}. Available: ${Math.max(0, available)}`,
              );
            }

            lines.push({
              productId,
              quantity,
              price: product.price,
            });

            total += product.price * quantity;
          }

          const expiresAt = new Date(Date.now() + HOLD_SECONDS * 1000);

          const order = await tx.order.create({
            data: {
              idempotencyKey: dto.idempotencyKey,
              status: 'PENDING',
              total,
              expiresAt,
              items: {
                create: lines.map((line) => ({
                  productId: line.productId,
                  quantity: line.quantity,
                  price: line.price,
                })),
              },
            },
            include: { items: true },
          });

          return order;
        },
        { isolationLevel: 'ReadCommitted' },
      );
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        throw error;
      }

      // A concurrent request might have used the same idempotency key.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.order.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: { items: true },
        });

        if (existing) return existing;
      }

      throw error;
    }
  }

  async findById(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.status === 'PENDING' && order.expiresAt <= new Date()) {
      await this.prisma.order.updateMany({
        where: {
          id,
          status: 'PENDING',
          expiresAt: { lte: new Date() },
        },
        data: { status: 'EXPIRED' },
      });
    }

    return this.prisma.order.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
  }
}
