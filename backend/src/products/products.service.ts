import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const now = new Date();

    await this.prisma.order.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: now },
      },
      data: {
        status: 'EXPIRED',
      },
    });

    const products = await this.prisma.product.findMany({
      orderBy: { name: 'asc' },
      include: {
        items: {
          where: {
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
          select: {
            quantity: true,
          },
        },
      },
    });

    return products.map((product) => {
      const heldUnits = product.items.reduce(
        (total, item) => total + item.quantity,
        0,
      );

      const { items, ...details } = product;

      return {
        ...details,
        availableUnits: Math.max(0, product.stock - heldUnits),
      };
    });
  }
}
