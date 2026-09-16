import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { fixtureServer } from '../../test-setup';
import { EchoForm } from './EchoForm';

describe('tooling fixture HTTP form', () => {
  it('rejects blank input and confirms the validated HTTP response', async () => {
    const user = userEvent.setup();
    fixtureServer.use(
      http.post('/fixture-api/echo', async ({ request }) => {
        expect(await request.json()).toEqual({ message: 'Hello tooling' });
        return HttpResponse.json({ message: 'Server confirmation' });
      }),
    );
    render(<EchoForm />);
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a message');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), '  Hello tooling  ');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Confirmed: Server confirmation'),
    );
    expect(screen.getByRole('textbox')).toHaveValue('  Hello tooling  ');
  });

  it.each(['http-error', 'invalid-response'] as const)(
    'preserves the draft after %s and permits retry',
    async (failure) => {
      const user = userEvent.setup();
      fixtureServer.use(
        http.post('/fixture-api/echo', () =>
          failure === 'http-error'
            ? new HttpResponse(null, { status: 503 })
            : HttpResponse.json({ message: 42 }),
        ),
      );
      render(<EchoForm />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keep this draft');
      await user.click(screen.getByRole('button', { name: 'Send message' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is preserved');
      expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      fixtureServer.use(
        http.post('/fixture-api/echo', () => HttpResponse.json({ message: 'Retry accepted' })),
      );
      await user.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Confirmed: Retry accepted'),
      );
    },
  );
});
