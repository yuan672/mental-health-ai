// Mirrors apps/api/src/auth/auth.schemas.ts. The API schema is server-only;
// keep the Web boundary aligned without importing backend code into the bundle.
export function registrationPasswordError(password: string): string | null {
  if (password.length < 12 || password.length > 128) return '密码长度须为 12–128 个字符。';
  const classes = [/[a-z]/u, /[A-Z]/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u];
  return classes.filter((pattern) => pattern.test(password)).length >= 3
    ? null
    : '请在小写英文字母、大写英文字母、数字、符号中使用至少三类字符。';
}
