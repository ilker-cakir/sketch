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
    // Every 4th pixel. Sparser sampling misses small moving details — an
    // `after` timer bar advances only a few pixels a second — and turns this
    // probe into a coin toss.
    const stride = 4 * 4;
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

/**
 * Selects a state by walking the details panel down from the machine root.
 *
 * Clicking the canvas needs to know where a node ended up; walking the panel
 * does not, so this stays correct when the layout changes. Revealing a state
 * also centres it and zooms to at least detail level, which is what makes
 * anything drawn only at that zoom — an `after` timer bar — reliably visible.
 */
async function selectPath(page: Page, keys: string[]): Promise<void> {
  const canvas = page.getByTestId('graph-canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('graph-selection')).toBeVisible();

  const parentLink = page.getByTestId('graph-selection-parent');
  for (let i = 0; i < 6 && (await parentLink.count()) > 0; i++) {
    await parentLink.click();
  }

  for (const key of keys) {
    await page
      .getByTestId('graph-substate')
      .filter({ hasText: key })
      .first()
      .click();
  }
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

    // Timer bars only draw at detail zoom and only where they are on screen.
    // Revealing the state guarantees both, so this no longer depends on where
    // the layout happened to put it.
    await selectPath(page, ['payment', 'processing']);
    await expect(page.getByTestId('graph-selection-id')).toHaveText(
      'checkout.payment.processing',
    );
    await page.waitForTimeout(400);

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

  test('details a selected state: sub-states, and what leads in and out', async ({
    page,
  }) => {
    const canvas = page.getByTestId('graph-canvas');
    await waitForPaint(page);

    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId('graph-selection')).toBeVisible();

    // Walk up to the root, whichever node the click landed on. This also
    // exercises the parent link, which is the only way back up the tree.
    const parentLink = page.getByTestId('graph-selection-parent');
    for (let i = 0; i < 5 && (await parentLink.count()) > 0; i++) {
      await parentLink.click();
    }
    await expect(page.getByTestId('graph-selection-id')).toHaveText('checkout');
    await expect(parentLink).toHaveCount(0);

    // The root's children, in machine order.
    const substates = page.getByTestId('graph-substate');
    await expect(substates).toHaveCount(3);
    await expect(substates.nth(0)).toContainText('cart');
    await expect(substates.nth(1)).toContainText('payment');
    await expect(substates.nth(2)).toContainText('done');

    // Descending selects the child and reframes the canvas on it.
    await substates.nth(0).click();
    await expect(page.getByTestId('graph-selection-id')).toHaveText('checkout.cart');
    await expect(page.getByTestId('graph-selection')).toContainText(
      'Items awaiting checkout',
    );

    // cart --CHECKOUT--> payment, and payment --CANCEL--> cart comes back.
    const out = page.getByTestId('graph-transition-out');
    await expect(out.filter({ hasText: 'CHECKOUT' })).toHaveText('CHECKOUT\u2192payment');
    const incoming = page.getByTestId('graph-transition-in');
    await expect(incoming.filter({ hasText: 'CANCEL' })).toHaveText('CANCEL\u2190payment');

    // Following an incoming transition jumps to the state it comes from.
    await incoming.filter({ hasText: 'CANCEL' }).click();
    await expect(page.getByTestId('graph-selection-id')).toHaveText('checkout.payment');
  });

  test('closes the details panel', async ({ page }) => {
    const canvas = page.getByTestId('graph-canvas');
    await waitForPaint(page);

    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId('graph-selection')).toBeVisible();

    await page.getByRole('button', { name: 'Close details' }).click();
    await expect(page.getByTestId('graph-selection')).toHaveCount(0);
  });

  test('follows the active state, and lets go when the user takes the camera', async ({
    page,
  }) => {
    await waitForPaint(page);

    const follow = page.getByTestId('graph-follow');
    // On by default: watching where the machine goes is the point of the view.
    await expect(follow).toHaveAttribute('aria-pressed', 'true');

    // Panning hands the camera back, so the view stops moving under you.
    const canvas = page.getByTestId('graph-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 90);
    await page.mouse.up();
    await expect(follow).toHaveAttribute('aria-pressed', 'false');

    // And it can be turned back on.
    await follow.click();
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
  });

  /** Drags the graph right out of the viewport, which also releases follow. */
  async function panAway(page: Page): Promise<void> {
    const box = (await page.getByTestId('graph-canvas').boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 60, y);
    await page.mouse.down();
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(box.x + 60 + (i + 1) * 400, y + (i + 1) * 300);
    }
    await page.mouse.up();
    await expect
      .poll(async () => (await probeCanvas(page)).painted, { timeout: 5000 })
      .toBeLessThan(0.01);
  }

  test('brings the camera back to a state that becomes active offscreen', async ({
    page,
  }) => {
    await waitForPaint(page);
    await panAway(page);
    await page.getByTestId('graph-follow').click();

    // Entering a state pulls the view back to it.
    await sendSnapshot(page, { payment: 'processing' });
    await expect
      .poll(async () => (await probeCanvas(page)).painted, { timeout: 5000 })
      .toBeGreaterThan(0.01);
  });

  test('leaves the camera alone once following is released', async ({ page }) => {
    await waitForPaint(page);
    await panAway(page);

    // Panning released follow, so the machine must not yank the view back.
    await sendSnapshot(page, { payment: 'processing' });
    await page.waitForTimeout(1200);
    expect((await probeCanvas(page)).painted).toBeLessThan(0.01);
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
