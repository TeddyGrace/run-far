import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth, useAuth } from "./lib/auth.js";
import { Layout } from "./components/Layout.js";
import { Login } from "./pages/Login.js";
import { AccessRequested } from "./pages/AccessRequested.js";
import { Privacy } from "./pages/Privacy.js";
import { Home } from "./pages/Home.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Calendar } from "./pages/Calendar.js";
import { Build } from "./pages/Build.js";
import { Settings } from "./pages/Settings.js";

// "/" has to be reachable without signing in — Google's OAuth branding review requires the
// app's home page to describe the app to a signed-out visitor. Signed-in athletes still get
// the dashboard there, so the landing page is only what anonymous visitors (and crawlers) see.
function HomeRoute() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-ink-muted">Loading…</div>;
  }
  if (!user) {
    return <Home />;
  }
  return (
    <Layout>
      <Dashboard />
    </Layout>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/login" element={<Login />} />
        <Route path="/access-requested" element={<AccessRequested />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout>
                <Routes>
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
