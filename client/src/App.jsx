import React, { useState, useEffect, Component } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';

// Last-resort error boundary: a render crash in any view shows a compact
// recovery panel instead of blanking the entire app (React unmounts the
// whole tree on an uncaught render error).
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('UI crash:', error, info?.componentStack || '');
  }
  render() {
    if (!this.state.error) return this.props.children;
    const msg = String(this.state.error?.message || this.state.error || 'Unknown error');
    return (
      <div className="crash-screen">
        <h2>Something went wrong</h2>
        <p>{msg}</p>
        <div>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
          <button onClick={() => window.location.reload()}>Reload console</button>
        </div>
      </div>
    );
  }
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));

  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
  }, [token]);

  // Any API 401/403 (expired/invalid token) forces a clean logout to the login screen
  useEffect(() => {
    const onAuthExpired = () => setToken(null);
    window.addEventListener('auth-expired', onAuthExpired);
    return () => window.removeEventListener('auth-expired', onAuthExpired);
  }, []);

  const handleLogout = () => {
    setToken(null);
  };

  if (!token) {
    return (
      <ErrorBoundary>
        <Login onLogin={setToken} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary key={token}>
      <Dashboard token={token} onLogout={handleLogout} />
    </ErrorBoundary>
  );
}

export default App;
