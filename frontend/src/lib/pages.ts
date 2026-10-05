import type { AppPage } from "../context/AuthContext";

export const PAGE_LABELS: Array<{ key: AppPage; path: string; label: string }> = [
  { key: "DASHBOARD", path: "dashboard", label: "Dashboard" },
  { key: "SCAN", path: "scan", label: "Scan Station" },
  { key: "PEOPLE", path: "people", label: "People" },
  { key: "IMPORT", path: "import", label: "Import" },
  { key: "BADGES", path: "badges", label: "Badges" },
  { key: "TRANSACTIONS", path: "transactions", label: "Transactions" },
  { key: "REPORTS", path: "reports", label: "Reports" },
  { key: "HOME_LEAVES", path: "home-leaves", label: "Home Leaves" },
  { key: "SETTINGS", path: "settings", label: "Settings" },
  { key: "USER_MANAGEMENT", path: "users", label: "User Management" },
];
