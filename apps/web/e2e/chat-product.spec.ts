import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'phase5b-e2e@example.test';
const PASSWORD = 'Synthetic-E2E-Password-9!';
const moodScreenshotDirectory = fileURLToPath(
  new URL('../../../docs/reviews/phase-5d-mood-profile-web/', import.meta.url),
);
const knowledgeScreenshotDirectory = fileURLToPath(
  new URL('../../../docs/reviews/phase-5e-knowledge-base-web/', import.meta.url),
);

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(EMAIL);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
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

async function clearMoodHistory(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const csrf = document.cookie
      .split(';')
      .map((item) => item.trim().split('='))
      .find(([name]) => name === 'mh_csrf')?.[1];
    if (!csrf) throw new Error('Synthetic E2E session has no CSRF cookie');
    const response = await fetch('http://127.0.0.1:3101/mood-entries', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'x-csrf-token': decodeURIComponent(csrf) },
    });
    if (!response.ok) throw new Error('Synthetic E2E Mood cleanup failed');
  });
}

test('landing, login, protected app shell, and logout', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('心理健康 AI 支持系统', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('在这里，慢慢说也可以。');
  await page.getByRole('link', { name: '登录' }).click();
  await page.getByLabel('邮箱').fill(EMAIL);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/app\/chat$/u);
  await expect(page.getByRole('heading', { name: '新对话' })).toBeVisible();
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=/u);
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.getByText('你已退出登录。')).toBeVisible();
  await expect(page.getByText(/登录状态已失效/u)).toHaveCount(0);
  await expect(page.getByText('今天想从哪里说起？')).toHaveCount(0);
});

test('registration and history controls remain readable and reachable at supported widths', async ({
  page,
}) => {
  await page.goto('/register');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const terms = page.getByRole('link', { name: '服务条款', exact: true });
    await expect(terms).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    // An inline link may wrap naturally, but must not collapse to one glyph per line.
    expect(
      await terms.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeGreaterThan(24);
  }
  await login(page);
  await page.getByLabel('输入消息').fill('合成窄屏布局回归。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('回复已完成。')).toBeVisible();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const remove = page.getByRole('button', { name: '删除', exact: true });
    await expect(remove).toBeVisible();
    await expect(page.getByRole('button', { name: '保留对话' })).toBeVisible();
    await remove.click();
    const dialog = page.getByRole('dialog', { name: '删除这次聊天？' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
  }
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
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('退出后不能保留的合成正文。')).toHaveCount(0);
});

test('Privacy opens a versioned synthetic document and exact-replays an unknown withdrawal', async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto('/app/privacy');
  await expect(page.getByRole('heading', { name: '管理同意与了解数据边界' })).toBeVisible();

  const documentPagePromise = context.waitForEvent('page');
  await page
    .getByRole('link', { name: /查看当前可接受文档/u })
    .first()
    .click();
  const documentPage = await documentPagePromise;
  await expect(documentPage.getByRole('heading', { name: '合成测试服务条款' })).toBeVisible();
  await expect(documentPage.getByText(/仅限 Development\/Test/u)).toBeVisible();
  expect(documentPage.url()).toContain(
    '/consent-documents/synthetic.terms-of-service/1.1/test-revision-2.html',
  );
  await documentPage.close();

  const submittedBodies: unknown[] = [];
  let hideFirstCommittedResponse = true;
  await page.route('**/consents', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    submittedBodies.push(route.request().postDataJSON());
    if (hideFirstCommittedResponse) {
      hideFirstCommittedResponse = false;
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: 'CONSENT_RESULT_UNKNOWN', message: '无法确认同意操作结果' },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: '撤回服务条款版本 1.1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认撤回' }).click();
  await expect(page.getByText(/服务器是否已记录本次操作暂时无法确认/u)).toBeVisible();
  await page.getByRole('button', { name: '核对同一操作结果' }).click();
  await expect(page.getByText('撤回服务条款版本 1.1已记录。')).toBeVisible();
  expect(submittedBodies).toHaveLength(2);
  expect(submittedBodies[1]).toEqual(submittedBodies[0]);

  await page.getByRole('button', { name: '重新接受服务条款版本 1.1' }).click();
  const acceptDialog = page.getByRole('dialog');
  await acceptDialog.getByRole('checkbox').check();
  await acceptDialog.getByRole('button', { name: '确认接受' }).click();
  await expect(page.getByText('接受服务条款版本 1.1已记录。')).toBeVisible();
  await expect(page.getByText('已接受').first()).toBeVisible();
});

test('two Privacy tabs resolve a stale revision without automatic acceptance', async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto('/app/privacy');
  const stalePage = await context.newPage();
  await stalePage.goto('/app/privacy');
  await expect(stalePage.getByRole('heading', { name: '管理同意与了解数据边界' })).toBeVisible();

  await page.getByRole('button', { name: '撤回隐私政策版本 1.1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认撤回' }).click();
  await expect(page.getByText('撤回隐私政策版本 1.1已记录。')).toBeVisible();

  await stalePage.getByRole('button', { name: '撤回隐私政策版本 1.1' }).click();
  await stalePage.getByRole('dialog').getByRole('button', { name: '确认撤回' }).click();
  await expect(stalePage.getByText(/同意状态或政策文档已变化。已刷新最新状态/u)).toBeVisible();
  await expect(stalePage.getByRole('button', { name: '重新接受隐私政策版本 1.1' })).toBeVisible();

  await stalePage.getByRole('button', { name: '重新接受隐私政策版本 1.1' }).click();
  const acceptDialog = stalePage.getByRole('dialog');
  await acceptDialog.getByRole('checkbox').check();
  await acceptDialog.getByRole('button', { name: '确认接受' }).click();
  await expect(stalePage.getByText('接受隐私政策版本 1.1已记录。')).toBeVisible();
  await page.reload();
  await expect(page.getByText('已接受').first()).toBeVisible();
  await stalePage.close();
});

test('Mood/Profile supports the complete synthetic P0 lifecycle', async ({ page }) => {
  await login(page);
  await clearMoodHistory(page);
  await page.goto('/app/mood');
  await expect(page.getByRole('heading', { name: '心情记录' })).toBeVisible();
  await expect(page.getByText(/不是医疗诊断、持续监测或紧急响应渠道/u)).toBeVisible();

  await page.locator('.cat-mood-option[data-cat="sad"]').click();
  await page.getByLabel('想说的话').fill('第一条合成心情记录。');
  await page.getByRole('button', { name: '记下这份心情' }).click();
  await expect(page.getByText('第一条合成心情记录。')).toBeVisible();

  await page.locator('.cat-mood-option[data-cat="hopeful"]').click();
  await page.getByLabel('想说的话').fill('第二条合成心情记录。');
  await page.getByRole('button', { name: '记下这份心情' }).click();
  await expect(page.getByText('第二条合成心情记录。')).toBeVisible();
  if (process.env.UPDATE_MOOD_SCREENSHOTS === '1') {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${moodScreenshotDirectory}mood-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${moodScreenshotDirectory}mood-mobile.png` });
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  await page.getByRole('button', { name: '30 天' }).click();
  await expect(page.getByRole('list', { name: '30 天每日趋势' })).toBeVisible();
  await page.getByRole('button', { name: '30 天' }).click();
  await expect(page.getByText('第一条合成心情记录。')).toBeVisible();
  await page.getByRole('button', { name: '7 天' }).click();
  await expect(page.getByRole('list', { name: '7 天每日趋势' })).toBeVisible();
  await page.getByRole('button', { name: '7 天' }).click();
  await expect(page.getByText('第二条合成心情记录。')).toBeVisible();

  const firstEntry = page.getByText('第一条合成心情记录。').locator('..');
  await firstEntry.getByRole('button', { name: '编辑' }).click();
  const editForm = page.getByRole('heading', { name: '编辑记录' }).locator('..');
  await editForm.locator('.cat-mood-option[data-cat="happy"]').click();
  await editForm.getByLabel('想说的话').fill('第一条已编辑的合成记录。');
  await editForm.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByText('第一条已编辑的合成记录。')).toBeVisible();

  const secondEntry = page.getByText('第二条合成心情记录。').locator('..');
  await secondEntry.getByRole('button', { name: '删除' }).click();
  const singleDeleteDialog = page.getByRole('dialog', { name: '删除这条心情记录？' });
  await expect(singleDeleteDialog.getByRole('button', { name: '取消' })).toBeFocused();
  await singleDeleteDialog.getByRole('button', { name: '删除记录' }).click();
  await expect(page.getByText('第二条合成心情记录。')).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('第一条已编辑的合成记录。')).toBeVisible();
  await page.getByRole('button', { name: '清空记录' }).click();
  const deleteAllDialog = page.getByRole('dialog', { name: '删除全部心情记录？' });
  await expect(deleteAllDialog.getByText(/当前 7 天或 30 天窗口之外/u)).toBeVisible();
  await expect(deleteAllDialog.getByText(/独立 Audit 和备份/u)).toBeVisible();
  await deleteAllDialog.getByRole('button', { name: '删除全部' }).click();
  await expect(page.getByText('最近一次实际删除：1 条。')).toBeVisible();
  await expect(page.getByText('这段时间还没有心情记录。')).toBeVisible();

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开聊天记录' }).click();
  await page
    .getByRole('dialog', { name: '聊天记录' })
    .getByRole('link', { name: '个人资料' })
    .click();
  await expect(page).toHaveURL(/\/app\/profile$/u);
  await expect(page.getByText(EMAIL)).toBeVisible();
  await expect(page.getByText('成年资格已验证。此页面不展示验证方式或内部证据。')).toBeVisible();
  if (process.env.UPDATE_MOOD_SCREENSHOTS === '1') {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${moodScreenshotDirectory}profile-mobile.png` });
  }
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=/u);
  await expect(page.getByText('第一条已编辑的合成记录。')).toHaveCount(0);
});

test('Mood preserves read-only unknown-create recovery across a range change', async ({ page }) => {
  await login(page);
  await clearMoodHistory(page);
  await page.goto('/app/mood');
  await expect(page.getByRole('heading', { name: '心情记录' })).toBeVisible();

  let moodCreateCalls = 0;
  await page.route('**/mood-entries*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/mood-entries') {
      moodCreateCalls += 1;
      await route.abort('connectionfailed');
      return;
    }
    await route.continue();
  });

  await page.locator('.cat-mood-option[data-cat="relaxed"]').click();
  await page.getByLabel('想说的话').fill('结果未知的合成浏览器记录。');
  await page.getByRole('button', { name: '记下这份心情' }).click();
  await expect(page.getByText(/不会自动重新提交原创建请求/u)).toBeVisible();
  await expect(page.getByRole('button', { name: '核对创建结果' })).toBeVisible();

  await page.getByRole('button', { name: '30 天' }).click();
  await expect(page.getByRole('list', { name: '30 天每日趋势' })).toBeVisible();
  await expect(page.getByRole('button', { name: '核对创建结果' })).toBeVisible();
  await page.getByRole('button', { name: '核对创建结果' }).click();

  await expect(page.getByText(/不保证它以后不会提交/u)).toBeVisible();
  expect(moodCreateCalls).toBe(1);
  await expect(page.getByRole('button', { name: '记下这份心情' })).toBeDisabled();
});

test('Knowledge reader shows exact synthetic evidence and remains session-bound', async ({
  page,
  context,
}) => {
  await context.route('https://source.synthetic.test/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><h1>合成外部来源替身</h1></body></html>',
    });
  });
  await login(page);
  await page.goto('/app/knowledge');

  await expect(page.getByRole('heading', { name: '知识中心' })).toBeVisible();
  await expect(page.getByText('测试内容 · 未核验')).toBeVisible();
  await expect(page.getByText('版本 1')).toBeVisible();
  await expect(page.getByText('合成测试发布者')).toBeVisible();
  const articleLink = page.getByRole('link', { name: '合成测试：认识日常压力' });
  await articleLink.focus();
  await expect(articleLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/app\/knowledge\/synthetic-stress-basics$/u);
  await expect(page.getByText('这段合成正文只用于自动化测试。')).toBeVisible();
  await expect(page.getByText(/不是正式发布或审核通过/u)).toBeVisible();
  await expect(page.getByText('fixture-v1')).toBeVisible();
  await expect(page.getByText('合成章节 1')).toBeVisible();

  const external = page.getByRole('link', { name: '打开外部来源（离开本站）' });
  await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(external).toHaveAttribute('referrerpolicy', 'no-referrer');
  const externalPagePromise = context.waitForEvent('page');
  await external.click();
  const externalPage = await externalPagePromise;
  await expect(externalPage.getByRole('heading', { name: '合成外部来源替身' })).toBeVisible();
  await externalPage.close();

  if (process.env.UPDATE_KNOWLEDGE_SCREENSHOTS === '1') {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `${knowledgeScreenshotDirectory}knowledge-desktop.png`,
      fullPage: true,
    });
  }
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
  if (process.env.UPDATE_KNOWLEDGE_SCREENSHOTS === '1') {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `${knowledgeScreenshotDirectory}knowledge-mobile.png`,
      fullPage: true,
    });
  }

  await page.getByRole('link', { name: '← 返回知识中心' }).click();
  await expect(page.getByRole('heading', { name: '知识中心' })).toBeVisible();
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=/u);
  await expect(page.getByText('这段合成正文只用于自动化测试。')).toHaveCount(0);
});

test('Knowledge reader wraps valid long content at mobile and desktop widths', async ({ page }) => {
  const longHeading = 'H'.repeat(160);
  const longParagraph = 'https://synthetic.test/'.padEnd(2_000, 'p');
  const longListItem = 'L'.repeat(500);
  const longCallout = 'C'.repeat(2_000);
  await page.route('**/knowledge/articles/synthetic-long-content', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          article: {
            articleKey: 'synthetic-long-content',
            title: '合法长文本换行测试',
            summary: '仅用于真实浏览器布局测试。',
            version: 1,
            contentOrigin: 'synthetic_fixture',
            reviewStatus: 'unverified',
            reviewedAt: null,
            publishedAt: '2026-09-11T08:00:00.000Z',
            sourcePublishers: ['合成发布者'],
            contentBlocks: [
              { type: 'heading', level: 3, text: longHeading },
              { type: 'paragraph', text: longParagraph },
              { type: 'list', style: 'unordered', items: [longListItem] },
              { type: 'callout', tone: 'important', text: longCallout },
            ],
            sources: [
              {
                publisherName: '合成发布者',
                sourceTitle: 'S'.repeat(320),
                sourceUrl: `https://source.synthetic.test/${'u'.repeat(240)}`,
                sourcePublishedAt: null,
                sourceVersionLabel: 'V'.repeat(120),
                sourceLocator: 'P'.repeat(160),
                retrievedAt: '2026-09-03T10:00:00.000Z',
              },
            ],
          },
        },
      }),
    });
  });
  await login(page);
  await page.goto('/app/knowledge/synthetic-long-content');
  const heading = page.getByRole('heading', { level: 3, name: longHeading });
  await expect(heading).toBeVisible();
  const wrappingTargets = page.locator(
    '.knowledge-body h3, .knowledge-body > p, .knowledge-body li, .knowledge-callout p, .knowledge-source h3',
  );

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('.knowledge-article')
        .evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            element.getBoundingClientRect().right <= document.documentElement.clientWidth,
        ),
    ).toBe(true);
    expect(
      await wrappingTargets.evaluateAll((elements) =>
        elements.every(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            element.getBoundingClientRect().right <= document.documentElement.clientWidth,
        ),
      ),
    ).toBe(true);
    if (width === 320 && process.env.UPDATE_KNOWLEDGE_SCREENSHOTS === '1') {
      await page.screenshot({
        path: `${knowledgeScreenshotDirectory}knowledge-long-content-320.png`,
        fullPage: true,
      });
    }
  }
});
