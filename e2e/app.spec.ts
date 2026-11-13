import { expect, test as base } from '@playwright/test';

// Every test gets a fresh browser context. Runtime and local HTTP errors must
// fail even when the page's visible-content assertions happen to pass.
const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const errors: string[] = [];
    const origin = new URL(baseURL!).origin;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('response', response => {
      if (new URL(response.url()).origin === origin && response.status() >= 400) {
        errors.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    });
    page.on('requestfailed', request => {
      if (new URL(request.url()).origin === origin) {
        errors.push(`Request failed: ${request.url()} (${request.failure()?.errorText})`);
      }
    });
    await use(page);
    expect(errors, 'The production app must have no runtime or asset errors').toEqual([]);
  }
});

test.beforeEach(async ({ page }) => {
  const response = await page.goto('/app/');
  expect(response?.ok(), 'The production entry page must load').toBe(true);
  await expect(page.locator('page-about')).toBeVisible();
});

test('renders the biography and a loaded profile photo', async ({ page }) => {
  await expect(page.locator('.about-info')).toBeVisible();
  await expect(page.locator('.about-info')).toContainText(/software engineer/i);
  const photo = page.getByAltText('Photo of Celilsemi Sam Erkiner');
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) =>
    image.complete && image.naturalWidth > 0
  )).toBe(true);
});

test('supports profile navigation and mobile menus', async ({ page, isMobile }) => {
  const profile = page.locator('ion-menu[side="start"]');
  if (isMobile) {
    for (const [side, label] of [['start', 'Full Name'], ['end', 'Professional']]) {
      const menu = page.locator(`ion-menu[side="${side}"]`);
      await page.locator(`ion-menu-button[menu="${side}"]`).click();
      await expect(menu).toHaveClass(/show-menu/);
      // Ionic applies show-menu before its opening animation finishes. Wait
      // for the public state before clicking the backdrop, which is ignored
      // while that animation is running.
      await expect.poll(() => menu.evaluate(element =>
        (element as HTMLElement & { isOpen(): Promise<boolean> }).isOpen()
      )).toBe(true);
      await expect(menu.getByText(label, { exact: true })).toBeVisible();
      const viewport = page.viewportSize()!;
      // The links menu is RTL, so its physical side can differ from "end".
      const panel = await menu.locator('[part="container"]').boundingBox();
      expect(panel).not.toBeNull();
      await page.mouse.click(panel!.x < 1 ? viewport.width - 8 : 8, viewport.height / 2);
      await expect(menu).not.toHaveClass(/show-menu/);
    }
    await page.locator('ion-menu-button[menu="start"]').click();
  }
  await expect(profile.getByText('Sydney, Australia', { exact: true })).toBeVisible();
  await profile.getByText('Celilsemi Sam Erkiner', { exact: true }).click();
  await expect(page.locator('.about-info')).toBeVisible();
  await expect(page).toHaveURL(/\/app\/(?:#\/)?$/);
});

test('temporary negative control for the required merge check', () => {
  expect(true, 'Intentional failure: verify GitHub blocks merging').toBe(false);
});
