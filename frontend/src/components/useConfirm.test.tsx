import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useConfirm } from './useConfirm';

function Harness({ withInput = false }: { withInput?: boolean }) {
  const { confirm, dialog } = useConfirm();
  const [result, setResult] = useState('pending');
  return (
    <div>
      <button type="button" onClick={() => void confirm({
        title: 'Reset password for kiosk',
        confirmLabel: 'Reset Password',
        ...(withInput ? { input: { label: 'New password', type: 'password' as const, minLength: 8 } } : { message: 'Are you sure?', danger: true }),
      }).then((value) => setResult(value === null ? 'cancelled' : `confirmed:${value}`))}>
        Open
      </button>
      <p data-testid="result">{result}</p>
      {dialog}
    </div>
  );
}

describe('useConfirm', () => {
  it('opens a labelled dialog and resolves when confirmed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog', { name: 'Reset password for kiosk' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset Password' }));
    expect(screen.getByTestId('result')).toHaveTextContent('confirmed:');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resolves null on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('result')).toHaveTextContent('cancelled');
    expect(opener).toHaveFocus();
  });

  it('asks for a value in a password field and enforces the minimum length', async () => {
    const user = userEvent.setup();
    render(<Harness withInput />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const input = screen.getByLabelText('New password');
    expect(input).toHaveAttribute('type', 'password');
    const confirmButton = screen.getByRole('button', { name: 'Reset Password' });
    await user.type(input, 'short');
    expect(confirmButton).toBeDisabled();
    await user.type(input, 'er-now-ok');
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);
    expect(screen.getByTestId('result')).toHaveTextContent('confirmed:shorter-now-ok');
  });
});
