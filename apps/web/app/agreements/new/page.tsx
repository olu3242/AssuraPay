'use client';
import { useMemo, useState } from 'react';
import './intake.css';
import { workspaceFetch } from '../../../lib/workspace-fetch';
type Path = 'DIRECT_DESCRIPTION' | 'INFORMAL_ARTIFACT' | 'FORMAL_DOCUMENT';
type Gap = {
  id: string;
  key: string;
  question: string;
  status: string;
  answer?: unknown;
};
type Intake = {
  id: string;
  status: string;
  clarityScore: number;
  clarifications: Gap[];
  proposedTerms?: Array<{ key: string; value: unknown }>;
  convertedAgreementId?: string;
  error?: string;
};
const choices: Array<{ type: Path; title: string; copy: string }> = [
  {
    type: 'DIRECT_DESCRIPTION',
    title: 'Create from scratch',
    copy: 'Tell us the deal in plain language. AssuraPay will structure the terms and show what is missing.',
  },
  {
    type: 'INFORMAL_ARTIFACT',
    title: 'Use what you already have',
    copy: 'Start from a quote, invoice, proposal, email or message trail.',
  },
  {
    type: 'FORMAL_DOCUMENT',
    title: 'Use contract text',
    copy: 'Paste an existing formal agreement for review before creating a draft.',
  },
];
async function jsonCall(url: string, init?: RequestInit) {
  const response = await workspaceFetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? 'Request failed');
  return body;
}
export default function NewAgreementPage() {
  const [path, setPath] = useState<Path>('DIRECT_DESCRIPTION'),
    [source, setSource] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Intake | null>(null),
    [answers, setAnswers] = useState<Record<string, string>>({});
  const selected = useMemo(() => choices.find((c) => c.type === path)!, [path]);
  async function act(work: () => Promise<any>) {
    setBusy(true);
    try {
      setResult(await work());
    } catch (error) {
      setResult((r) => ({
        ...r,
        id: r?.id ?? '',
        status: r?.status ?? 'ERROR',
        clarityScore: r?.clarityScore ?? 0,
        clarifications: r?.clarifications ?? [],
        error: error instanceof Error ? error.message : 'Request failed',
      }));
    } finally {
      setBusy(false);
    }
  }
  const structure = () =>
    act(() =>
      jsonCall('/api/v1/agreement-intakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceType: path,
          rawSource: source,
          sourceArtifactIds: [],
          proposedTerms: [],
        }),
      }),
    );
  const resolve = (gap: Gap) =>
    result &&
    act(() =>
      jsonCall(
        `/api/v1/agreement-intakes/${result.id}/clarifications/${gap.id}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer: answers[gap.id] }),
        },
      ),
    );
  const review = () =>
    result &&
    act(() =>
      jsonCall(`/api/v1/agreement-intakes/${result.id}/review`, {
        method: 'POST',
      }),
    );
  const convert = () =>
    result &&
    act(async () => {
      const converted = await jsonCall(
        `/api/v1/agreement-intakes/${result.id}/convert`,
        { method: 'POST' },
      );
      return {
        ...result,
        status: 'CONVERTED',
        convertedAgreementId: converted.id,
        error: undefined,
      };
    });
  return (
    <main>
      <section className="intake-shell">
        <span className="hero__eyebrow">Start an agreement</span>
        <h1>How would you like to begin?</h1>
        <p>
          Bring as much or as little as you have. Every path converges into one
          clear Assura Agreement before execution.
        </p>
        <div
          className="intake-paths"
          role="radiogroup"
          aria-label="Agreement starting point"
        >
          {choices.map((c) => (
            <button
              key={c.type}
              type="button"
              role="radio"
              aria-checked={path === c.type}
              className={`intake-path ${path === c.type ? 'intake-path--selected' : ''}`}
              onClick={() => setPath(c.type)}
            >
              <strong>{c.title}</strong>
              <span>{c.copy}</span>
            </button>
          ))}
        </div>
        <div className="intake-editor">
          <h2>{selected.title}</h2>
          <label htmlFor="agreement-source">
            Describe or paste what has been agreed
          </label>
          <textarea
            id="agreement-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Example: ABC Roofing will replace my roof for $18,000 by October 17..."
            rows={8}
          />
          <p className="intake-note">
            Entered terms require your review. Nothing becomes an agreement
            until you resolve missing terms and explicitly confirm the review.
          </p>
          <button
            className="button button--primary"
            disabled={busy || !source.trim()}
            onClick={structure}
          >
            {busy ? 'Working…' : 'Structure agreement'}
          </button>
        </div>
        {result && (
          <section className="intake-review" aria-live="polite">
            <h2>
              {result.status === 'CONVERTED'
                ? 'Draft agreement created'
                : 'Agreement review'}
            </h2>
            {result.error && (
              <div role="alert">
                <p>{result.error}</p>
                <a href="/start">Sign in or select a workspace</a>
              </div>
            )}
            {result.proposedTerms?.length ? (
              <dl aria-label="Agreement terms">
                {result.proposedTerms.map((term) => (
                  <div key={term.key}>
                    <dt>{term.key}</dt>
                    <dd>
                      {typeof term.value === 'string'
                        ? term.value
                        : JSON.stringify(term.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p>
              <strong>Readiness: {result.clarityScore}%</strong> ·{' '}
              {result.status}
            </p>
            {result.clarifications
              ?.filter((g) => g.status === 'OPEN')
              .map((g) => (
                <div className="intake-gap" key={g.id}>
                  <div>
                    <strong>{g.key}</strong>
                    <span>{g.question}</span>
                  </div>
                  <div>
                    <input
                      aria-label={g.question}
                      value={answers[g.id] ?? ''}
                      onChange={(e) =>
                        setAnswers((a) => ({ ...a, [g.id]: e.target.value }))
                      }
                    />
                    <button
                      disabled={busy || !(answers[g.id] ?? '').trim()}
                      onClick={() => resolve(g)}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ))}
            {result.status === 'READY_FOR_REVIEW' && (
              <button
                className="button button--primary"
                disabled={busy}
                onClick={review}
              >
                I reviewed these terms
              </button>
            )}
            {result.status === 'REVIEWED' && (
              <button
                className="button button--primary"
                disabled={busy}
                onClick={convert}
              >
                Create draft agreement
              </button>
            )}
            {result.convertedAgreementId && (
              <p>
                Canonical agreement:{' '}
                <strong>{result.convertedAgreementId}</strong>.{' '}
                <a href="/contracts">Open agreement workspace</a>
              </p>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
