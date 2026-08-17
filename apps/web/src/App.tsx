import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./lib/auth.js";
import { Layout } from "./components/Layout.js";
import { Login } from "./pages/Login.js";
import { AccessRequested } from "./pages/AccessRequested.js";
import { Privacy } from "./pages/Privacy.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Calendar } from "./pages/Calendar.js";
import { Build } from "./pages/Build.js";
import { Settings } from "./pages/Settings.js";

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/access-requested" element={<AccessRequested />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/calendar" element={<Calendar />} />
                  <Route path="/build" element={<Build />} />
                  <Route path="/import" element={<Navigate to="/build" replace />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
              </Layout>
            </RequireAuth>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
