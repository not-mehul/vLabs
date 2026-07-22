import Markdown from './Markdown.jsx';
import HintBox from './HintBox.jsx';
import Checkpoint from './Checkpoint.jsx';
import Icon from './Icon.jsx';

const TYPE_META = {
  desk: { label: 'Desk', icon: 'desk' },
  computer: { label: 'Computer', icon: 'computer' },
};

/**
 * Structured content card. Desk vs Computer actions are visually distinct via
 * the `card--<type>` modifier. Renders collapsible hints and an optional state
 * checkpoint. `sectionIndex` scopes checkpoint submissions to their section.
 */
export default function StepCard({ step, total, sectionIndex, onCheckpoint }) {
  const meta = TYPE_META[step.type] || TYPE_META.desk;
  return (
    <article className={`card card--${step.type}`} id={`step-${step.index}`}>
      <header className="card__head">
        <span className="card__kind">
          <Icon name={meta.icon} size={15} /> {meta.label}
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

      {step.hints && step.hints.length > 0 && (
        <div className="card__hints">
          {step.hints.map((h, i) => (
            <HintBox key={i} label={h.label} text={h.text} />
          ))}
        </div>
      )}

      {step.checkpoint && (
        <Checkpoint
          prompt={step.checkpoint.prompt}
          placeholder={step.checkpoint.placeholder}
          completed={step.checkpoint.completed}
          onSubmit={(answer) => onCheckpoint(sectionIndex, step.index, answer)}
        />
      )}
    </article>
  );
}
