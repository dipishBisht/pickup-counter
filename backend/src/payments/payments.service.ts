import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';

type CapturedEvent = {
  eventId: string;
  orderId: string;
  amount: number;
  status: string;
};

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async processCapturedEvent(event: CapturedEvent) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const duplicate = await tx.webhookEvent.findUnique({
          where: { eventId: event.eventId },
        });

        if (duplicate) {
          return { received: true, duplicate: true };
        }

        const order = await tx.order.findUnique({
          where: { id: event.orderId },
        });

        if (!order) {
          throw new NotFoundException('Order not found');
        }

        await tx.webhookEvent.create({
          data: {
            eventId: event.eventId,
            orderId: event.orderId,
            amount: event.amount,
            status: event.status,
          },
        });

        // Don't change an order that has already reached a final state.
        if (order.status !== 'PENDING') {
          return {
            received: true,
            duplicate: false,
            orderStatus: order.status,
          };
        }

        // A mismatch or a payment arriving after expiry requires review.
        if (
          event.amount !== order.total ||
          order.expiresAt <= new Date()
        ) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: 'NEEDS_REVIEW' },
          });

          return {
            received: true,
            duplicate: false,
            orderStatus: 'NEEDS_REVIEW',
          };
        }

        await tx.order.update({
          where: { id: order.id },
          data: { status: 'PAID' },
        });

        return {
          received: true,
          duplicate: false,
          orderStatus: 'PAID',
        };
      });
    } catch (error) {
      // Concurrent deliveries of the same event may race on the unique key.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { received: true, duplicate: true };
      }

      throw error;
    }
  }
}
