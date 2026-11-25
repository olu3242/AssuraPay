'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import {
  Menu,
  X,
  Sun,
  Moon,
  Check,
  ShieldCheck,
  FileText,
  BadgeCheck,
  Sparkles,
  Fingerprint,
  LockKeyhole,
  CheckCircle2,
  ChevronDown,
  UploadCloud,
  Building2,
  CircleCheck,
} from 'lucide-react';
import IntakeParser from './IntakeParser';
import AssuraPayTemplateCarousel from './AssuraPayTemplateCarousel';
import { templates, templateText, type Template } from './templates';

const demoLink =
  'mailto:hello@assurapay.com?subject=AssuraPay%20demo%20request';
const navigation = [
  ['How it works', '#how-it-works'],
  ['Use cases', '#use-cases'],
  ['Trust & security', '#trust'],
];

function Governance() {
  const [mode, setMode] = useState<'ai' | 'human'>('ai');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  function tabKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'ai'
        : event.key === 'End'
          ? 'human'
          : mode === 'ai'
            ? 'human'
            : 'ai';
    setMode(next);
    tabRefs.current[next === 'ai' ? 0 : 1]?.focus();
  }
  return (
    <section id="trust" className="ap-trust" aria-labelledby="trust-title">
      <div className="ap-container ap-trust-grid">
        <div className="ap-trust-copy">
          <span className="ap-eyebrow">Intelligence with boundaries</span>
          <h2 id="trust-title">
            AI helps prepare.
            <br />
            <span>People authorize.</span>
          </h2>
          <p>
            Move faster on the paperwork. Keep accountability where it
            belongs—with the people responsible for the agreement.
          </p>
          <div className="ap-trust-principles">
            <span>
              <ShieldCheck size={18} />
              Evidence before eligibility
            </span>
            <span>
              <Fingerprint size={18} />
              An accountable approval trail
            </span>
            <span>
              <Building2 size={18} />
              Funds stay with licensed providers
            </span>
          </div>
        </div>
        <div className="ap-governance-card">
          <div
            className="ap-governance-tabs"
            role="tablist"
            aria-label="Explore governance roles"
            onKeyDown={tabKeys}
          >
            {(['ai', 'human'] as const).map((value, index) => (
              <button
                key={value}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                id={`governance-${value}-tab`}
                role="tab"
                aria-controls="governance-panel"
                aria-selected={mode === value}
                tabIndex={mode === value ? 0 : -1}
                onClick={() => setMode(value)}
              >
                {value === 'ai' ? (
                  <Sparkles size={16} />
                ) : (
                  <Fingerprint size={16} />
                )}
                {value === 'ai' ? 'AI extraction' : 'Human authorization'}
              </button>
            ))}
          </div>
          <div
            id="governance-panel"
            role="tabpanel"
            aria-labelledby={`governance-${mode}-tab`}
            tabIndex={0}
            className="ap-governance-panel"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={mode}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              >
                <span className="ap-governance-icon">
                  {mode === 'ai' ? (
                    <Sparkles size={27} />
                  ) : (
                    <Fingerprint size={27} />
                  )}
                </span>
                <h3>
                  {mode === 'ai'
                    ? 'A draft, never a decision.'
                    : 'The final call is yours.'}
                </h3>
                <p>
                  {mode === 'ai'
                    ? 'Extraction can suggest parties, milestones, and acceptance conditions. Every suggestion needs human review.'
                    : 'Authorized people review evidence and approve eligible release instructions. The financial provider executes the payment.'}
                </p>
                <ul>
                  {(mode === 'ai'
                    ? [
                        'Identify terms and potential gaps',
                        'Suggest a structured milestone plan',
                        'Flag uncertainty for human review',
                      ]
                    : [
                        'Confirm evidence and acceptance',
                        'Approve under the agreement’s controls',
                        'Retain a traceable authorization record',
                      ]
                  ).map((item) => (
                    <li key={item}>
                      <CheckCircle2 size={16} />
                      {item}
                    </li>
                  ))}
                </ul>
                <div className="ap-governance-boundary">
                  <LockKeyhole size={15} />
                  {mode === 'ai'
                    ? 'AI has no authority to release funds.'
                    : 'Approval is required; funding and provider checks still apply.'}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <div className="ap-security-badges">
          <div>
            <ShieldCheck size={23} />
            <span>
              <strong>SOC 2 Type II</strong>
              <small>Verify reports with your financial provider</small>
            </span>
          </div>
          <div>
            <Building2 size={23} />
            <span>
              <strong>Bank escrow</strong>
              <small>Provider-held, where supported</small>
            </span>
          </div>
          <div>
            <LockKeyhole size={23} />
            <span>
              <strong>Non-custodial by design</strong>
              <small>AssuraPay never holds customer funds</small>
            </span>
          </div>
          <p>
            Provider capabilities and certifications vary. These are diligence
            checkpoints, not a claim that AssuraPay is SOC 2 certified.
          </p>
        </div>
      </div>
    </section>
  );
}

export default function AssuraPayLanding() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [scrolled, setScrolled] = useState(false);
  const [text, setText] = useState(templateText(templates[0]));
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('assurapay-landing-theme');
      setTheme(
        saved === 'dark' ||
          (!saved && matchMedia('(prefers-color-scheme: dark)').matches)
          ? 'dark'
          : 'light',
      );
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
    function scroll() {
      setScrolled(window.scrollY > 16);
    }
    scroll();
    window.addEventListener('scroll', scroll, { passive: true });
    return () => window.removeEventListener('scroll', scroll);
  }, []);
  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    try {
      localStorage.setItem('assurapay-landing-theme', next);
    } catch {
      /* Theme still works without persistence. */
    }
  }
  function useTemplate(template: Template) {
    setText(templateText(template));
    document.getElementById('product')?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'start',
    });
  }
  return (
    <MotionConfig reducedMotion="user">
      <div id="assurapay-landing" data-theme={theme} className="ap-landing">
        <a href="#main" className="ap-skip-link">
          Skip to content
        </a>
        <header
          className={`site ap-header ${scrolled ? 'ap-header-scrolled' : ''}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && menuOpen) {
              setMenuOpen(false);
              menuButton.current?.focus();
            }
          }}
        >
          <div className="ap-container ap-header-inner">
            <Link href="/" className="ap-brand" aria-label="AssuraPay home">
              <img
                className="brand-symbol"
                src="/images/assurapay-symbol.png"
                alt=""
                width="29"
                height="40"
              />
              <span>
                Assura<span>Pay</span>
              </span>
            </Link>
            <nav className="ap-desktop-nav" aria-label="Main navigation">
              {navigation.map(([label, href]) => (
                <a key={href} href={href}>
                  {label}
                </a>
              ))}
            </nav>
            <div className="ap-header-actions">
              <button
                className="ap-icon-button ap-theme-toggle"
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
              >
                {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
              </button>
              <Link className="ap-login" href="/start">
                Sign in
              </Link>
              <Link
                href="/start"
                className="ap-button ap-button-primary ap-header-cta"
              >
                Create an agreement
              </Link>
              <button
                ref={menuButton}
                className="ap-icon-button ap-menu-button"
                aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={menuOpen}
                aria-controls="ap-mobile-menu"
                onClick={() => setMenuOpen((value) => !value)}
              >
                {menuOpen ? <X size={21} /> : <Menu size={21} />}
              </button>
            </div>
          </div>
          {menuOpen && (
            <nav
              id="ap-mobile-menu"
              className="ap-mobile-nav"
              aria-label="Mobile navigation"
            >
              {navigation.map(([label, href]) => (
                <a key={href} href={href} onClick={() => setMenuOpen(false)}>
                  {label}
                </a>
              ))}
              <Link href="/start">Create an agreement</Link>
              <a href={demoLink}>Book a demo</a>
            </nav>
          )}
        </header>
        <main id="main" className="ap-main">
          <section className="ap-hero" aria-labelledby="hero-title">
            <div className="ap-container ap-hero-grid">
              <div className="ap-hero-copy">
                <span className="ap-hero-pill">
                  <ShieldCheck size={15} />
                  Clarity before commitment.
                </span>
                <h1 id="hero-title">
                  Clear agreements.
                  <br />
                  <span>
                    Confident
                    <br className="ap-desktop-break" /> payments.
                  </span>
                </h1>
                <p className="ap-hero-description">
                  Turn the work you agree on into outcomes you can verify. One
                  shared space for milestones, evidence, and payments that
                  follow the plan.
                </p>
                <div className="ap-hero-buttons">
                  <Link href="/start" className="ap-button ap-button-primary">
                    Create an agreement
                  </Link>
                  <a className="ap-button ap-button-secondary" href={demoLink}>
                    Book a demo
                  </a>
                </div>
                <p className="ap-hero-note">
                  <Check size={14} />
                  Start with an invoice, proposal, or contract.
                </p>
                <div className="ap-hero-proof">
                  <span className="ap-proof-icon">
                    <ShieldCheck size={21} />
                  </span>
                  <p>
                    <strong>Your agreement. Your approvals.</strong>
                    <br />
                    Your money stays with a licensed provider.
                  </p>
                </div>
              </div>
              <IntakeParser text={text} onTextChange={setText} />
            </div>
          </section>
          <div className="ap-principle-strip">
            <div className="ap-container">
              <span>
                <FileText size={18} />
                Agree on the outcome
              </span>
              <span>
                <BadgeCheck size={18} />
                Verify the work
              </span>
              <span>
                <LockKeyhole size={18} />
                Authorize the release
              </span>
              <span className="ap-strip-caption">
                An agreement is just the beginning.
              </span>
            </div>
          </div>
          <section
            id="how-it-works"
            className="ap-section ap-container"
            aria-labelledby="process-title"
          >
            <div className="ap-section-heading ap-process-heading">
              <div>
                <span className="ap-eyebrow">From agreement to assurance</span>
                <h2 id="process-title">
                  Less chasing.
                  <br />
                  More moving forward.
                </h2>
              </div>
              <p>
                Make expectations visible from day one.
                <br />
                Then let every milestone tell the story.
              </p>
            </div>
            <div className="ap-process-grid">
              <article className="ap-process-card">
                <span className="ap-step">
                  01 <span>Create / upload</span>
                </span>
                <div className="ap-process-art ap-process-art-upload">
                  <div className="ap-mini-document">
                    <FileText size={22} />
                    <i />
                    <i />
                    <i />
                  </div>
                  <span className="ap-art-icon">
                    <UploadCloud size={22} />
                  </span>
                  <span className="ap-art-chip">
                    <Sparkles size={12} />A structured draft
                  </span>
                </div>
                <h3>Start with what you have.</h3>
                <p>
                  Bring your invoice, proposal, or contract. Shape it into a
                  shared agreement everyone can review.
                </p>
              </article>
              <article className="ap-process-card">
                <span className="ap-step">
                  02 <span>Milestone agreement</span>
                </span>
                <div className="ap-process-art ap-process-art-plan">
                  <div className="ap-mini-check">
                    <Check size={13} />
                    <span>Scope agreed</span>
                  </div>
                  <div className="ap-mini-check">
                    <Check size={13} />
                    <span>Milestones defined</span>
                  </div>
                  <div className="ap-mini-check ap-mini-check-pending">
                    <CircleCheck size={13} />
                    <span>Acceptance criteria</span>
                  </div>
                </div>
                <h3>Define what done means.</h3>
                <p>
                  Align on deliverables, evidence, and acceptance conditions.
                  Give every payment a clear checkpoint.
                </p>
              </article>
              <article className="ap-process-card">
                <span className="ap-step">
                  03 <span>Verify & release</span>
                </span>
                <div className="ap-process-art ap-process-art-release">
                  <div className="ap-art-shield">
                    <ShieldCheck size={43} />
                  </div>
                  <span className="ap-art-chip">
                    <CheckCircle2 size={12} />
                    Approved with evidence
                  </span>
                </div>
                <h3>Let proof move things forward.</h3>
                <p>
                  Review the evidence. Record acceptance. Authorize an eligible
                  release for your financial provider to execute.
                </p>
              </article>
            </div>
          </section>
          <div className="ap-template-section">
            <AssuraPayTemplateCarousel onUseTemplate={useTemplate} />
          </div>
          <Governance />
          <section
            className="ap-section ap-container ap-faq"
            aria-labelledby="faq-title"
          >
            <div>
              <span className="ap-eyebrow">A few things, made clear</span>
              <h2 id="faq-title">
                Good questions.
                <br />
                Clear answers.
              </h2>
              <p>
                Know how the agreement, approval, and payment boundaries work.
              </p>
            </div>
            <div className="ap-faq-list">
              {[
                [
                  'Does AssuraPay hold my money?',
                  'No. AssuraPay structures agreements, records evidence and approvals, and prepares governed payment instructions. Funds stay with licensed financial providers. Availability depends on your provider and arrangement.',
                ],
                [
                  'Can AI approve a payment?',
                  'No. AI can help prepare a draft or identify terms for review. Authorized people must accept the work and authorize eligible payment instructions. The financial provider remains responsible for execution.',
                ],
                [
                  'What can I try on this page?',
                  'Upload a TXT, MD, CSV, or JSON text export, paste agreement text, or load a sample. The local parser recognizes labeled parties, USD amounts, and milestone lines. Carousel states are illustrative. Nothing is uploaded, saved as a real agreement, or paid.',
                ],
              ].map(([question, answer]) => (
                <details key={question}>
                  <summary>
                    {question}
                    <ChevronDown size={18} />
                  </summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </section>
          <section className="ap-final-cta">
            <div className="ap-container">
              <span className="ap-eyebrow">Move forward, on the same page</span>
              <h2>
                Great work deserves
                <br />a clear agreement.
              </h2>
              <p>Start with a shared plan. Finish with confidence.</p>
              <div className="ap-hero-buttons">
                <Link href="/start" className="ap-button ap-button-primary">
                  Create an agreement
                </Link>
                <a href={demoLink} className="ap-button ap-button-secondary">
                  Book a demo
                </a>
              </div>
            </div>
          </section>
        </main>
        <footer className="ap-footer ap-container">
          <div className="ap-footer-top">
            <div>
              <Link href="/" className="ap-brand" aria-label="AssuraPay home">
                <img
                  src="/images/assurapay-symbol.png"
                  alt=""
                  width="25"
                  height="34"
                />
                <span>
                  Assura<span>Pay</span>
                </span>
              </Link>
              <p>
                Clear agreements. Verified outcomes.
                <br />
                Confident payments.
              </p>
            </div>
            <nav aria-label="Footer product navigation">
              <strong>Explore</strong>
              <a href="#how-it-works">How it works</a>
              <a href="#use-cases">Use cases</a>
              <a href="#trust">Trust & security</a>
            </nav>
            <nav aria-label="Footer company navigation">
              <strong>Get in touch</strong>
              <a href={demoLink}>Book a demo</a>
              <a href="mailto:hello@assurapay.com">hello@assurapay.com</a>
              <Link href="/start">Open your workspace</Link>
            </nav>
          </div>
          <div className="ap-footer-bottom">
            <span>
              © {new Date().getFullYear()} AssuraPay. All rights reserved.
            </span>
            <div>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
            </div>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}
