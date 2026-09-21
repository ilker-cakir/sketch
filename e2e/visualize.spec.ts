import { test, expect, type Page } from '@playwright/test';

/**
 * `createBrowserReceiver` is just a `window` `message` listener, so the whole
 * live-inspect route can be driven from the test without a real inspector.
 */

const MACHINE_CONFIG = {
  id: 'checkout',
  initial: 'cart',
  states: {
    cart: {
      description: 'Items awaiting checkout',
      entry: ['trackCartView'],
      on: { CHECKOUT: { target: 'payment' }, REFRESH: {} },
    },
    payment: {
      initial: 'details',
      on: { CANCEL: { target: 'cart' } },
      states: {
        details: { on: { SUBMIT: { target: 'processing' } } },
        processing: {
          invoke: { src: 'chargeCard' },
          // A literal delay, so the canvas can derive timer progress from it.
          after: { 4000: { target: 'details' } },
          on: { OK: { target: '#checkout.done' }, FAIL: { target: 'details' } },
        },
      },
    },
    done: { type: 'final' },
  },
};

const SESSION_ID = 'session-under-test';

async function connectActor(page: Page): Promise<void> {
  await page.evaluate(
    ([sessionId, definition]) => {
      window.postMessage(
        {
          type: '@xstate.actor',
          _version: '0.0.1',
          rootId: sessionId,
          sessionId,
          name: 'checkout',
          definition,
          snapshot: { status: 'active', value: 'cart', context: {} },
          createdAt: String(Date.now()),
        },
        '*',
      );
    },
    [SESSION_ID, JSON.stringify(MACHINE_CONFIG)] as const,
  );
}

async function sendSnapshot(page: Page, value: unknown): Promise<void> {
  await page.evaluate(
    ([sessionId, snapshotValue]) => {
      window.postMessage(
        {
          type: '@xstate.snapshot',
          _version: '0.0.1',
          rootId: sessionId,
          sessionId,
          snapshot: { status: 'active', value: snapshotValue, context: {} },
          event: { type: 'CHECKOUT' },
          createdAt: String(Date.now()),
        },
        '*',
      );
    },
    [SESSION_ID, value] as const,
  );
}

interface CanvasProbe {
  /** Fraction of sampled pixels differing from the top-left (background) pixel. */
  painted: number;
  /** Checksum over sampled channels; changes when colours change, not just coverage. */
  signature: number;
}

async function probeCanvas(page: Page): Promise<CanvasProbe> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="graph-canvas"]',
    );
    if (!canvas) return { painted: 0, signature: 0 };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { painted: 0, signature: 0 };

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const [br, bg, bb] = [data[0], data[1], data[2]];
    const stride = 4 * 40; // sample every 40th pixel — enough signal, far less work
    let differing = 0;
    let signature = 0;
    let sampled = 0;
    for (let i = 0; i < data.length; i += stride) {
      if (data[i] !== br || data[i + 1] !== bg || data[i + 2] !== bb) differing++;
      signature = (signature + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7) % 2147483647;
      sampled++;
    }
    return { painted: sampled === 0 ? 0 : differing / sampled, signature };
  });
}

/** Waits for the first rAF paint, then returns the probe. Drawing is async. */
async function waitForPaint(page: Page): Promise<CanvasProbe> {
  await expect
    .poll(async () => (await probeCanvas(page)).painted, { timeout: 10_000 })
    .toBeGreaterThan(0.01);
  return probeCanvas(page);
}

test.describe('/visualize', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/visualize');
    await expect(page.getByText('Waiting for inspection')).toBeVisible();
    await connectActor(page);
  });

  test('paints the graph on a full-bleed canvas', async ({ page }) => {
    const canvas = page.getByTestId('graph-canvas');
    await expect(canvas).toBeVisible();
    await expect(page.getByTestId('graph-error')).toHaveCount(0);

    const box = await canvas.boundingBox();
    expect(box!.width).toBeGreaterThan(200);
    expect(box!.height).toBeGreaterThan(200);

    // Something was actually drawn, not just an empty canvas element.
    await waitForPaint(page);
  });

  test('repaints when a snapshot changes the active state', async ({ page }) => {
    const before = await waitForPaint(page);

    await sendSnapshot(page, { payment: 'processing' });

    // Highlighting a different subtree repaints the canvas differently.
    await expect
      .poll(async () => (await probeCanvas(page)).signature, { timeout: 5000 })
      .not.toBe(before.signature);
  });

  test('animates an after-timer with no further snapshots', async ({ page }) => {
    await waitForPaint(page);

    // Timer bars only draw at detail zoom, so get above that threshold first
    // and let the zoom tween settle.
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Zoom in' }).click();
    }
    await page.waitForTimeout(900);

    // Entering `processing` starts its 4000ms timer.
    await sendSnapshot(page, { payment: 'processing' });
    await page.waitForTimeout(400);

    const first = (await probeCanvas(page)).signature;
    // Nothing else is sent: any further change must come from the timer bar
    // sweeping, i.e. the render loop is genuinely running.
    await page.waitForTimeout(900);
    const second = (await probeCanvas(page)).signature;
    expect(second).not.toBe(first);
  });

  test('settles to a stable frame once nothing is animating', async ({ page }) => {
    await waitForPaint(page);
    // No timers are running in `cart`, so repeated probes must match.
    const first = (await probeCanvas(page)).signature;
    await page.waitForTimeout(700);
    expect((await probeCanvas(page)).signature).toBe(first);
  });

  test('selects a node on click', async ({ page }) => {
    const canvas = page.getByTestId('graph-canvas');
    await waitForPaint(page);

    const box = (await canvas.boundingBox())!;
    // The graph is fitted and centred, so the middle lands inside the machine.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.getByTestId('graph-selection')).toBeVisible();
    await expect(page.getByTestId('graph-selection')).toContainText('checkout');
  });

  test('exposes zoom and fit controls', async ({ page }) => {
    await waitForPaint(page);

    await expect(page.getByRole('button', { name: 'Fit to view' })).toBeVisible();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Fit to view' }).click();

    await waitForPaint(page);
  });
});

test.describe('switching between /inspect and /visualize', () => {
  test('carries the live stream across both routes', async ({ page }) => {
    await page.goto('/inspect');
    await expect(page.getByText('Waiting for inspection')).toBeVisible();
    await connectActor(page);

    // /inspect keeps the DOM renderer and its own sidebar.
    await expect(page.getByTestId('machine-root')).toBeVisible();
    await expect(page.getByTestId('graph-canvas')).toHaveCount(0);

    await page.getByTestId('nav-visualize').click();
    await expect(page).toHaveURL(/\/visualize$/);
    // The actor survives the navigation: no reconnection, no empty state.
    await expect(page.getByText('Waiting for inspection')).toHaveCount(0);
    await waitForPaint(page);

    await page.getByTestId('nav-inspect').click();
    await expect(page).toHaveURL(/\/inspect$/);
    await expect(page.getByTestId('machine-root')).toBeVisible();
    await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
  });

  test('keeps snapshots flowing to whichever route is open', async ({ page }) => {
    await page.goto('/inspect');
    await expect(page.getByText('Waiting for inspection')).toBeVisible();
    await connectActor(page);
    await expect(page.getByTestId('machine-root')).toBeVisible();

    // A snapshot that arrives while /inspect is showing must still be the one
    // /visualize renders after navigation.
    await sendSnapshot(page, { payment: 'processing' });
    await page.getByTestId('nav-visualize').click();
    await waitForPaint(page);

    await expect(page.getByTestId('graph-error')).toHaveCount(0);
  });

  test('marks the current route in the nav', async ({ page }) => {
    await page.goto('/visualize');
    await expect(page.getByTestId('nav-visualize')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('nav-inspect')).not.toHaveAttribute('aria-current', 'page');
  });
});
