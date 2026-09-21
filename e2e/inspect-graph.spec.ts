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

test.describe('Inspect graph visualization', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/inspect');
    await expect(page.getByText('Waiting for inspection')).toBeVisible();
    await connectActor(page);
    await expect(page.getByTestId('tab-visualization')).toBeVisible();
  });

  test('defaults to the DOM renderer and keeps the tab unpressed', async ({ page }) => {
    await expect(page.getByTestId('machine-root')).toBeVisible();
    await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
    await expect(page.getByTestId('tab-visualization')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('swaps the main pane to the canvas and paints the graph', async ({ page }) => {
    await page.getByTestId('tab-visualization').click();

    const canvas = page.getByTestId('graph-canvas');
    await expect(canvas).toBeVisible();
    await expect(page.getByTestId('machine-root')).toHaveCount(0);
    await expect(page.getByTestId('graph-loading')).toHaveCount(0);
    await expect(page.getByTestId('graph-error')).toHaveCount(0);

    const box = await canvas.boundingBox();
    expect(box!.width).toBeGreaterThan(200);
    expect(box!.height).toBeGreaterThan(200);

    // Something was actually drawn, not just an empty canvas element.
    await waitForPaint(page);
  });

  test('keeps the sidebar panel selection independent of the tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Actors' }).click();
    await page.getByTestId('tab-visualization').click();

    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    // The Actors panel is still the one showing in the sidebar.
    await expect(page.getByText(SESSION_ID).first()).toBeVisible();
  });

  test('toggles back to the DOM renderer', async ({ page }) => {
    await page.getByTestId('tab-visualization').click();
    await expect(page.getByTestId('graph-canvas')).toBeVisible();

    await page.getByTestId('tab-visualization').click();
    await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
    await expect(page.getByTestId('machine-root')).toBeVisible();
  });

  test('repaints when a snapshot changes the active state', async ({ page }) => {
    await page.getByTestId('tab-visualization').click();
    await expect(page.getByTestId('graph-canvas')).toBeVisible();

    const before = await waitForPaint(page);

    await sendSnapshot(page, { payment: 'processing' });

    // Highlighting a different subtree repaints the canvas differently.
    await expect
      .poll(async () => (await probeCanvas(page)).signature, { timeout: 5000 })
      .not.toBe(before.signature);
  });

  test('selects a node on click', async ({ page }) => {
    await page.getByTestId('tab-visualization').click();
    const canvas = page.getByTestId('graph-canvas');
    await expect(canvas).toBeVisible();

    await waitForPaint(page);

    const box = (await canvas.boundingBox())!;
    // The graph is fitted and centred, so the middle lands inside the machine.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.getByTestId('graph-selection')).toBeVisible();
    await expect(page.getByTestId('graph-selection')).toContainText('checkout');
  });

  test('exposes zoom and fit controls', async ({ page }) => {
    await page.getByTestId('tab-visualization').click();
    await expect(page.getByTestId('graph-canvas')).toBeVisible();

    await expect(page.getByRole('button', { name: 'Fit to view' })).toBeVisible();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Fit to view' }).click();

    await waitForPaint(page);
  });
});
