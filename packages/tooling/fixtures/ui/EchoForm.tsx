import { useState, type FormEvent } from 'react';
import styles from './EchoForm.module.css';

type Submission =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'confirmed'; message: string };

export function EchoForm() {
  const [draft, setDraft] = useState('');
  const [submission, setSubmission] = useState<Submission>({ status: 'idle' });
  const pending = submission.status === 'pending';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const message = draft.trim();
    if (!message) {
      setSubmission({ status: 'error', message: 'Enter a message before sending.' });
      return;
    }
    setSubmission({ status: 'pending' });
    try {
      const response = await fetch('/fixture-api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error('Fixture request failed');
      const result: unknown = await response.json();
      if (
        typeof result !== 'object' ||
        result === null ||
        !('message' in result) ||
        typeof result.message !== 'string'
      ) {
        throw new Error('Invalid fixture response');
      }
      setSubmission({ status: 'confirmed', message: result.message });
    } catch {
      setSubmission({
        status: 'error',
        message: 'Could not send. Your draft is preserved; try again.',
      });
    }
  }

  return (
    <main className={styles.fixture}>
      <h1>Tooling fixture</h1>
      <p>Development test page. Messages are echoed by a mock endpoint and are not saved.</p>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label htmlFor="message">Message</label>
        <input
          id="message"
          name="message"
          maxLength={200}
          value={draft}
          disabled={pending}
          aria-invalid={submission.status === 'error'}
          aria-describedby={submission.status === 'error' ? 'message-error' : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setSubmission({ status: 'idle' });
          }}
        />
        <button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send message'}
        </button>
        {submission.status === 'error' ? (
          <p id="message-error" role="alert">
            {submission.message}
          </p>
        ) : null}
        <p role="status">
          {submission.status === 'confirmed' ? `Confirmed: ${submission.message}` : ''}
        </p>
      </form>
    </main>
  );
}
