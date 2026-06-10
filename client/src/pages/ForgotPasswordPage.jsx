import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { api } from '../utils/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-app-bg p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-8">
        <div className="flex items-center justify-center gap-2 mb-6">
          <Zap size={24} className="text-accent" />
          <span className="font-bold text-xl tracking-tight">Stream</span>
        </div>

        {sent ? (
          <>
            <h1 className="text-lg font-semibold text-center text-gray-900">Check your email</h1>
            <p className="text-sm text-gray-500 text-center mt-2 mb-6">
              We've sent you a reset link. Follow it to choose a new password.
            </p>
            <Link
              to="/login"
              className="block w-full py-2.5 rounded-lg bg-accent text-white font-medium text-sm text-center hover:opacity-90 transition-opacity"
            >
              Back to login
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-center text-gray-900">Forgot your password?</h1>
            <p className="text-sm text-gray-500 text-center mb-6">
              Enter your email and we'll send you a reset link.
            </p>

            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 rounded-lg bg-accent text-white font-medium text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {submitting ? 'Sending…' : 'Send Reset Link'}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-gray-500">
              <Link to="/login" className="font-medium text-accent hover:opacity-80">
                Back to login
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
