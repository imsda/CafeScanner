import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AdminOnly, PermissionOnly } from "./components/RouteGuards";
import { homePathFor } from "./lib/pages";
import { useAuth } from "./context/AuthContext";
import { Login } from "./pages/LoginPage";

const Dashboard = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.Dashboard })));
const ScanPage = lazy(() => import("./pages/ScanPage").then((m) => ({ default: m.ScanPage })));
const ScannerPreferencesPage = lazy(() => import("./pages/ScannerPreferencesPage").then((m) => ({ default: m.ScannerPreferencesPage })));
const PeoplePage = lazy(() => import("./pages/PeoplePage").then((m) => ({ default: m.PeoplePage })));
const ImportPage = lazy(() => import("./pages/ImportPage").then((m) => ({ default: m.ImportPage })));
const BadgesPage = lazy(() => import("./pages/BadgesPage").then((m) => ({ default: m.BadgesPage })));
const TransactionsPage = lazy(() => import("./pages/TransactionsPage").then((m) => ({ default: m.TransactionsPage })));
const ReportsPage = lazy(() => import("./pages/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const HomeLeavesPage = lazy(() => import("./pages/HomeLeavesPage").then((m) => ({ default: m.HomeLeavesPage })));
const UserManagementPage = lazy(() => import("./pages/UserManagementPage").then((m) => ({ default: m.UserManagementPage })));

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <p className="muted">Loading…</p>;
  if (!user) return <Login />;
  const homePath = homePathFor(user.allowedPages);
  const home = homePath
    ? <Navigate to={homePath} replace />
    : <div className="card"><h2>No pages assigned</h2><p>Your account has no pages yet. Ask an administrator to grant access.</p></div>;

  return (
    <Layout>
      <Suspense fallback={<p className="muted">Loading…</p>}>
      <Routes>
        <Route path="/" element={home} />
        <Route
          path="/scan"
          element={
            <PermissionOnly page="SCAN">
              <ScanPage />
            </PermissionOnly>
          }
        />
        <Route path="/scanner-settings" element={<PermissionOnly page="SCAN"><ScannerPreferencesPage /></PermissionOnly>} />
        <Route
          path="/dashboard"
          element={
            <PermissionOnly page="DASHBOARD">
              <Dashboard />
            </PermissionOnly>
          }
        />
        <Route
          path="/people"
          element={
            <PermissionOnly page="PEOPLE">
              <PeoplePage />
            </PermissionOnly>
          }
        />
        <Route
          path="/import"
          element={
            <PermissionOnly page="IMPORT">
              <ImportPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/badges"
          element={
            <PermissionOnly page="BADGES">
              <BadgesPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/transactions"
          element={
            <PermissionOnly page="TRANSACTIONS">
              <TransactionsPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/reports"
          element={
            <PermissionOnly page="REPORTS">
              <ReportsPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/settings"
          element={
            <PermissionOnly page="SETTINGS">
              <SettingsPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/home-leaves"
          element={
            <PermissionOnly page="HOME_LEAVES">
              <HomeLeavesPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/users"
          element={
            <AdminOnly>
              <PermissionOnly page="USER_MANAGEMENT">
                <UserManagementPage />
              </PermissionOnly>
            </AdminOnly>
          }
        />
        {/* Unknown URLs go to the user's first permitted page instead of an empty layout. */}
        <Route path="*" element={home} />
      </Routes>
      </Suspense>
    </Layout>
  );
}
