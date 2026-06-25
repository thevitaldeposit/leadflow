import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { api } from '../utils/api';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // No token in the URL → nothing to reset; send them to request a new link.
  if (!token) {
    return <Navigate to="/forgot-password" replace />;
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch {
      setError('This reset link is invalid or has expired.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-app-bg p-4">
      <div className="w-full max-w-sm bg-surface rounded-2xl shadow-sm p-8">
        <div className="flex items-center justify-center gap-2 mb-6">
          <Zap size={24} className="text-accent" />
          <span className="font-bold text-xl tracking-tight">Stream</span>
        </div>

        {done ? (
          <>
            <h1 className="text-lg font-semibold text-center text-content">
              Your password has been reset.
            </h1>
            <Link
              to="/login"
              className="mt-6 block w-full py-2.5 rounded-lg bg-accent text-content font-medium text-sm text-center hover:opacity-90 transition-opacity"
            >
              Go to login
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-center text-content">Choose a new password</h1>
            <p className="text-sm text-muted text-center mb-6">
              Enter a new password for your account.
            </p>

            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-content mb-1">New password</label>
                <input
                  type="password"
                  required
                  autoFocus
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-divider rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-content mb-1">
                  Confirm new password
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full px-3 py-2 border border-divider rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>

              {error && (
                <div className="text-sm text-danger">
                  {error}{' '}
                  <Link to="/forgot-password" className="font-medium underline hover:opacity-80">
                    Request a new link
                  </Link>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 rounded-lg bg-accent text-content font-medium text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {submitting ? 'Resetting…' : 'Reset Password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
