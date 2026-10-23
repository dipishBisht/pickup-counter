import "dotenv/config";
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

const products = [
  { name: 'Potato Chips', price: 2000, stock: 10 },
  { name: 'Chocolate Bar', price: 3000, stock: 8 },
  { name: 'Bottled Water', price: 1500, stock: 12 },
  { name: 'Cookies', price: 2500, stock: 7 },
  { name: 'Soft Drink', price: 3500, stock: 6 },
];

async function main() {
  for (const product of products) {
    await prisma.product.upsert({
      where: { name: product.name },
      update: {
        price: product.price,
        stock: product.stock,
      },
      create: product,
    });
  }

  console.log('Seeded 5 snack products.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
