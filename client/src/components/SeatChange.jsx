import { useState } from 'react';
import Icon from './Icon.jsx';

/**
 * "Change seat" for the monitor drawers: gives a participant another seat
 * number, and so that seat's values (fixes a typo or a name clash with the
 * seat source). `onSave(seat)` calls the API; `what` names what switches over
 * ("Their exam and marking", "Their manual and checks").
 */
export default function SeatChange({ name, seatNumber, what, onSave, onError }) {
  const [draft, setDraft] = useState(null); // the number being typed, or null when closed

  async function save(e) {
    e.preventDefault();
    const seat = Number(draft);
    if (seat === seatNumber) {
      setDraft(null);
      return;
    }
    if (
      !window.confirm(
        `Move ${name} to seat ${seat}?\n\n${what} switch to seat ${seat}'s values at once. Answers already given are kept as they are.`,
      )
    )
      return;
    try {
      await onSave(seat);
      setDraft(null);
    } catch (err) {
      onError(err.message);
    }
  }

  if (draft === null) {
    return (
      <button
        className="btn btn--sm btn--ghost"
        onClick={() => setDraft(String(seatNumber))}
        title="Give them another seat number, and so that seat's values"
      >
        <Icon name="edit" size={14} /> Change seat
      </button>
    );
  }
  return (
    <form className="seat-change" onSubmit={save}>
      <label className="seat-change__label" htmlFor="seat-change-input">
        Seat
      </label>
      <input
        id="seat-change-input"
        className="field__input seat-change__input"
        type="number"
        min={1}
        max={999}
        step={1}
        required
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button className="btn btn--sm btn--primary">Save</button>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDraft(null)}>
        Cancel
      </button>
    </form>
  );
}
