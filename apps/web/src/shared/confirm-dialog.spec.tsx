import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

function Harness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开确认
      </button>
      <ConfirmDialog
        open={open}
        title="确认操作"
        confirmLabel="确认"
        busy={busy}
        confirmDisabled={!acknowledged}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          onConfirm();
          setBusy(true);
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          我已阅读
        </label>
      </ConfirmDialog>
    </>
  );
}

describe('ConfirmDialog', () => {
  it('traps focus, closes with Escape, and restores focus', async () => {
    render(<Harness onConfirm={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '打开确认' });
    trigger.focus();
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps focus stable across parent renders and contained while submitting', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: '打开确认' }));
    const checkbox = screen.getByRole('checkbox', { name: '我已阅读' });
    await userEvent.click(checkbox);
    expect(checkbox).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(checkbox).toHaveFocus();
    screen.getByRole('button', { name: '确认' }).focus();
    await userEvent.tab();
    expect(checkbox).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: '确认' }));
    const dialog = screen.getByRole('dialog', { name: '确认操作' });
    expect(dialog).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(dialog).toBeInTheDocument();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
