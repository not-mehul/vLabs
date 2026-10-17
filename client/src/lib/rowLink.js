/**
 * Props that make a whole table row open `to` on click, Enter or Space. Put
 * `stopRowClick` on a cell holding its own buttons so they don't open it too.
 */
export function rowLink(navigate, to) {
  return {
    tabIndex: 0,
    onClick: () => navigate(to),
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigate(to);
      }
    },
  };
}

export const stopRowClick = {
  onClick: (e) => e.stopPropagation(),
  onKeyDown: (e) => e.stopPropagation(),
};
