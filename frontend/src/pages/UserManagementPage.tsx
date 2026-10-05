import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import type { AppPage } from "../context/AuthContext";
import { PAGE_LABELS } from "../lib/pages";

export function UserManagementPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"OWNER" | "ADMIN" | "SCANNER" | "CUSTOM">(
    "SCANNER",
  );
  const [allowedPages, setAllowedPages] = useState<AppPage[]>(["SCAN"]);
  const [editingUser, setEditingUser] = useState<any | null>(null);
  const [editRole, setEditRole] = useState<"OWNER" | "ADMIN" | "SCANNER" | "CUSTOM">("CUSTOM");
  const [editAllowedPages, setEditAllowedPages] = useState<AppPage[]>([]);
  const [userError, setUserError] = useState("");
  const [userMessage, setUserMessage] = useState("");

  const loadUsers = () => api<any[]>("/users").then(setUsers);
  useEffect(() => {
    void loadUsers();
  }, []);
  const togglePage = (page: AppPage) =>
    setAllowedPages((prev) =>
      prev.includes(page)
        ? prev.filter((entry) => entry !== page)
        : [...prev, page],
    );
  const roleAllowsCustomPermissions = role === "CUSTOM";
  const effectivePages =
    role === "ADMIN" || role === "OWNER"
      ? PAGE_LABELS.map((entry) => entry.key)
      : role === "SCANNER"
        ? ["SCAN"]
        : allowedPages;
  const pageLabelMap = new Map(
    PAGE_LABELS.map((entry) => [entry.key, entry.label]),
  );
  const formatPages = (pages: AppPage[]) =>
    pages.map((page) => pageLabelMap.get(page) || page).join(", ");
  const pagesForRole = (selectedRole: "OWNER" | "ADMIN" | "SCANNER" | "CUSTOM", pages: AppPage[]) =>
    selectedRole === "ADMIN" || selectedRole === "OWNER"
      ? PAGE_LABELS.map((entry) => entry.key)
      : selectedRole === "SCANNER"
        ? ["SCAN" as AppPage]
        : pages;

  function beginPermissionEdit(selectedUser: any) {
    setEditingUser(selectedUser);
    setEditRole(selectedUser.role);
    setEditAllowedPages((selectedUser.allowedPages || []) as AppPage[]);
    setUserError("");
    setUserMessage("");
  }

  async function saveUserPermissions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingUser) return;
    try {
      await api(`/users/${editingUser.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: editRole,
          allowedPages: pagesForRole(editRole, editAllowedPages),
        }),
      });
      setUserMessage(`Permissions updated for ${editingUser.username}. They will take effect the next time that user signs in.`);
      setUserError("");
      setEditingUser(null);
      await loadUsers();
    } catch (saveError) {
      setUserMessage("");
      setUserError(saveError instanceof Error ? saveError.message : "Unable to update user permissions");
    }
  }

  return (
    <div className="card stack">
      <h2>User Management</h2>
      {userError && <p className="error">{userError}</p>}
      {userMessage && <p className="success">{userMessage}</p>}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void api("/users", {
            method: "POST",
            body: JSON.stringify({
              username,
              password,
              role,
              allowedPages: effectivePages,
            }),
          }).then(() => {
            setUsername("");
            setPassword("");
            setRole("SCANNER");
            setAllowedPages(["SCAN"]);
            return loadUsers();
          });
        }}
      >
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          Password {role === "SCANNER" ? "(min 4)" : "(min 12)"}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Role
          <select
            value={role}
            onChange={(e) =>
              setRole(
                e.target.value as "OWNER" | "ADMIN" | "SCANNER" | "CUSTOM",
              )
            }
          >
            {user?.role === "OWNER" && <option value="OWNER">OWNER</option>}
            <option value="ADMIN">ADMIN</option>
            <option value="SCANNER">Scanner / Kiosk User (Limited access account)</option>
            <option value="CUSTOM">CUSTOM</option>
          </select>
        </label>
        {roleAllowsCustomPermissions && (
          <div>
            <p className="muted">Allowed tabs</p>
            <div className="permission-grid">
              {PAGE_LABELS.map((entry) => (
                <label key={entry.key} className="permission-option">
                  <input
                    type="checkbox"
                    checked={allowedPages.includes(entry.key)}
                    onChange={() => togglePage(entry.key)}
                  />
                  <span>{entry.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <button className="primary" type="submit">
          Add user
        </button>
      </form>
      {editingUser && (
        <form className="stack" onSubmit={saveUserPermissions}>
          <h3>Manage Permissions: {editingUser.username}</h3>
          <label>
            Role
            <select value={editRole} onChange={(event) => setEditRole(event.target.value as "OWNER" | "ADMIN" | "SCANNER" | "CUSTOM")}>
              {user?.role === "OWNER" && <option value="OWNER">OWNER</option>}
              <option value="ADMIN">ADMIN — all tabs</option>
              <option value="SCANNER">Scanner / Kiosk User — Scan Station only</option>
              <option value="CUSTOM">CUSTOM — choose tabs</option>
            </select>
          </label>
          {editRole === "CUSTOM" && (
            <div>
              <p className="muted">Allowed tabs</p>
              <div className="permission-grid">
                {PAGE_LABELS.map((entry) => (
                  <label key={entry.key} className="permission-option">
                    <input
                      type="checkbox"
                      checked={editAllowedPages.includes(entry.key)}
                      onChange={() => setEditAllowedPages((previous) => previous.includes(entry.key)
                        ? previous.filter((page) => page !== entry.key)
                        : [...previous, entry.key])}
                    />
                    <span>{entry.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <p className="muted">Effective access: {formatPages(pagesForRole(editRole, editAllowedPages)) || "No tabs selected"}</p>
          <div className="button-row">
            <button className="primary" type="submit">Save Permissions</button>
            <button className="secondary" type="button" onClick={() => setEditingUser(null)}>Cancel</button>
          </div>
        </form>
      )}
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Allowed Pages</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.role === "SCANNER" ? "Scanner / Kiosk User (Limited access account)" : u.role}</td>
              <td>{formatPages((u.allowedPages || []) as AppPage[])}</td>
              <td>
                <button
                  className="secondary"
                  type="button"
                  disabled={u.role === "OWNER" && user?.role !== "OWNER"}
                  onClick={() => beginPermissionEdit(u)}
                >
                  Manage Permissions
                </button>{" "}
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    const next = prompt(`New password for ${u.username}`);
                    if (next)
                      void api(`/users/${u.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ password: next }),
                      }).then(loadUsers);
                  }}
                >
                  Reset Password
                </button>{" "}
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    if (confirm(`Delete ${u.username}?`))
                      void api(`/users/${u.id}`, { method: "DELETE" }).then(
                        loadUsers,
                      );
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
