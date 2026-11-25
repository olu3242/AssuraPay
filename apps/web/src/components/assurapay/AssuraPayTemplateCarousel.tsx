'use client';

import { useState, type KeyboardEvent } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  CheckCircle2,
  ShieldCheck,
  Clock,
  FileText,
  Lock,
  ChevronLeft,
  ChevronRight,
  Circle,
} from 'lucide-react';
import { templates, type Template, type MilestoneStatus } from './templates';

const statusLabels = {
  completed: 'Completed',
  in_progress: 'In progress',
  pending: 'Pending',
};
const nextStatus: Record<MilestoneStatus, MilestoneStatus> = {
  pending: 'in_progress',
  in_progress: 'completed',
  completed: 'pending',
};

export default function AssuraPayTemplateCarousel({
  onUseTemplate,
}: {
  onUseTemplate: (template: Template) => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [states, setStates] = useState<Record<string, MilestoneStatus[]>>({});
  const reducedMotion = useReducedMotion();
  const handleNext = () =>
    setCurrentIndex((prev) => (prev + 1) % templates.length);
  const handlePrev = () =>
    setCurrentIndex((prev) => (prev - 1 + templates.length) % templates.length);
  const currentTemplate = templates[currentIndex];
  const IconComponent = currentTemplate.icon;
  const statuses =
    states[currentTemplate.id] ||
    currentTemplate.sampleMilestones.map((m) => m.status);
  const completed = statuses.filter((status) => status === 'completed').length;

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      handleNext();
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      handlePrev();
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setCurrentIndex(0);
    }
    if (event.key === 'End') {
      event.preventDefault();
      setCurrentIndex(templates.length - 1);
    }
  }

  return (
    <section
      id="use-cases"
      className="ap-section ap-container"
      aria-labelledby="templates-title"
      aria-roledescription="carousel"
      onKeyDown={handleKeys}
    >
      <div className="ap-section-heading">
        <div>
          <span className="ap-eyebrow">A head start for every agreement</span>
          <h2 id="templates-title">Built for how you deliver work.</h2>
          <p>Different work. The same clarity on what done looks like.</p>
        </div>
        <div className="ap-carousel-controls">
          <button
            onClick={handlePrev}
            className="ap-icon-button"
            aria-label="Previous template"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            onClick={handleNext}
            className="ap-icon-button"
            aria-label="Next template"
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </div>
      <div className="ap-template-tabs" aria-label="Choose a template">
        {templates.map((template, index) => {
          const Icon = template.icon;
          return (
            <button
              key={template.id}
              onClick={() => setCurrentIndex(index)}
              aria-pressed={index === currentIndex}
            >
              <Icon size={17} />
              <span>
                {
                  [
                    'Services SOW',
                    'Construction',
                    'Software delivery',
                    'Cross-border',
                  ][index]
                }
              </span>
            </button>
          );
        })}
      </div>
      <div className="ap-carousel-shell">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={currentTemplate.id}
            initial={{ opacity: 0, x: reducedMotion ? 0 : 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reducedMotion ? 0 : -20 }}
            transition={{
              duration: reducedMotion ? 0 : 0.35,
              ease: [0.16, 1, 0.3, 1],
            }}
            className={`ap-template-slide bg-gradient-to-br ${currentTemplate.gradient}`}
            role="group"
            aria-roledescription="slide"
            aria-label={`${currentIndex + 1} of ${templates.length}: ${currentTemplate.title}`}
          >
            <div className="ap-template-top">
              <div className="flex items-center gap-3">
                <div className="ap-template-icon">
                  <IconComponent size={25} />
                </div>
                <div>
                  <h3>{currentTemplate.title}</h3>
                  <span
                    className={`ap-template-badge ${currentTemplate.accentColor}`}
                  >
                    {currentTemplate.badge}
                  </span>
                </div>
              </div>
              <span className="ap-small-tag">
                <ShieldCheck size={15} />
                {currentTemplate.complianceLevel}
              </span>
            </div>
            <div className="ap-template-grid">
              <div className="ap-template-description">
                <p>{currentTemplate.description}</p>
                <div className="ap-template-detail">
                  <FileText size={19} />
                  <div>
                    <span>Acceptance checkpoint</span>
                    <strong>{currentTemplate.payoutTrigger}</strong>
                  </div>
                </div>
                <div className="ap-template-detail">
                  <Lock size={19} />
                  <div>
                    <span>Funding structure</span>
                    <strong>{currentTemplate.escrowHolds}</strong>
                  </div>
                </div>
                <button
                  className="ap-button ap-button-primary"
                  onClick={() => onUseTemplate(currentTemplate)}
                >
                  Use this template
                </button>
              </div>
              <div className="ap-milestone-preview">
                <div className="ap-preview-heading">
                  <span>Live milestone preview</span>
                  <span className="ap-sample-label">Sample data</span>
                </div>
                <p className="ap-preview-hint">
                  Click a milestone to explore its next state.
                </p>
                <div className="ap-template-milestones">
                  {currentTemplate.sampleMilestones.map((milestone, index) => (
                    <button
                      key={milestone.title}
                      className="ap-template-milestone"
                      onClick={() =>
                        setStates((prev) => ({
                          ...prev,
                          [currentTemplate.id]: statuses.map((status, i) =>
                            i === index ? nextStatus[status] : status,
                          ),
                        }))
                      }
                      aria-label={`${milestone.title}: ${statusLabels[statuses[index]]}. Change to ${statusLabels[nextStatus[statuses[index]]]}`}
                    >
                      <span
                        className={`ap-status-icon ap-status-${statuses[index]}`}
                      >
                        {statuses[index] === 'completed' ? (
                          <CheckCircle2 size={21} />
                        ) : statuses[index] === 'in_progress' ? (
                          <Clock size={21} />
                        ) : (
                          <Circle size={21} />
                        )}
                      </span>
                      <span className="ap-milestone-name">
                        <strong>{milestone.title}</strong>
                        <small>{statusLabels[statuses[index]]}</small>
                      </span>
                      <span className="ap-milestone-amount">
                        {milestone.amount}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="ap-progress-label">
                  <span>{completed} of 3 milestones completed</span>
                  <strong>{Math.round((completed / 3) * 100)}%</strong>
                </div>
                <div
                  className="ap-progress-track"
                  role="progressbar"
                  aria-label="Sample milestone completion"
                  aria-valuenow={completed}
                  aria-valuemin={0}
                  aria-valuemax={3}
                >
                  <motion.div
                    animate={{ width: `${(completed / 3) * 100}%` }}
                    transition={{ duration: reducedMotion ? 0 : 0.4 }}
                  />
                </div>
                <p className="ap-preview-footnote">
                  <Lock size={12} />
                  Preview only. State changes never move funds.
                </p>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
        <div className="ap-carousel-footer">
          <div className="ap-carousel-dots">
            {templates.map((template, index) => (
              <button
                key={template.id}
                onClick={() => setCurrentIndex(index)}
                aria-label={`Go to slide ${index + 1}: ${template.title}`}
                aria-current={index === currentIndex ? 'true' : undefined}
              />
            ))}
          </div>
          <span aria-live="polite">
            0{currentIndex + 1}{' '}
            <span className="ap-muted">/ 0{templates.length}</span>
          </span>
        </div>
      </div>
    </section>
  );
}
