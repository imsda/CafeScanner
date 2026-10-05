import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import type { AppPage } from "../context/AuthContext";
import { homePathFor } from "../lib/pages";

export function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== "ADMIN" && user?.role !== "OWNER")
    return <Navigate to={homePathFor(user?.allowedPages) ?? "/"} replace />;
  return <>{children}</>;
}

export function PermissionOnly({
  page,
  children,
}: {
  page: AppPage;
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  if (!user?.allowedPages?.includes(page))
    return (
      <div className="card">
        <h2>Not authorized</h2>
        <p>You do not have access to this page.</p>
      </div>
    );
  return <>{children}</>;
}
