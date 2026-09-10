import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'phase5b-e2e@example.test';
const PASSWORD = 'Synthetic-E2E-Password-9!';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(EMAIL);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/app\/chat$/u);
}

async function clearConversationHistory(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const csrf = document.cookie
      .split(';')
      .map((item) => item.trim().split('='))
      .find(([name]) => name === 'mh_csrf')?.[1];
    if (!csrf) throw new Error('Synthetic E2E session has no CSRF cookie');
    const response = await fetch('http://127.0.0.1:3101/conversations', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'x-csrf-token': decodeURIComponent(csrf) },
    });
    if (!response.ok) throw new Error('Synthetic E2E history cleanup failed');
  });
}

test('landing, login, protected app shell, and logout', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('心理健康 AI 支持系统', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('在这里，慢慢说也可以。');
  await page.getByRole('link', { name: '登录' }).click();
  await page.getByLabel('邮箱').fill(EMAIL);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/app\/chat$/u);
  await expect(page.getByRole('heading', { name: '新对话' })).toBeVisible();
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=/u);
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  await expect(page.getByText('今天想从哪里说起？')).toHaveCount(0);
});

test('new chat keeps true synthetic streaming alive through route replacement and refresh', async ({
  page,
}) => {
  await login(page);
  await clearConversationHistory(page);
  await page.reload();

  const streamResponse = page.waitForResponse(
    (response) => response.url().endsWith('/ai/chat/stream') && response.status() === 200,
  );
  await page.getByLabel('输入消息').fill('这是合成的普通页面测试消息。');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page).toHaveURL(/\/app\/chat\/[0-9a-f-]+$/u);
  await streamResponse;
  await expect(page.getByText('这是合成的安全流式回复。')).toBeVisible();
  await expect(page.getByText('回复已完成。')).toBeVisible();

  const conversationUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(conversationUrl);
  await expect(page.getByText('这是合成的普通页面测试消息。')).toBeVisible();
  await expect(page.getByText('这是合成的安全流式回复。')).toBeVisible();
});

test('approved safety text remains visible when persistence later fails', async ({ page }) => {
  const conversationId = '52000000-0000-4000-8000-000000000001';
  const turnId = '52000000-0000-4000-8000-000000000002';
  await page.route('**/ai/chat/stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        `event: turn.started\ndata: {"mode":"persistent","turnId":"${turnId}","conversationId":"${conversationId}"}\n\n`,
        `event: message.segment\ndata: {"mode":"persistent","turnId":"${turnId}","sequence":1,"text":"这是合成的最低安全提示。"}\n\n`,
        `event: turn.failed\ndata: {"mode":"persistent","turnId":"${turnId}","code":"DATABASE_ERROR","message":"本轮未能保存"}\n\n`,
      ].join(''),
    });
  });
  await login(page);
  await page.getByLabel('输入消息').fill('合成持久化失败场景。');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByText('这是合成的最低安全提示。')).toBeVisible();
  await expect(page.getByText('内容已显示，但本轮未成功保存。')).toBeVisible();
  await expect(page.getByText('本轮未能保存')).toBeVisible();
});

test('history selection, save, delete, and safe route fallback', async ({ page }) => {
  await login(page);
  await clearConversationHistory(page);
  await page.reload();
  await page.getByLabel('输入消息').fill('合成保存删除流程。');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('回复已完成。')).toBeVisible();
  const conversationUrl = page.url();

  await page.getByRole('button', { name: '新对话' }).first().click();
  await expect(page).toHaveURL(/\/app\/chat$/u);
  await page.locator('.history-sidebar .history-link').first().click();
  await expect(page).toHaveURL(conversationUrl);
  await expect(page.getByText('合成保存删除流程。')).toBeVisible();

  await page.getByRole('button', { name: '保留对话' }).click();
  await expect(page.getByRole('button', { name: '已保留' })).toBeDisabled();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除这次聊天？' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
  await dialog.getByRole('button', { name: '删除聊天' }).click();
  await expect(page).toHaveURL(/\/app\/chat$/u);
  await expect(page.getByText('还没有保存的普通聊天。')).toBeVisible();
  await page.goto(conversationUrl);
  await expect(page).toHaveURL(/\/app\/chat$/u);
  await expect(page.getByText('该聊天已过期、删除或不可访问。')).toBeVisible();
});

test('AI disabled keeps history available and prevents streaming', async ({ page }) => {
  let streamRequests = 0;
  await page.route('**/capabilities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { aiChatEnabled: false } }),
    });
  });
  page.on('request', (request) => {
    if (request.url().endsWith('/ai/chat/stream')) streamRequests += 1;
  });
  await login(page);
  await expect(page.getByText('AI 对话当前未开放。聊天记录仍可查看、保留或删除。')).toBeVisible();
  await expect(page.getByLabel('输入消息')).toBeDisabled();
  await expect(page.getByRole('navigation', { name: '聊天记录' }).first()).toBeVisible();
  expect(streamRequests).toBe(0);
});

test('mobile history drawer supports keyboard close and focus restoration', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const trigger = page.getByRole('button', { name: '打开聊天记录' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: '聊天记录' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: '关闭聊天记录' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Incognito supports multiple turns without adding ordinary history', async ({ page }) => {
  await login(page);
  await clearConversationHistory(page);
  await page.reload();
  await page.getByRole('link', { name: '无痕聊天' }).first().click();
  await expect(page).toHaveURL(/\/app\/chat\/incognito$/u);
  await page.getByRole('button', { name: '开始无痕对话' }).click();

  const composer = page.getByLabel('输入无痕消息');
  await composer.fill('第一条合成无痕消息。');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('回复已完成。无痕普通聊天不会进入长期聊天记录。')).toBeVisible();
  await composer.fill('第二条合成无痕消息。');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('这是合成的安全流式回复。')).toHaveCount(2);
  await expect(page.getByText('还没有保存的普通聊天。')).toBeVisible();
  await expect(page).toHaveURL(/\/app\/chat\/incognito$/u);
});

test('refresh does not recover an Incognito browser context', async ({ page }) => {
  await login(page);
  await page.goto('/app/chat/incognito');
  await page.getByRole('button', { name: '开始无痕对话' }).click();
  await expect(page.getByLabel('输入无痕消息')).toBeVisible();
  await page.reload();

  await expect(page.getByRole('button', { name: '开始无痕对话' })).toBeVisible();
  await expect(page.getByLabel('输入无痕消息')).toHaveCount(0);
  await expect(page.getByText(/刷新页面、服务重启或超时后无法恢复/)).toBeVisible();
});

test('explicitly ending Incognito clears visible ordinary content', async ({ page }) => {
  await login(page);
  await page.goto('/app/chat/incognito');
  await page.getByRole('button', { name: '开始无痕对话' }).click();
  await page.getByLabel('输入无痕消息').fill('结束后应清除的合成正文。');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('结束后应清除的合成正文。')).toBeVisible();

  await page.getByRole('button', { name: '结束无痕对话' }).click();
  await expect(page.getByText('无痕对话已结束，当前页面中的普通聊天内容已清除。')).toBeVisible();
  await expect(page.getByText('结束后应清除的合成正文。')).toHaveCount(0);
});

test('logout clears Incognito browser memory before another session', async ({ page }) => {
  await login(page);
  await page.goto('/app/chat/incognito');
  await page.getByRole('button', { name: '开始无痕对话' }).click();
  await page.getByLabel('输入无痕消息').fill('退出后不能保留的合成正文。');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('退出后不能保留的合成正文。')).toBeVisible();

  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=/u);
  await expect(page.getByText('退出后不能保留的合成正文。')).toHaveCount(0);
  await page.getByLabel('邮箱').fill(EMAIL);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('退出后不能保留的合成正文。')).toHaveCount(0);
});
