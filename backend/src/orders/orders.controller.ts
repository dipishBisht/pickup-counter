import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateOrderDto) {
    const order = await this.ordersService.create(dto);

    // Calculate immediately before sending the response.
    const expiresInSeconds = Math.max(
      0,
      Math.ceil((order.expiresAt.getTime() - Date.now()) / 1000),
    );

    return {
      id: order.id,
      status: order.status,
      total: order.total,
      expiresAt: order.expiresAt,
      expiresInSeconds,
      items: order.items,
    };
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    const order = await this.ordersService.findById(id);

    return {
      id: order.id,
      status: order.status,
      total: order.total,
      expiresAt: order.expiresAt,
      expiresInSeconds: Math.max(
        0,
        Math.ceil((order.expiresAt.getTime() - Date.now()) / 1000),
      ),
      items: order.items,
    };
  }

  @Post(':id/pickup-claim')
  async claimPickup(@Param('id') id: string) {
    return this.ordersService.claimPickup(id);
  }
}
