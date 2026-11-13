import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi } from '../test/mockApi';
import type { MockRoute } from '../test/mockApi';
import { ScanPage } from './ScanPage';

const person = (personId: string, firstName: string, count = 1) => ({
  id: 1, personId, firstName, lastName: 'Test', breakfastRemaining: 0, lunchRemaining: 0, dinnerRemaining: 0,
  breakfastCount: 0, lunchCount: count, dinnerCount: 0, totalMealsCount: count,
});

// A fake backend for the scan station. `onScan` decides the answer to POST /scan.
function setup(onScan: MockRoute, mealTrackingMode = 'tally') {
  const api = mockApi((request) => {
    if (request.url.endsWith('/scan/settings')) return { json: { scannerCooldownSeconds: 1, mealTrackingMode, scannerDiagnosticsEnabled: false } };
    if (request.url.endsWith('/scan/warnings/status')) return { json: { hasWarnings: false } };
    if (request.url.includes('/scan/people?q=')) {
      return { json: [
        { personId: '108910', name: 'Kim Kelly', personType: 'STAFF' },
        { personId: '1377289', name: 'Charles Zawadi', personType: 'STUDENT' },
      ] };
    }
    if (request.url.endsWith('/scan') && request.method === 'POST') return onScan(request);
    return undefined;
  });
  const scans = () => api.calls.filter((call) => call.url.endsWith('/scan') && call.method === 'POST');
  render(<ScanPage />);
  const box = screen.getByLabelText('Person ID input') as HTMLInputElement;
  return { box, scans, user: userEvent.setup() };
}

const success: MockRoute = ({ body }) => {
  const { personId, quantity } = body as { personId: string; quantity?: number };
  return { json: { ok: true, person: person(personId, `Person ${personId}`, quantity ?? 1), mealType: 'LUNCH', mealTrackingMode: 'tally', scannedValue: personId, quantity: quantity ?? 1 } };
};

describe('Scan station', () => {
  it('records a scan, empties the box and keeps it focused', async () => {
    const { box, scans, user } = setup(success);
    await user.type(box, '1377289{Enter}');
    expect(await screen.findByText('Meal Recorded')).toBeInTheDocument();
    expect(scans()).toHaveLength(1);
    expect(box.value).toBe('');
    await waitFor(() => expect(box).toHaveFocus());
  });

  it('ignores a double read of the same badge and never leaves it in the box', async () => {
    const { box, scans, user } = setup(success);
    await user.type(box, '1316574{Enter}1316574{Enter}');
    expect(await screen.findByText('Meal Recorded')).toBeInTheDocument();
    expect(scans()).toHaveLength(1);
    expect(box.value).toBe('');
    expect(screen.getByText('Duplicate scan of 1316574 ignored.')).toBeInTheDocument();

    // The next person can scan straight away; their ID is not glued onto leftovers.
    await user.type(box, '1245440{Enter}');
    await waitFor(() => expect(scans()).toHaveLength(2));
    expect((scans()[1].body as { personId: string }).personId).toBe('1245440');
  });

  it('queues a different badge scanned while the previous one is still saving', async () => {
    const { box, scans, user } = setup(success);
    await user.type(box, '111{Enter}222{Enter}');
    await waitFor(() => expect(scans()).toHaveLength(2));
    expect(scans().map((call) => (call.body as { personId: string }).personId)).toEqual(['111', '222']);
    expect(await screen.findByText('Person 222 Test')).toBeInTheDocument();
  });

  it('keeps the success card when the server reports a cooldown for the badge that just succeeded', async () => {
    let calls = 0;
    const { box, scans, user } = setup((request) => {
      calls += 1;
      return calls === 1
        ? success(request)
        : { status: 400, json: { ok: false, error: 'Please wait before scanning this ID again.', reason: 'COOLDOWN_ACTIVE' } };
    });
    await user.type(box, '900001{Enter}');
    expect(await screen.findByText('Meal Recorded')).toBeInTheDocument();
    // Just after the client-side delay the scanner reads the badge again.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await user.type(box, '900001{Enter}');
    await waitFor(() => expect(scans()).toHaveLength(2));
    expect(screen.getByText('Meal Recorded')).toBeInTheDocument();
    expect(screen.queryByText('Scan Failed')).not.toBeInTheDocument();
  });

  it('shows a real failure and allows the next scan', async () => {
    const { box, user } = setup(() => ({ status: 400, json: { ok: false, error: 'Invalid person ID.', reason: 'INVALID_PERSON_ID' } }));
    await user.type(box, 'nope{Enter}');
    expect(await screen.findByText('Scan Failed')).toBeInTheDocument();
    expect(screen.getByText('Invalid person ID.')).toBeInTheDocument();
    expect(box.value).toBe('');
  });

  it('scans a quantity from the name search, then returns the cursor to the scan box', async () => {
    const { box, scans, user } = setup(success);
    await user.type(screen.getByLabelText('Name or person ID'), 'k');
    await screen.findByText('Kim Kelly');
    await user.click(screen.getByRole('button', { name: 'One more meal' }));
    await user.click(screen.getByRole('button', { name: 'One more meal' }));

    // Students are always one meal, whatever the quantity says.
    const rows = screen.getAllByRole('listitem');
    expect(rows.find((row) => row.textContent?.includes('Charles Zawadi'))).toHaveTextContent(/Scan$/);

    await user.click(screen.getByRole('button', { name: 'Scan 3 meals' }));
    expect(await screen.findByText('3 Meals Recorded')).toBeInTheDocument();
    expect(scans()[0].body).toMatchObject({ personId: '108910', quantity: 3 });
    await waitFor(() => expect(box).toHaveFocus());
  });

  it('hides the quantity control in Camp Meeting mode', async () => {
    const { user } = setup(success, 'camp_meeting');
    await user.type(screen.getByLabelText('Name or person ID'), 'k');
    await screen.findByText('Kim Kelly');
    expect(screen.queryByRole('button', { name: 'One more meal' })).not.toBeInTheDocument();
  });
});
