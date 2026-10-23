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
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Load products initially and whenever an order action requires a refresh.
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

  // Initial product loading.
  useEffect(() => {
    const controller = new AbortController();

    async function initializeStore() {
      try {
        const data = await fetchProducts(controller.signal);

        if (controller.signal.aborted) return;

        setProducts(data);
        setError("");
      } catch {
        if (controller.signal.aborted) return;

        setError(
          "Unable to connect to the store. Check that the backend is running.",
        );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void initializeStore();

    return () => {
      controller.abort();
    };
  }, []);

  // Update the clock through a timer while an order is pending.
  useEffect(() => {
    if (!order || order.status !== "PENDING") {
      return;
    }

    const updateClock = () => {
      setCurrentTime(Date.now());
      setClockTick((tick) => tick + 1);
    };

    const timer = window.setInterval(updateClock, 1000);

    // Wait for the timer callback to update the clock.
    // This avoids synchronously setting state inside the effect.
    return () => {
      window.clearInterval(timer);
    };
  }, [order?.id, order?.status]);

  // Poll the backend for payment/status updates.
  useEffect(() => {
    if (!order || order.status !== "PENDING") {
      return;
    }

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

  const total = cartItems.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );

  // Derive the countdown without maintaining a separate secondsLeft state.
  const secondsLeft =
    order?.status === "PENDING" && currentTime !== null
      ? Math.max(
          0,
          Math.ceil((new Date(order.expiresAt).getTime() - currentTime) / 1000),
        )
      : order?.status === "PENDING"
        ? Math.max(
            0,
            Math.ceil(
              (new Date(order.expiresAt).getTime() -
                new Date(order.expiresAt).getTime()) /
                1000,
            ),
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
      setCurrentTime(null);
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
    setCurrentTime(null);
    setNotice("");
    setError("");

    await loadProducts();
  }

  return (
    <main className="store-shell">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">P</span>
          <span>Pickup Counter</span>
        </a>

        <span className="topbar-label">QUICK PICKUP STORE</span>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">ORDER ONLINE · PICK UP IN STORE</p>

          <h1>
            Good things.
            <br />
            Ready when you are.
          </h1>

          <p className="hero-copy">
            Choose your favourites, reserve your items, and collect them when
            your payment is confirmed.
          </p>
        </div>

        <div className="hero-stamp">
          <span className="stamp-icon">✳</span>
          <span>Quick order</span>
          <span>Easy pickup</span>
        </div>
      </section>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
        </div>
      )}

      {order ? (
        <section className="order-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR ORDER</p>
              <h2>Order summary</h2>
            </div>

            <span
              className={`status-pill status-${order.status.toLowerCase()}`}
            >
              {order.status.replaceAll("_", " ")}
            </span>
          </div>

          <p className="order-id">
            Reference: <strong>{order.id}</strong>
          </p>

          <div className="order-items">
            {order.items.map((item) => {
              const product = products.find((p) => p.id === item.productId);

              return (
                <div className="order-line" key={item.id}>
                  <span>
                    {product?.name ?? "Store item"} × {item.quantity}
                  </span>

                  <strong>{formatPrice(item.price * item.quantity)}</strong>
                </div>
              );
            })}
          </div>

          <div className="order-total">
            <span>Total</span>
            <strong>{formatPrice(order.total)}</strong>
          </div>

          {order.status === "PENDING" && (
            <div className="countdown-card">
              <div>
                <span className="countdown-label">RESERVATION TIME LEFT</span>

                <strong className="countdown">
                  {String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:
                  {String(secondsLeft % 60).padStart(2, "0")}
                </strong>
              </div>

              <p>
                Your items are temporarily reserved. This page checks payment
                status automatically.
              </p>
            </div>
          )}

          {order.status === "PAID" && (
            <p className="success-message">
              ✓ Payment confirmed. Show your order reference when collecting.
            </p>
          )}

          {order.status === "NEEDS_REVIEW" && (
            <p className="review-message">
              Payment requires manual review. Please contact the store with your
              order reference.
            </p>
          )}

          {order.status === "EXPIRED" && (
            <p className="review-message">
              Your reservation has expired and the held stock has been released.
            </p>
          )}

          {order.status === "PICKED_UP" && (
            <p className="success-message">✓ This order has been picked up.</p>
          )}

          <button
            className="primary-button full-button"
            onClick={startNewOrder}
          >
            Back to store
          </button>
        </section>
      ) : (
        <div className="shop-layout">
          <section className="catalog">
            <div className="section-heading">
              <div>
                <p className="eyebrow">THE EVERYDAY ESSENTIALS</p>
                <h2>Shop the counter</h2>
              </div>

              <span className="item-count">{products.length} products</span>
            </div>

            {loading ? (
              <p className="empty-state">Loading the store…</p>
            ) : products.length === 0 ? (
              <p className="empty-state">No products available right now.</p>
            ) : (
              <div className="product-grid">
                {products.map((product, index) => {
                  const quantity = cart[product.id] ?? 0;

                  return (
                    <article className="product-card" key={product.id}>
                      <div className={`product-art art-${index % 5}`}>
                        <span className="product-art-symbol">
                          {["◉", "▰", "▤", "◈", "◒"][index % 5]}
                        </span>

                        <span className="product-number">
                          ITEM {String(index + 1).padStart(2, "0")}
                        </span>
                      </div>

                      <div className="product-details">
                        <h3>{product.name}</h3>

                        <p className="stock-label">
                          {product.availableUnits > 0
                            ? `${product.availableUnits} available`
                            : "Out of stock"}
                        </p>

                        <div className="product-buy-row">
                          <strong className="product-price">
                            {formatPrice(product.price)}
                          </strong>

                          {quantity === 0 ? (
                            <button
                              className="add-button"
                              disabled={product.availableUnits === 0}
                              onClick={() => changeQuantity(product, 1)}
                            >
                              + Add
                            </button>
                          ) : (
                            <div className="quantity-control">
                              <button
                                aria-label={`Remove one ${product.name}`}
                                onClick={() => changeQuantity(product, -1)}
                              >
                                −
                              </button>

                              <span>{quantity}</span>

                              <button
                                aria-label={`Add one ${product.name}`}
                                disabled={quantity >= product.availableUnits}
                                onClick={() => changeQuantity(product, 1)}
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

          <aside className="cart-panel">
            <div className="cart-title-row">
              <h2>Your basket</h2>

              <span className="cart-count">
                {cartItems.reduce((sum, item) => sum + item.quantity, 0)}
              </span>
            </div>

            {cartItems.length === 0 ? (
              <div className="cart-empty">
                <span>＋</span>
                <p>Your basket is waiting.</p>
                <small>Add something from the store to get started.</small>
              </div>
            ) : (
              <div className="cart-lines">
                {cartItems.map((item) => (
                  <div className="cart-line" key={item.id}>
                    <div>
                      <strong>{item.name}</strong>

                      <small>
                        {item.quantity} × {formatPrice(item.price)}
                      </small>
                    </div>

                    <strong>{formatPrice(item.price * item.quantity)}</strong>
                  </div>
                ))}
              </div>
            )}

            <div className="cart-total">
              <span>Subtotal</span>
              <strong>{formatPrice(total)}</strong>
            </div>

            <p className="cart-note">
              Stock is reserved for 2 minutes after your order is placed.
            </p>

            <button
              className="primary-button full-button"
              disabled={cartItems.length === 0 || placingOrder || loading}
              onClick={() => void placeOrder()}
            >
              {placingOrder ? "Placing order…" : "Place order"}
              {!placingOrder && cartItems.length > 0 ? " →" : ""}
            </button>

            <p className="secure-note">
              Prices shown in INR · Payment status verified by server
            </p>
          </aside>
        </div>
      )}

      <footer className="footer">
        <span>Pickup Counter</span>
        <span>Simple shopping, ready for collection.</span>
      </footer>
    </main>
  );
}
