'use client';

import {
  useRef,
  useState,
  useMemo,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  UploadCloud,
  FileText,
  Check,
  LockKeyhole,
  Sparkles,
  Circle,
  CheckCircle2,
  PencilLine,
} from 'lucide-react';
import { parseAgreementText, templates, templateText } from './templates';

export default function IntakeParser({
  text,
  onTextChange,
}: {
  text: string;
  onTextChange: (text: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState('Sample services agreement');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const reducedMotion = useReducedMotion();
  const draft = useMemo(() => parseAgreementText(text), [text]);

  async function readFile(file?: File) {
    if (!file) return;
    setError('');
    if (!/\.(txt|md|csv|json)$/i.test(file.name)) {
      setError(
        'Please use a TXT, MD, CSV, or JSON text export. PDF and DOCX files are not supported in this local preview.',
      );
      return;
    }
    if (file.size > 1_000_000) {
      setError('Choose a text file smaller than 1 MB.');
      return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      if (!content.trim() || content.includes('\u0000')) {
        setError(
          'This file has no readable text. Try pasting the agreement text instead.',
        );
        return;
      }
      onTextChange(content.slice(0, 20000));
      setSource(file.name);
      setEditing(true);
    } catch {
      setError('The file could not be read. Try again or paste its text.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void readFile(event.dataTransfer.files[0]);
  }

  return (
    <div
      id="product"
      className="ap-intake"
      aria-label="Interactive agreement intake"
    >
      <div
        className={`ap-upload-panel ${dragging ? 'ap-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            setDragging(false);
        }}
        onDrop={drop}
      >
        <input
          ref={input}
          type="file"
          accept=".txt,.md,.csv,.json"
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            void readFile(event.target.files?.[0])
          }
          className="ap-visually-hidden"
          aria-label="Upload an agreement text file"
          tabIndex={-1}
        />
        <button
          className="ap-upload-target"
          onClick={() => input.current?.click()}
          disabled={busy}
          aria-label="Choose a contract or invoice text file"
        >
          <span className="ap-upload-icon">
            <UploadCloud size={23} />
          </span>
          <span>
            <strong>
              {busy ? 'Reading your document…' : 'Drop your agreement here'}
            </strong>
            <small>
              or choose a text file · TXT, MD, CSV, JSON · up to 1 MB
            </small>
          </span>
        </button>
        <div className="ap-intake-options">
          <button
            onClick={() => {
              setEditing((value) => !value);
              setError('');
            }}
            aria-expanded={editing}
            aria-controls="intake-editor"
          >
            <PencilLine size={13} />
            {editing ? 'Close editor' : 'Paste text'}
          </button>
          <button
            onClick={() => {
              onTextChange(templateText(templates[0]));
              setSource('Sample services agreement');
              setError('');
            }}
          >
            <Sparkles size={13} />
            Try a sample
          </button>
        </div>
        {error && (
          <p className="ap-file-error" role="alert">
            {error}
          </p>
        )}
        {editing && (
          <div id="intake-editor" className="ap-text-editor">
            <label htmlFor="agreement-text">
              Agreement text <span>Preview updates as you type</span>
            </label>
            <textarea
              id="agreement-text"
              value={text}
              maxLength={20000}
              rows={6}
              onChange={(event) => {
                onTextChange(event.target.value);
                setSource('Pasted agreement');
              }}
              placeholder={
                'Website redesign\nBuyer: Northstar\nSeller: Meridian\nMilestone 1: Discovery | $4,500'
              }
            />
            <small>
              Use Buyer:, Seller:, Total: and Milestone 1: Title | $amount. USD
              values only. Fields without a clear match need review.
            </small>
          </div>
        )}
      </div>
      <div className="ap-intake-connector">
        <span />
        <Sparkles size={12} />
        <span>From document to shared clarity</span>
        <span />
      </div>
      <motion.div
        className="ap-room"
        initial={{ opacity: 0, y: reducedMotion ? 0 : 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="ap-room-toolbar">
          <span>
            <span className="ap-room-mark">
              <FileText size={16} />
            </span>
            Agreement Room
          </span>
          <span className="ap-sample-label">
            {source.startsWith('Sample') ? 'Sample data' : 'Local preview'}
          </span>
        </div>
        <div className="ap-room-body">
          <div className="ap-room-title-row">
            <div>
              <span className="ap-kicker">DRAFT AGREEMENT</span>
              <h2 aria-live="polite">{draft.title}</h2>
            </div>
            <span className="ap-draft-pill">
              <Circle size={7} fill="currentColor" />
              Needs review
            </span>
          </div>
          <div className="ap-room-parties">
            <div>
              <span>Buyer</span>
              <strong>{draft.buyer}</strong>
            </div>
            <div className="ap-party-divider" />
            <div>
              <span>Delivery partner</span>
              <strong>{draft.seller}</strong>
            </div>
          </div>
          <div className="ap-room-value">
            <span>
              Agreement value<strong>{draft.total}</strong>
            </span>
            <span className="ap-room-value-note">
              <LockKeyhole size={14} />
              Funding not connected
            </span>
          </div>
          <div className="ap-room-milestone-heading">
            <strong>Milestone plan</strong>
            <span>{draft.milestones.length} checkpoints</span>
          </div>
          <div className="ap-room-milestones" aria-live="polite">
            {draft.milestones.length ? (
              draft.milestones.map((milestone, index) => (
                <div key={index} className="ap-room-milestone">
                  <span className="ap-milestone-number">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span>
                    <strong>{milestone.title}</strong>
                    <small>Acceptance criteria need review</small>
                  </span>
                  <b>{milestone.amount}</b>
                </div>
              ))
            ) : (
              <p className="ap-empty-milestones">
                Add a line such as “Milestone 1: Discovery | $4,500” to build
                your plan.
              </p>
            )}
          </div>
          <div className="ap-room-review">
            <CheckCircle2 size={16} />
            <span>
              Structured for review. <strong>You stay in control.</strong>
            </span>
            <Check size={15} />
          </div>
        </div>
        <div className="ap-room-footer">
          <LockKeyhole size={12} />
          <span>
            Files stay in this browser. No upload, AI call, or payment.
          </span>
        </div>
      </motion.div>
      <div className="ap-intake-caption">
        <span className="ap-caption-line" />
        <span>One shared record. Every condition visible.</span>
        <span className="ap-caption-line" />
      </div>
    </div>
  );
}
