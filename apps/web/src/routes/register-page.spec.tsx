import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { RegisterPage } from './register-page';
import { registrationPasswordError } from './registration-password';

const mocks = vi.hoisted(() => ({ getRegistrationRequirements: vi.fn(), register: vi.fn() }));
vi.mock('../api/auth', () => mocks);
afterEach(() => vi.resetAllMocks());

async function fillForm(password: string) {
  mocks.getRegistrationRequirements.mockResolvedValue({
    success: true,
    data: {
      registrationEnabled: true,
      minimumAge: 18,
      requiredConsents: [
        {
          type: 'privacy_policy',
          version: '1.1',
          displayKey: 'consent.privacyPolicy',
          documentKey: 'synthetic.privacy-policy',
          documentRevision: 'test-revision-2',
          documentUrl: '/consent-documents/test.html',
        },
      ],
    },
  });
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<RegisterPage />} />
        <Route path="/login" element={<p>登录入口</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await userEvent.type(await screen.findByLabelText('邮箱'), 'synthetic@example.test');
  await userEvent.type(screen.getByLabelText('密码'), password);
  await userEvent.type(screen.getByLabelText('年龄验证凭证'), 'mock-adult');
  await userEvent.click(screen.getByRole('checkbox'));
}

it('identifies password class failure, focuses the field, preserves input, and accepts a corrected password', async () => {
  await fillForm('aaaaaaaaaaaa');
  await userEvent.click(screen.getByRole('button', { name: '注册' }));
  const password = screen.getByLabelText('密码');
  expect(password).toHaveFocus();
  expect(password).toHaveAttribute('aria-invalid', 'true');
  expect(password).toHaveAttribute('aria-describedby', 'password-help password-error');
  expect(screen.getByRole('alert')).toHaveTextContent('至少三类字符');
  expect(screen.getByLabelText('邮箱')).toHaveValue('synthetic@example.test');
  expect(screen.getByLabelText('年龄验证凭证')).toHaveValue('mock-adult');
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(mocks.register).not.toHaveBeenCalled();
  await userEvent.clear(password);
  await userEvent.type(password, 'Synthetic-Test-9!');
  mocks.register.mockResolvedValue({ success: true });
  await userEvent.click(screen.getByRole('button', { name: '注册' }));
  expect(await screen.findByText('登录入口')).toBeInTheDocument();
  expect(mocks.register).toHaveBeenCalledTimes(1);
}, 15_000);

it('does not attribute a server failure to a valid password or display sensitive error details', async () => {
  await fillForm('Synthetic-Test-9!');
  mocks.register.mockRejectedValue(new Error('synthetic account exists / internal detail'));
  await userEvent.click(screen.getByRole('button', { name: '注册' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法完成注册');
  expect(screen.getByLabelText('密码')).not.toHaveAttribute('aria-invalid');
  expect(screen.getByLabelText('邮箱')).toHaveValue('synthetic@example.test');
  expect(screen.queryByText(/internal detail/u)).not.toBeInTheDocument();
}, 15_000);

it.each([
  ['Aa1!', false],
  ['a'.repeat(129), false],
  ['abcdefghij１２', false],
  ['abcdefghij１!', true],
  ['abcdefghij中１', false],
  ['ABCDEFGHIJ１!', true],
  ['aA1' + ' '.repeat(9), true],
  ['aA1' + 'x'.repeat(125), true],
])('matches API length and Unicode character classes for %s', (password, valid) => {
  expect(registrationPasswordError(password) === null).toBe(valid);
});
