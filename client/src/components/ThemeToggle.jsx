import { useTheme } from '../context/ThemeContext.jsx';

/** Small light/dark switch used across the app chrome. */
export default function ThemeToggle({ className = '' }) {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`}
      onClick={toggle}
      aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
      title={`Switch to ${dark ? 'light' : 'dark'} mode`}
    >
      <span aria-hidden="true">{dark ? '☀' : '☾'}</span>
    </button>
  );
}
