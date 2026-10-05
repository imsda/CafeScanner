import { useState } from "react";
import type { FormEvent } from "react";
import { ApiNetworkError, API_BASE } from "../api/client";
import { useAuth } from "../context/AuthContext";

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [devDiagnostics, setDevDiagnostics] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await login(username, password);
      setError("");
      setDevDiagnostics("");
    } catch (submitError) {
      if (import.meta.env.DEV && submitError instanceof Error) {
        // Helpful during local troubleshooting without leaking credentials/tokens.
        console.error("Login request failed", submitError);
      }

      if (submitError instanceof ApiNetworkError) {
        setError(
          `Login request failed.\nURL: ${submitError.requestUrl}\nError: ${submitError.name}\nMessage: ${submitError.message}`,
        );
        if (import.meta.env.DEV) {
          setDevDiagnostics(
            `Dev diagnostics — API_BASE: ${API_BASE}; origin: ${window.location.origin}; attempted endpoint: ${submitError.requestUrl}`,
          );
        }
        return;
      }

      setError(
        submitError instanceof Error
          ? submitError.message
          : "Unable to sign in",
      );
      if (import.meta.env.DEV) {
        setDevDiagnostics(
          `Dev diagnostics — API_BASE: ${API_BASE}; origin: ${window.location.origin}; attempted endpoint: ${API_BASE}/auth/login`,
        );
      }
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Cafeteria Scanner</h1>
        <p className="muted">IMSDA Meal Scanner</p>
        <form onSubmit={onSubmit} className="stack">
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              name="login-user"
              placeholder="Enter username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              name="login-pass"
            />
          </label>
          <button className="primary" type="submit">
            Sign in
          </button>
          {error && (
            <p className="error" style={{ whiteSpace: "pre-line" }}>
              {error}
            </p>
          )}
          {import.meta.env.DEV && devDiagnostics && (
            <p className="muted">{devDiagnostics}</p>
          )}
        </form>
      </div>
    </div>
  );
}
