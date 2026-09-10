import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

function Harness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开确认
      </button>
      <ConfirmDialog
        open={open}
        title="确认操作"
        confirmLabel="确认"
        onClose={() => setOpen(false)}
        onConfirm={onConfirm}
      >
        <p>合成确认内容</p>
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
});
