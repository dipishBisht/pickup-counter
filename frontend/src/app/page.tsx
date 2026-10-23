"use client";

import { useCallback, useEffect, useState } from "react";

type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
  availableUnits: number;
};

type OrderItem = {
  id: string;
  productId: string;
  quantity: number;
  price: number;
};

type Order = {
  id: string;
  status: string;
  total: number;
  expiresAt: string;
  expiresInSeconds?: number;
  items: OrderItem[];
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

const productArt = [
  { background: "bg-[#e8efe7]", foreground: "text-[#315d46]", symbol: "◉" },
  { background: "bg-[#f4e8da]", foreground: "text-[#8d542f]", symbol: "▰" },
  { background: "bg-[#eee8f4]", foreground: "text-[#76528c]", symbol: "▤" },
  { background: "bg-[#f4e6e4]", foreground: "text-[#a34d43]", symbol: "◈" },
  { background: "bg-[#e2ecef]", foreground: "text-[#3e6c7c]", symbol: "◒" },
];

const statusStyles: Record<string, string> = {
  paid: "bg-green-100 text-green-800",
  picked_up: "bg-green-100 text-green-800",
  expired: "bg-orange-100 text-orange-800",
  needs_review: "bg-orange-100 text-orange-800",
  pending: "bg-amber-100 text-amber-800",
};

function formatPrice(paise: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(paise / 100);
}

async function fetchProducts(signal?: AbortSignal): Promise<Product[]> {
  const response = await fetch(`${API_URL}/products`, {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error("Could not load products.");
  }

  return response.json();
}

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<Order | null>(null);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [clockTick, setClockTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadProducts = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchProducts(signal);

      if (signal?.aborted) return;

      setProducts(data);
      setError("");
    } catch {
      if (signal?.aborted) return;

      setError(
        "Unable to connect to the store. Check that the backend is running.",
      );
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  // Load products when the page mounts.
  useEffect(() => {
    const controller = new AbortController();

    async function initializeProducts() {
      await loadProducts(controller.signal);
    }

    void initializeProducts();

    return () => controller.abort();
  }, [loadProducts]);

  // Update the countdown while an order is pending.
  useEffect(() => {
    if (!order || order.status !== "PENDING") return;

    const timer = window.setInterval(() => {
      setCurrentTime(Date.now());
      setClockTick((tick) => tick + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [order?.id, order?.status]);

  // Poll the backend for payment and order status updates.
  useEffect(() => {
    if (!order || order.status !== "PENDING") return;

    const controller = new AbortController();
    let cancelled = false;

    async function checkStatus() {
      try {
        const response = await fetch(`${API_URL}/orders/${order!.id}`, {
          cache: "no-store",
          signal: controller.signal,
        });

        if (!response.ok) return;

        const latest: Order = await response.json();

        if (cancelled || controller.signal.aborted) return;

        setOrder(latest);

        if (latest.status !== "PENDING") {
          setNotice(
            latest.status === "PAID"
              ? "Payment confirmed. Your order is ready for pickup."
              : latest.status === "EXPIRED"
                ? "This order expired. Please place a new order."
                : latest.status === "NEEDS_REVIEW"
                  ? "Payment needs review. Please contact the store."
                  : `Order status: ${latest.status}`,
          );

          await loadProducts(controller.signal);
        }
      } catch {
        // Temporary polling failures should not erase the current order.
      }
    }

    const timer = window.setInterval(() => {
      void checkStatus();
    }, 3000);

    void checkStatus();

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [order?.id, order?.status, loadProducts]);

  const cartItems = products
    .filter((product) => (cart[product.id] ?? 0) > 0)
    .map((product) => ({
      ...product,
      quantity: cart[product.id],
    }));

  const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  const total = cartItems.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );

  // Calculate the remaining reservation time.
  const secondsLeft =
    order?.status === "PENDING" && currentTime > 0
      ? Math.max(
          0,
          Math.ceil((new Date(order.expiresAt).getTime() - currentTime) / 1000),
        )
      : 0;

  function changeQuantity(product: Product, delta: number) {
    setError("");

    setCart((current) => {
      const nextQuantity = (current[product.id] ?? 0) + delta;

      if (nextQuantity <= 0) {
        const next = { ...current };
        delete next[product.id];
        return next;
      }

      if (nextQuantity > product.availableUnits) {
        return current;
      }

      return {
        ...current,
        [product.id]: nextQuantity,
      };
    });
  }

  async function placeOrder() {
    if (cartItems.length === 0 || placingOrder) return;

    setError("");
    setNotice("");
    setPlacingOrder(true);

    try {
      const response = await fetch(`${API_URL}/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          items: cartItems.map((item) => ({
            productId: item.id,
            quantity: item.quantity,
          })),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.message ||
            "Could not place the order. Stock may have changed; refresh and try again.",
        );
      }

      const createdOrder = data as Order;

      setOrder(createdOrder);
      setCurrentTime(0);
      setCart({});
      setNotice("Order created. Complete payment before the hold expires.");

      await loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPlacingOrder(false);
    }
  }

  async function startNewOrder() {
    setOrder(null);
    setCurrentTime(0);
    setNotice("");
    setError("");
    setCart({});

    await loadProducts();
  }

  return (
    <main className="mx-auto min-h-screen max-w-[1440px] px-5 text-[#202b26] sm:px-8 lg:px-[6%]">
      {/* Header */}
      <header className="flex min-h-[68px] items-center justify-between border-b border-[#e6e8df] sm:min-h-[82px]">
        <a
          href="#"
          className="inline-flex items-center gap-3 text-lg font-extrabold tracking-tight"
        >
          <span className="grid size-[34px] place-items-center rounded-[11px] bg-[#235b43] text-xl text-white">
            P
          </span>
          <span>Pickup Counter</span>
        </a>

        <span className="text-right text-[9px] font-bold tracking-[1px] text-[#737b74] sm:text-[10px] sm:tracking-[1.8px]">
          QUICK PICKUP STORE
        </span>
      </header>

      {/* Hero */}
      <section className="flex min-h-[280px] items-center justify-between gap-5 border-b border-[#e6e8df] py-10 sm:min-h-[310px] sm:gap-8 sm:py-[52px]">
        <div>
          <p className="text-[10px] font-extrabold tracking-[1.8px] text-[#235b43]">
            ORDER ONLINE · PICK UP IN STORE
          </p>

          <h1 className="my-4 text-[40px] leading-[1.04] font-extrabold tracking-[-2px] sm:my-[17px] sm:text-6xl lg:text-[68px] lg:tracking-[-3.4px]">
            Good things.
            <br />
            Ready when you are.
          </h1>

          <p className="max-w-[470px] text-sm leading-7 text-[#737b74] sm:text-[15px] sm:leading-8">
            Choose your favourites, reserve your items, and collect them when
            your payment is confirmed.
          </p>
        </div>

        <div className="hidden size-[154px] shrink-0 rotate-[5deg] flex-col items-center justify-center gap-2 rounded-full border border-[#c8d8cb] text-xs font-semibold text-[#235b43] sm:flex">
          <span className="text-4xl">✳</span>
          <span>Quick order</span>
          <span>Easy pickup</span>
        </div>
      </section>

      {/* Alerts */}
      {error && (
        <div
          role="alert"
          className="mt-5 rounded-xl border border-[#edc6c0] bg-[#fff0ed] px-4 py-3 text-sm leading-6 text-[#922f24]"
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="mt-5 rounded-xl border border-[#cddfce] bg-[#edf6ed] px-4 py-3 text-sm leading-6 text-[#28573a]"
        >
          {notice}
        </div>
      )}

      {order ? (
        /* Order summary */
        <section className="mx-auto my-8 max-w-[660px] rounded-[17px] border border-[#e6e8df] bg-white p-5 sm:my-12 sm:p-[30px]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="mb-2 text-[10px] font-extrabold tracking-[1.8px] text-[#235b43]">
                YOUR ORDER
              </p>
              <h2 className="text-2xl font-bold tracking-tight sm:text-[27px]">
                Order summary
              </h2>
            </div>

            <span
              className={`shrink-0 rounded-full px-3 py-2 text-[10px] font-extrabold ${statusStyles[order.status.toLowerCase()] ?? "bg-stone-100 text-stone-700"}`}
            >
              {order.status.replaceAll("_", " ")}
            </span>
          </div>

          <p className="my-5 break-words text-xs text-[#737b74]">
            Reference: <strong className="text-[#202b26]">{order.id}</strong>
          </p>

          <div className="divide-y divide-[#e6e8df]">
            {order.items.map((item) => {
              const product = products.find((p) => p.id === item.productId);

              return (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-4 py-4 text-xs"
                >
                  <span>
                    {product?.name ?? "Store item"} × {item.quantity}
                  </span>
                  <strong className="shrink-0">
                    {formatPrice(item.price * item.quantity)}
                  </strong>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-[#e6e8df] py-4 text-sm">
            <span>Total</span>
            <strong className="text-xl tracking-tight">
              {formatPrice(order.total)}
            </strong>
          </div>

          {order.status === "PENDING" && (
            <div className="my-5 flex flex-col gap-3 rounded-xl bg-[#f1f5ed] p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
              <div className="grid gap-1.5">
                <span className="text-[9px] font-extrabold tracking-[1px] text-[#737b74]">
                  RESERVATION TIME LEFT
                </span>
                <strong className="text-[32px] leading-tight font-bold tabular-nums text-[#235b43]">
                  {String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:
                  {String(secondsLeft % 60).padStart(2, "0")}
                </strong>
              </div>

              <p className="max-w-[220px] text-[11px] leading-5 text-[#737b74]">
                Your items are temporarily reserved. This page checks payment
                status automatically.
              </p>
            </div>
          )}

          {order.status === "PAID" && (
            <p className="rounded-xl bg-[#eaf5e9] p-4 text-sm leading-6 text-[#245c37]">
              ✓ Payment confirmed. Show your order reference when collecting.
            </p>
          )}

          {order.status === "NEEDS_REVIEW" && (
            <p className="rounded-xl bg-[#fff2e5] p-4 text-sm leading-6 text-[#8a4d18]">
              Payment requires manual review. Please contact the store with your
              order reference.
            </p>
          )}

          {order.status === "EXPIRED" && (
            <p className="rounded-xl bg-[#fff2e5] p-4 text-sm leading-6 text-[#8a4d18]">
              Your reservation has expired and the held stock has been released.
            </p>
          )}

          {order.status === "PICKED_UP" && (
            <p className="rounded-xl bg-[#eaf5e9] p-4 text-sm leading-6 text-[#245c37]">
              ✓ This order has been picked up.
            </p>
          )}

          <button
            className="mt-4 min-h-[47px] w-full rounded-[10px] bg-[#235b43] px-4 py-3 text-[13px] font-bold text-white transition-colors hover:bg-[#194631] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#235b43] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={startNewOrder}
          >
            Back to store
          </button>
        </section>
      ) : (
        /* Store and basket */
        <div className="grid grid-cols-1 items-start gap-8 py-8 sm:py-[42px] lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10">
          <section>
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <p className="mb-2 text-[10px] font-extrabold tracking-[1.8px] text-[#235b43]">
                  THE EVERYDAY ESSENTIALS
                </p>
                <h2 className="text-2xl font-bold tracking-tight sm:text-[27px]">
                  Shop the counter
                </h2>
              </div>

              <span className="shrink-0 text-xs text-[#737b74]">
                {products.length} products
              </span>
            </div>

            {loading ? (
              <p className="py-10 text-center text-sm text-[#737b74]">
                Loading the store…
              </p>
            ) : products.length === 0 ? (
              <p className="py-10 text-center text-sm text-[#737b74]">
                No products available right now.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:gap-[18px]">
                {products.map((product, index) => {
                  const quantity = cart[product.id] ?? 0;
                  const art = productArt[index % productArt.length];

                  return (
                    <article
                      key={product.id}
                      className="overflow-hidden rounded-[15px] border border-[#e6e8df] bg-white transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(38,59,41,0.06)]"
                    >
                      <div
                        className={`relative grid min-h-[110px] place-items-center sm:min-h-[145px] ${art.background} ${art.foreground}`}
                      >
                        <span className="text-5xl font-normal leading-none sm:text-[63px]">
                          {art.symbol}
                        </span>

                        <span className="absolute right-3 bottom-3 text-[9px] font-extrabold tracking-[1.4px] opacity-80">
                          ITEM {String(index + 1).padStart(2, "0")}
                        </span>
                      </div>

                      <div className="p-3 sm:p-4">
                        <h3 className="text-[13px] font-bold sm:text-[15px]">
                          {product.name}
                        </h3>

                        <p className="my-2 mb-4 text-xs text-[#737b74]">
                          {product.availableUnits > 0
                            ? `${product.availableUnits} available`
                            : "Out of stock"}
                        </p>

                        <div className="flex flex-col items-start justify-between gap-3 min-[400px]:flex-row min-[400px]:items-center">
                          <strong className="text-sm tracking-tight sm:text-base">
                            {formatPrice(product.price)}
                          </strong>

                          {quantity === 0 ? (
                            <button
                              disabled={product.availableUnits === 0}
                              onClick={() => changeQuantity(product, 1)}
                              className="rounded-[9px] border border-[#cad9ce] bg-[#f4f8f3] px-3 py-2 text-xs font-bold text-[#235b43] transition-colors hover:bg-[#e5efe6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#235b43] disabled:cursor-not-allowed disabled:opacity-45"
                            >
                              + Add
                            </button>
                          ) : (
                            <div className="flex items-center gap-3 rounded-[9px] border border-[#e6e8df] p-1">
                              <button
                                aria-label={`Remove one ${product.name}`}
                                onClick={() => changeQuantity(product, -1)}
                                className="grid size-[27px] place-items-center rounded-md bg-[#eef3ed] text-lg text-[#235b43] hover:bg-[#dfe9dd]"
                              >
                                −
                              </button>

                              <span className="min-w-3 text-center text-[13px] font-bold">
                                {quantity}
                              </span>

                              <button
                                aria-label={`Add one ${product.name}`}
                                disabled={quantity >= product.availableUnits}
                                onClick={() => changeQuantity(product, 1)}
                                className="grid size-[27px] place-items-center rounded-md bg-[#eef3ed] text-lg text-[#235b43] hover:bg-[#dfe9dd] disabled:cursor-not-allowed disabled:opacity-45"
                              >
                                +
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* Basket */}
          <aside className="row-start-1 rounded-2xl border border-[#e6e8df] bg-white p-5 sm:p-[23px] lg:sticky lg:top-5 lg:row-auto">
            <div className="flex items-center justify-between border-b border-[#e6e8df] pb-5">
              <h2 className="text-[21px] font-bold tracking-tight">
                Your basket
              </h2>

              <span className="grid size-[27px] place-items-center rounded-full bg-[#eaf1e9] text-xs font-extrabold text-[#235b43]">
                {cartCount}
              </span>
            </div>

            {cartItems.length === 0 ? (
              <div className="flex min-h-[170px] flex-col items-center justify-center text-center">
                <span className="grid size-[37px] place-items-center rounded-full bg-[#f0f3ed] text-2xl text-[#235b43]">
                  +
                </span>
                <p className="mt-3 mb-1 text-[13px] font-bold">
                  Your basket is waiting.
                </p>
                <p className="text-[10px] leading-4 text-[#737b74]">
                  Add something from the store to get started.
                </p>
              </div>
            ) : (
              <div className="py-2">
                {cartItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start justify-between gap-3 py-3 text-xs"
                  >
                    <div className="grid gap-1.5">
                      <strong>{item.name}</strong>
                      <span className="text-[#737b74]">
                        {item.quantity} × {formatPrice(item.price)}
                      </span>
                    </div>

                    <strong className="shrink-0">
                      {formatPrice(item.price * item.quantity)}
                    </strong>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between border-t border-[#e6e8df] py-4 text-[13px]">
              <span>Subtotal</span>
              <strong className="text-xl tracking-tight">
                {formatPrice(total)}
              </strong>
            </div>

            <p className="mb-4 text-[11px] leading-5 text-[#737b74]">
              Stock is reserved for 2 minutes after your order is placed.
            </p>

            <button
              className="min-h-[47px] w-full rounded-[10px] bg-[#235b43] px-4 py-3 text-[13px] font-bold text-white transition-colors hover:bg-[#194631] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#235b43] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={cartItems.length === 0 || placingOrder || loading}
              onClick={() => void placeOrder()}
            >
              {placingOrder ? "Placing order…" : "Place order"}
              {!placingOrder && cartItems.length > 0 ? " →" : ""}
            </button>

            <p className="mt-3 text-center text-[10px] leading-4 text-[#737b74]">
              Prices shown in INR · Payment status verified by server
            </p>
          </aside>
        </div>
      )}

      {/* Footer */}
      <footer className="flex flex-col gap-2 border-t border-[#e6e8df] py-6 text-[11px] text-[#737b74] sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <span>Pickup Counter</span>
        <span>Simple shopping, ready for collection.</span>
      </footer>
    </main>
  );
}
