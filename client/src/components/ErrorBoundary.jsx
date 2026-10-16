import { Component } from 'react';

/**
 * Last line of defence for rendering errors. Without it React unmounts the
 * whole tree and the participant is left with a blank page mid-lab or
 * mid-exam. Answers and progress live on the server, so reloading is always
 * safe — the screen says so.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept in the browser console for whoever is debugging on the device.
    console.error('vLabs render error', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="ended-screen">
        <div className="ended-card" role="alert">
          <h1>Something went wrong</h1>
          <p>
            This page hit an unexpected error. Your progress and answers are saved on the server —
            reloading picks up where you left off.
          </p>
          <div className="ended-actions">
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button className="btn btn--ghost" onClick={() => window.location.assign('/')}>
              Start page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
