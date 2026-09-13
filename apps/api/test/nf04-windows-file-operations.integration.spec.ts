import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertNf04PathOwnedByRoot } from '../src/nf04/nf04-guards';
import {
  WindowsNf04ArchivePublicationAdapter,
  WindowsNf04StableFileCleanupAdapter,
} from '../src/nf04/nf04-windows-file-operations';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    const exactRoot = resolve(temporaryRoot);
    const expectedParent = resolve(tmpdir());
    if (dirname(exactRoot).toLowerCase() !== expectedParent.toLowerCase()) {
      throw new Error('Refusing to clean an unexpected NF-04 Windows test directory');
    }
    await rm(exactRoot, { recursive: true, force: true });
  }
});

describe('NF-04 Windows stable-handle filesystem adapters', () => {
  windowsIt(
    'publishes the captured partial with a handle-relative no-clobber rename',
    async () => {
      const root = await taskRoot();
      const partialPath = join(root, '.pre-delete.dump.partial');
      const finalPath = join(root, 'pre-delete.dump');
      await writeFile(partialPath, 'synthetic archive bytes');
      const partial = await assertNf04PathOwnedByRoot(root, partialPath, 'file');

      await new WindowsNf04ArchivePublicationAdapter(15_000).publish({
        artifactRoot: root,
        partialPath,
        finalPath,
        rootIdentity: partial.rootIdentity,
        parentIdentity: partial.parentIdentity,
        partialIdentity: partial.targetIdentity!,
        signal: new AbortController().signal,
      });

      await expect(access(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(finalPath, 'utf8')).resolves.toBe('synthetic archive bytes');
      const published = await assertNf04PathOwnedByRoot(root, finalPath, 'file');
      expect(published.targetIdentity).toEqual(partial.targetIdentity);
    },
    30_000,
  );

  windowsIt(
    'refuses to clobber an existing final archive and retains both files',
    async () => {
      const root = await taskRoot();
      const partialPath = join(root, '.pre-delete.dump.partial');
      const finalPath = join(root, 'pre-delete.dump');
      await Promise.all([
        writeFile(partialPath, 'new synthetic archive'),
        writeFile(finalPath, 'existing synthetic archive'),
      ]);
      const partial = await assertNf04PathOwnedByRoot(root, partialPath, 'file');

      await expect(
        new WindowsNf04ArchivePublicationAdapter(15_000).publish({
          artifactRoot: root,
          partialPath,
          finalPath,
          rootIdentity: partial.rootIdentity,
          parentIdentity: partial.parentIdentity,
          partialIdentity: partial.targetIdentity!,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/refused to overwrite/i);

      await expect(readFile(partialPath, 'utf8')).resolves.toBe('new synthetic archive');
      await expect(readFile(finalPath, 'utf8')).resolves.toBe('existing synthetic archive');
    },
    30_000,
  );

  windowsIt(
    'rejects a replaced artifact root without publishing into the replacement',
    async () => {
      const root = await taskRoot();
      const movedRoot = `${root}-captured`;
      temporaryRoots.push(movedRoot);
      const partialPath = join(root, '.pre-delete.dump.partial');
      const finalPath = join(root, 'pre-delete.dump');
      await writeFile(partialPath, 'captured synthetic archive');
      const partial = await assertNf04PathOwnedByRoot(root, partialPath, 'file');
      await rename(root, movedRoot);
      await mkdir(root);
      await writeFile(partialPath, 'replacement synthetic archive');

      await expect(
        new WindowsNf04ArchivePublicationAdapter(15_000).publish({
          artifactRoot: root,
          partialPath,
          finalPath,
          rootIdentity: partial.rootIdentity,
          parentIdentity: partial.parentIdentity,
          partialIdentity: partial.targetIdentity!,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/boundary/i);

      await expect(readFile(partialPath, 'utf8')).resolves.toBe('replacement synthetic archive');
      await expect(readFile(join(movedRoot, '.pre-delete.dump.partial'), 'utf8')).resolves.toBe(
        'captured synthetic archive',
      );
      await expect(access(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    30_000,
  );

  windowsIt(
    'rejects a junction replacement without changing its target directory',
    async () => {
      const root = await taskRoot();
      const movedRoot = `${root}-captured`;
      const junctionTarget = `${root}-junction-target`;
      temporaryRoots.push(movedRoot, junctionTarget);
      const partialPath = join(root, '.pre-delete.dump.partial');
      const finalPath = join(root, 'pre-delete.dump');
      await writeFile(partialPath, 'captured synthetic archive');
      const partial = await assertNf04PathOwnedByRoot(root, partialPath, 'file');
      await rename(root, movedRoot);
      await mkdir(junctionTarget);
      await writeFile(join(junctionTarget, '.pre-delete.dump.partial'), 'junction target bytes');
      await symlink(junctionTarget, root, 'junction');

      await expect(
        new WindowsNf04ArchivePublicationAdapter(15_000).publish({
          artifactRoot: root,
          partialPath,
          finalPath,
          rootIdentity: partial.rootIdentity,
          parentIdentity: partial.parentIdentity,
          partialIdentity: partial.targetIdentity!,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/boundary/i);

      await expect(
        readFile(join(junctionTarget, '.pre-delete.dump.partial'), 'utf8'),
      ).resolves.toBe('junction target bytes');
      await expect(access(join(junctionTarget, 'pre-delete.dump'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    30_000,
  );

  windowsIt(
    'deletes only the exact captured file through its stable handle',
    async () => {
      const root = await taskRoot();
      const targetPath = join(root, 'source.pgpass');
      await writeFile(targetPath, 'synthetic secret');
      const target = await assertNf04PathOwnedByRoot(root, targetPath, 'file');

      await new WindowsNf04StableFileCleanupAdapter(15_000).delete({
        artifactRoot: root,
        targetPath,
        rootIdentity: target.rootIdentity,
        parentIdentity: target.parentIdentity,
        targetIdentity: target.targetIdentity!,
        signal: new AbortController().signal,
      });

      await expect(access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    30_000,
  );

  windowsIt(
    'does not delete a same-path replacement when the captured file moved',
    async () => {
      const root = await taskRoot();
      const targetPath = join(root, 'source.pgpass');
      const capturedPath = join(root, 'captured-source.pgpass');
      await writeFile(targetPath, 'captured synthetic secret');
      const target = await assertNf04PathOwnedByRoot(root, targetPath, 'file');
      await rename(targetPath, capturedPath);
      await writeFile(targetPath, 'replacement synthetic secret');

      await expect(
        new WindowsNf04StableFileCleanupAdapter(15_000).delete({
          artifactRoot: root,
          targetPath,
          rootIdentity: target.rootIdentity,
          parentIdentity: target.parentIdentity,
          targetIdentity: target.targetIdentity!,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/boundary/i);

      await expect(readFile(targetPath, 'utf8')).resolves.toBe('replacement synthetic secret');
      await expect(readFile(capturedPath, 'utf8')).resolves.toBe('captured synthetic secret');
    },
    30_000,
  );
});

async function taskRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mh-nf04-windows-file-ops-'));
  temporaryRoots.push(root);
  return root;
}
