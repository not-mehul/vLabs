import { useState } from 'react';
import Markdown from './Markdown.jsx';
import HintBox from './HintBox.jsx';
import Checkpoint from './Checkpoint.jsx';
import Icon from './Icon.jsx';

// Real-world lab activity types: physical bench work vs. work on the machine.
const TYPE_META = {
  desk: { label: 'Hands-On', icon: 'desk' },
  computer: { label: 'Workstation', icon: 'computer' },
};

/**
 * Structured content card. The activity type (Hands-On vs Workstation) is shown
 * subtly via a small tinted icon tile + label. Renders collapsible hints (whose
 * opens are recorded) and an optional checkpoint that can reveal its solution
 * once every hint on the step has been taken.
 */
export default function StepCard({ step, total, sectionIndex, onCheckpoint, onHintOpen, onRevealSolution }) {
  const meta = TYPE_META[step.type] || TYPE_META.desk;
  const hints = step.hints || [];

  // Track hints opened locally, unioned with the server's "taken" flags, so the
  // reveal-solution affordance appears the instant the last hint is opened.
  const [openedLocal, setOpenedLocal] = useState(() => new Set());
  const takenCount = hints.filter((h, i) => h.taken || openedLocal.has(i)).length;
  const allHintsTaken = hints.length > 0 && takenCount === hints.length;

  return (
    <article className={`card card--${step.type}`} id={`step-${step.index}`}>
      <header className="card__head">
        <span className={`card__kind card__kind--${step.type}`}>
          <span className="card__kind-tile"><Icon name={meta.icon} size={15} /></span>
          {meta.label}
        </span>
        <span className="card__count">
          {step.index + 1}
          {total ? ` / ${total}` : ''}
        </span>
      </header>

      <h2 className="card__title">{step.title}</h2>

      <div className="card__body">
        <Markdown>{step.body}</Markdown>
      </div>

      {hints.length > 0 && (
        <div className="card__hints">
          {hints.map((h, i) => (
            <HintBox
              key={i}
              label={h.label}
              text={h.text}
              taken={h.taken || openedLocal.has(i)}
              onOpen={() => {
                setOpenedLocal((prev) => new Set(prev).add(i));
                if (onHintOpen) onHintOpen(sectionIndex, step.index, i);
              }}
            />
          ))}
        </div>
      )}

      {step.checkpoint && (
        <Checkpoint
          prompt={step.checkpoint.prompt}
          placeholder={step.checkpoint.placeholder}
          completed={step.checkpoint.completed}
          solution={step.checkpoint.solution}
          solutionAvailable={allHintsTaken && !step.checkpoint.completed}
          onReveal={() => onRevealSolution(sectionIndex, step.index)}
          onSubmit={(answer) => onCheckpoint(sectionIndex, step.index, answer)}
        />
      )}
    </article>
  );
}
