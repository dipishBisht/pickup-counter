import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string | undefined,
    @Body()
    body: {
      eventId: string;
      orderId: string;
      amount: number;
      status: string;
    },
  ) {
    const secret = process.env.PAYMENT_WEBHOOK_SECRET;
    const rawBody = req.rawBody;

    if (!secret || !rawBody || !signature) {
      throw new UnauthorizedException(
        'Missing webhook signature or configuration',
      );
    }

    const crypto = await import('node:crypto');
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest();

    let received: Buffer;

    try {
      if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
        throw new Error('Invalid signature format');
      }
      received = Buffer.from(signature, 'hex');
    } catch {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (
      !body ||
      typeof body.eventId !== 'string' ||
      typeof body.orderId !== 'string' ||
      !Number.isSafeInteger(body.amount) ||
      body.amount < 0 ||
      body.status !== 'captured'
    ) {
      throw new BadRequestException('Invalid payment webhook payload');
    }

    return this.paymentsService.processCapturedEvent(body);
  }
}
