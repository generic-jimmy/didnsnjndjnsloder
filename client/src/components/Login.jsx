import React, { useState, useEffect, useRef } from 'react';
import api from '../api';

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [attemptsLeft, setAttemptsLeft] = useState(null);
  const [lockedUntil, setLockedUntil] = useState(null); // ms timestamp
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const lockTimer = useRef(null);

  // Tick the countdown while locked
  useEffect(() => {
    if (!lockedUntil) return undefined;
    lockTimer.current = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(lockTimer.current);
  }, [lockedUntil]);

  const locked = lockedUntil && lockedUntil > now;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (locked) return;
    setLoading(true);
    setError('');
    setAttemptsLeft(null);
    try {
      const res = await api.post('/auth/login', { username, password });
      onLogin(res.data.token);
    } catch (err) {
      const data = err?.response?.data || {};
      if (data.locked_until) {
        setLockedUntil(new Date(data.locked_until).getTime());
        setNow(Date.now());
        setError(data.error || 'Account locked — too many failed attempts');
      } else {
        setError(data.error || 'Invalid credentials');
        setAttemptsLeft(typeof data.attempts_remaining === 'number' ? data.attempts_remaining : null);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">◈</span>
          <h1>Badman</h1>
          <p>Authorized Access Only</p>
        </div>
        <form onSubmit={handleSubmit}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            type="text"
            placeholder="Operator ID"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            disabled={!!locked}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={!!locked}
          />
          {locked && (
            <div className="lockout" role="alert">
              ⛔ Account locked — retry in <b>{formatCountdown(lockedUntil - now)}</b>
            </div>
          )}
          {!locked && error && (
            <div className="error">
              {error}
              {attemptsLeft !== null && attemptsLeft > 0 && (
                <span className="attempts-left"> · {attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left before lockout</span>
              )}
            </div>
          )}
          <button type="submit" disabled={loading || !!locked}>
            {locked ? 'Locked' : loading ? 'Authenticating…' : 'Authenticate →'}
          </button>
        </form>
        <div className="login-foot">Restricted · Operator Console</div>
      </div>
    </div>
  );
}

export default Login;
