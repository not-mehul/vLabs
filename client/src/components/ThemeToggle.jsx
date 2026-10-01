import { useTheme } from '../context/ThemeContext.jsx';
import Icon from './Icon.jsx';

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
      <Icon name={dark ? 'sun' : 'moon'} size={18} />
    </button>
  );
}
