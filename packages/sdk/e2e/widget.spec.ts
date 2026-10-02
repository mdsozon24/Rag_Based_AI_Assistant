/**
 * The embeddable widget and the ES module SDK in a real browser against the fake engine:
 * start → greeting → speech and typed turns → mute → end; blocked microphone → text chat;
 * disallowed origin; keyboard and phone layout; reconnect after a dropped connection.
 */
import { expect, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:4311';

async function openWidget(page: Page, origin = '') {
  await page.goto(`${origin}/widget`);
  await page.getByRole('button', { name: 'Ask Acme Clinic' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask Acme Clinic' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('voice call: greeting, speech, typed message, mute and end', async ({ page }) => {
  const dialog = await openWidget(page);
  const log = dialog.getByRole('log');
  // The launcher is hidden while the panel is open (so it leaves the accessibility tree)
  await expect(page.locator('button.launcher')).toHaveAttribute('aria-expanded', 'true');

  await dialog.getByRole('button', { name: 'Start voice call' }).click();
  await expect(log).toContainText('Hello! How can I help?');
  await expect(dialog.getByRole('button', { name: 'End call' })).toBeFocused();

  // The fake microphone "speaks"; the fake STT recognizes it and the fake LLM answers
  await expect(log).toContainText('You said: Hello from the microphone', { timeout: 20_000 });

  // Muted: the fake microphone can no longer interrupt, so the typed turn is deterministic
  await dialog.getByRole('button', { name: 'Mute' }).click();
  await expect(dialog.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');

  await dialog.getByRole('textbox', { name: 'Type a message' }).fill('What time do you open?');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(log).toContainText('You said: What time do you open?');

  await dialog.getByRole('button', { name: 'End call' }).click();
  await expect(log).toContainText('Call ended');
  await expect(dialog.getByRole('status')).toHaveText('Call ended');
  await expect(dialog.getByRole('button', { name: 'Start voice call' })).toBeVisible();
});

test('blocked microphone: clear error, then the typed chat fallback', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  const dialog = await openWidget(page);
  await dialog.getByRole('button', { name: 'Start voice call' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Microphone access is blocked');

  await dialog.getByRole('button', { name: 'Type instead' }).click();
  await expect(dialog.getByRole('log')).toContainText('Hello! How can I help?');
  await expect(dialog.getByRole('alert')).toBeEmpty();
  await dialog.getByRole('textbox', { name: 'Type a message' }).fill('Do you take walk-ins?');
  await dialog.getByRole('textbox', { name: 'Type a message' }).press('Enter');
  await expect(dialog.getByRole('log')).toContainText('You said: Do you take walk-ins?');
  // No microphone in chat mode, so no mute button
  await expect(dialog.getByRole('button', { name: 'Mute' })).toBeHidden();
  await dialog.getByRole('button', { name: 'End call' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Call ended');
});

test('a website that is not in the key’s allowed origins is refused', async ({ page }) => {
  const dialog = await openWidget(page, 'http://localhost:4310');
  await dialog.getByRole('button', { name: 'Start voice call' }).click();
  await expect(dialog.getByRole('alert')).toContainText('is not in the public key');
  await expect(dialog.getByRole('button', { name: 'Start voice call' })).toBeVisible();
});

test('keyboard only, on a phone-sized screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto('/widget');
  const launcher = page.getByRole('button', { name: 'Ask Acme Clinic' });
  await launcher.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Ask Acme Clinic' });
  await expect(dialog.getByRole('button', { name: 'Start voice call' })).toBeFocused();
  const box = await dialog.boundingBox();
  expect(box?.width).toBe(375);
  // Touch targets are at least 44 px
  expect((await dialog.getByRole('button', { name: 'Start voice call' }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();
});

test('reconnects after the connection drops and keeps the same call', async ({ page, request }) => {
  const dialog = await openWidget(page);
  const log = dialog.getByRole('log');
  await dialog.getByRole('button', { name: 'Type instead' }).click();
  await expect(log).toContainText('Hello! How can I help?');

  // Reconnecting can take only a few hundred ms: record the client's status changes in the page
  await page.evaluate(() => {
    const w = window as unknown as { statuses: string[]; OctoVoice: { widgets: { client: { on(e: string, l: (s: string) => void): void } }[] } };
    w.statuses = [];
    w.OctoVoice.widgets[0].client.on('status', (s) => w.statuses.push(s));
  });
  const dropped = await request.post(`${API}/test/drop-sockets`);
  expect((await dropped.json()).dropped).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { statuses: string[] }).statuses)).toEqual(['reconnecting', 'active']);
  await expect(dialog.getByRole('textbox', { name: 'Type a message' })).toBeEnabled();

  await dialog.getByRole('textbox', { name: 'Type a message' }).fill('Are you still there?');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(log).toContainText('You said: Are you still there?');
  // Same call: the greeting was not played again
  await expect(log.getByText('Hello! How can I help?')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'End call' }).click();
});

test('custom UI with the ES module SDK', async ({ page }) => {
  await page.goto('/custom');
  await page.getByRole('button', { name: 'Start call' }).click();
  await expect(page.getByRole('status')).toHaveText('active');
  await expect(page.getByRole('log')).toContainText('Agent: Hello! How can I help?');
  await page.getByRole('button', { name: 'End call' }).click();
  await expect(page.getByRole('status')).toHaveText('ended (client-ended)');
});
