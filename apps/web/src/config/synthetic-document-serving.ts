export function syntheticDocumentPublicDirectory(
  command: 'build' | 'serve',
  mode: string,
): string | false {
  return command === 'serve' && (mode === 'development' || mode === 'test')
    ? 'public.synthetic'
    : false;
}
